import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { errorResponseSchema } from '../src/errors';
import { TERMS_EXEMPT_ROUTES } from '../src/modules/accounts/guard';
import { CURRENT_LEGAL_VERSIONS } from '../src/modules/accounts/legal';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const SOME_ID = 'a0000000-0000-4000-8000-0000000000a1';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  method: (typeof METHODS)[number];
  /** OpenAPI path with the `/api/v1` prefix, e.g. /api/v1/plans/{planId}/tasks. */
  path: string;
}

/** The URL of an operation with every path parameter filled in (the guard runs before validation). */
const concrete = (path: string) =>
  path.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name === 'date' ? '2026-11-01' : name === 'id' || name.endsWith('Id') ? SOME_ID : 'x',
  );

/** Converts '/api/v1/plans/:planId' style patterns to the OpenAPI '{planId}' style. */
const exemptKey = (op: Operation) =>
  `${op.method.toUpperCase()} ${op.path.replace(/\{(\w+)\}/g, ':$1')}`;

describe.skipIf(!dbAvailable)('terms and privacy must be accepted (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let signedIn: Operation[];

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    const base = testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 });
    // Flag-gated routes are switched on, so the route table below includes the plan builder.
    app = buildApp(
      { ...base, features: { ...base.features, planBuilder: true } },
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
      },
    );
    await app.ready();
    // Every operation the API documents as needing a bearer token, from the real route table, so
    // a route added to any module later is covered without touching this test.
    const doc = app.swagger() as {
      paths: Record<string, Partial<Record<string, { security?: object[] }>>>;
    };
    signedIn = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.filter((method) => item[method]?.security?.length).map((method) => ({
        method,
        path,
      })),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(`insert into rnd.allowed_emails (email) values ('a@example.com')`);
      await c.query(`insert into rnd.app_users (id, email) values ($1, 'a@example.com')`, [A]);
    });
  });

  const headers = async () => ({
    authorization: `Bearer ${await keys.sign({ sub: A, email: 'a@example.com' })}`,
  });
  const send = async (op: Operation) =>
    app.inject({
      method: op.method.toUpperCase() as 'GET',
      url: concrete(op.path),
      headers: await headers(),
      ...(op.method === 'get' ? {} : { payload: {} }),
    });

  // Functions, because the route table exists only after the app is built in beforeAll.
  const blocked = () => signedIn.filter((op) => !TERMS_EXEMPT_ROUTES.has(exemptKey(op)));
  const exempt = () => signedIn.filter((op) => TERMS_EXEMPT_ROUTES.has(exemptKey(op)));

  it('finds the documented routes of every module', () => {
    const paths = signedIn.map(exemptKey);
    expect(paths).toEqual(
      expect.arrayContaining([
        'GET /api/v1/me',
        'GET /api/v1/plans',
        'POST /api/v1/plans/import',
        'GET /api/v1/plans/:planId/tasks',
        'GET /api/v1/plans/:id/schedule',
        'GET /api/v1/plans/:id/open-tasks',
        'POST /api/v1/plans/:planId/days/:date/start',
        'POST /api/v1/plans/:planId/days/:date/end',
        'GET /api/v1/plans/:planId/days/:date',
        'GET /api/v1/plans/:planId/days/:date/briefing',
        'PUT /api/v1/plans/:planId/days/:date/review',
        'GET /api/v1/plans/:planId/days/:date/review',
        'GET /api/v1/plans/:planId/reviews',
        'GET /api/v1/plans/:planId/suggestions',
        'POST /api/v1/plans/:planId/suggestions/:id/preview',
        'POST /api/v1/plans/:planId/suggestions/:id/accept',
        'POST /api/v1/plans/:planId/suggestions/:id/reject',
      ]),
    );
    expect(signedIn.length).toBeGreaterThanOrEqual(15);
  });

  it('keeps the allowlist to routes that exist, so a rename cannot leave a stale entry', () => {
    const known = new Set(signedIn.map(exemptKey));
    for (const key of TERMS_EXEMPT_ROUTES) expect(known.has(key), key).toBe(true);
  });

  it('answers 403 terms_not_accepted on every other signed-in route until accepted', async () => {
    const operations = blocked();
    expect(operations.length).toBeGreaterThanOrEqual(10);
    for (const op of operations) {
      const res = await send(op);
      expect(res.statusCode, exemptKey(op)).toBe(403);
      const body = errorResponseSchema.parse(res.json());
      expect(body.error.code, exemptKey(op)).toBe('terms_not_accepted');
      expect(body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('blocks each review and suggestion route by name until accepted', async () => {
    const names = [
      'PUT /api/v1/plans/:planId/days/:date/review',
      'GET /api/v1/plans/:planId/days/:date/review',
      'GET /api/v1/plans/:planId/reviews',
      'GET /api/v1/plans/:planId/suggestions',
      'POST /api/v1/plans/:planId/suggestions/:id/preview',
      'POST /api/v1/plans/:planId/suggestions/:id/accept',
      'POST /api/v1/plans/:planId/suggestions/:id/reject',
    ];
    const byName = new Map(blocked().map((op) => [exemptKey(op), op]));
    for (const name of names) {
      const op = byName.get(name);
      expect(op, name).toBeDefined();
      const res = await send(op!);
      expect(res.statusCode, name).toBe(403);
      expect(res.json().error.code, name).toBe('terms_not_accepted');
    }
  });

  it('still lets the account routes through that the Terms screen needs', async () => {
    const operations = exempt();
    expect(operations.map(exemptKey).sort()).toEqual([...TERMS_EXEMPT_ROUTES].sort());
    for (const op of operations) {
      const res = await send(op);
      // 200 for reading, 400/422 for the ones that need a valid body; never the terms error.
      expect(res.json()?.error?.code, exemptKey(op)).not.toBe('terms_not_accepted');
      expect(res.statusCode, exemptKey(op)).not.toBe(403);
    }
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: await headers() });
    expect(me.json().legal.allAccepted).toBe(false);
  });

  it('can accept through the API and then reach the data routes', async () => {
    for (const document of ['terms', 'privacy'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/legal-acceptances',
        headers: await headers(),
        payload: { document, version: CURRENT_LEGAL_VERSIONS[document] },
      });
      expect(res.statusCode).toBe(200);
    }
    const plans = await app.inject({
      method: 'GET',
      url: '/api/v1/plans',
      headers: await headers(),
    });
    expect(plans.statusCode).toBe(200);
  });

  it('is not satisfied by only one document', async () => {
    await testDb.admin((c) =>
      c.query(
        `insert into rnd.legal_acceptances (user_id, document, version) values ($1, 'terms', $2)`,
        [A, CURRENT_LEGAL_VERSIONS.terms],
      ),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/plans', headers: await headers() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('terms_not_accepted');
  });

  it('is not satisfied by an older version, so a new version asks everyone again', async () => {
    await testDb.admin(async (c) => {
      await c.query(
        `insert into rnd.legal_acceptances (user_id, document, version)
         values ($1, 'terms', '0.0'), ($1, 'privacy', '0.0')`,
        [A],
      );
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/plans', headers: await headers() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('terms_not_accepted');
  });

  it('lets a user who accepted everything use the data routes', async () => {
    await testDb.admin((c) => acceptCurrentLegal(c, [A]));
    const res = await app.inject({ method: 'GET', url: '/api/v1/plans', headers: await headers() });
    expect(res.statusCode).toBe(200);
  });
});
