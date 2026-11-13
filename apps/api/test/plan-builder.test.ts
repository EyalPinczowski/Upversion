import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BuildDraftSchema, type BuildCatalog } from '@upversion/shared';
import { BUNDLED_CATALOG } from '@upversion/shared/plan-builder';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import {
  acceptCurrentLegal,
  dbAvailable,
  prepareDatabase,
  TEST_SUPERUSER_URL,
  type TestDb,
} from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NEW_1 = id(1);
const NEW_2 = id(2);
const OLD = id(10);
const OLD_2 = id(11);
const GHOST = id(99);
const START_CLOCK = '2026-11-01T10:00:00Z';

const demo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../data/sample-plans/demo-plan.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

const REQUEST = {
  targetRoleIds: ['data-analyst'],
  startDate: '2026-11-03',
  deadline: '2026-12-15',
  weekPattern: {
    studyWeekdays: [0, 1, 2, 3, 4],
    defaultHours: 3,
    windowStart: '09:00',
    windowEnd: '17:30',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    timezone: 'Asia/Jerusalem',
  },
  budget: { mode: 'flexible' },
  certPreference: 'none',
  interviewPrep: 'no',
};

/** The catalog after a "deploy": every title changed, so every draft differs from before. */
const CHANGED_CATALOG: BuildCatalog = {
  ...BUNDLED_CATALOG,
  items: BUNDLED_CATALOG.items.map((i) => ({ ...i, title: `${i.title} (v2)` })),
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

describe.skipIf(!dbAvailable)('plan builder, archive and restore (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let appOff: ReturnType<typeof buildApp>;
  let appChanged: ReturnType<typeof buildApp>;
  let clock = new Date(START_CLOCK);

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    const base = testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 });
    const deps = {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
      now: () => clock,
    };
    const on = { ...base, features: { ...base.features, planBuilder: true } };
    app = buildApp(on, deps);
    appChanged = buildApp(on, { ...deps, planBuilderCatalog: CHANGED_CATALOG });
    appOff = buildApp(base, deps);
    await Promise.all([app.ready(), appChanged.ready(), appOff.ready()]);
  });

  afterAll(async () => {
    await Promise.all([app?.close(), appChanged?.close(), appOff?.close()]);
    await db?.close();
  });

  beforeEach(async () => {
    clock = new Date(START_CLOCK);
    await testDb.admin(async (c) => {
      await c.query('drop trigger if exists fail_task_insert on rnd.tasks');
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com'), ('c@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com'), ($3, 'c@example.com')`,
        [A, B, C],
      );
      // C never accepts the terms.
      await acceptCurrentLegal(c, [A, B]);
    });
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const asA = () => as(A, 'a@example.com');
  const asB = () => as(B, 'b@example.com');
  const asC = () => as(C, 'c@example.com');

  const call = (
    target: ReturnType<typeof buildApp>,
    method: Method,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) =>
    target.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const callA = async (method: Method, url: string, payload?: unknown) =>
    call(app, method, url, await asA(), payload);
  const callB = async (method: Method, url: string, payload?: unknown) =>
    call(app, method, url, await asB(), payload);

  const rows = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(query, params)).rows as T[]);
  const count = async (query: string, params: unknown[] = []) =>
    Number((await rows<{ n: string }>(query, params))[0]!.n);

  /** Row counts of every table of the schema: for "nothing was written". */
  const tableCounts = () =>
    testDb.admin(async (c) => {
      const { rows: tables } = await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'rnd' and table_type = 'BASE TABLE' order by 1`,
      );
      const out: Record<string, number> = {};
      for (const { table_name } of tables) {
        out[table_name] = Number(
          (await c.query(`select count(*) as n from rnd.${table_name}`)).rows[0].n,
        );
      }
      return out;
    });

  const importDemo = (planId: string, status?: 'draft' | 'active') =>
    callA('POST', '/plans/import', { ...demo, id: planId, ...(status ? { status } : {}) });
  const preview = async (request: object = REQUEST) => {
    const res = await callA('POST', '/plans/build/preview', request);
    expect(res.statusCode).toBe(200);
    return res.json() as { draftHash: string; plan: { name: string } };
  };
  const bodyFor = async (planId: string, replaces: string[], request: object = REQUEST) => ({
    id: planId,
    request,
    draftHash: (await preview(request)).draftHash,
    replacesPlanIds: replaces,
  });
  const statusOf = async (planId: string) =>
    (await rows<{ status: string }>('select status from rnd.plans where id = $1', [planId]))[0]
      ?.status;

  describe('flag, auth and body', () => {
    it('answers 404 for all three routes while the flag is off', async () => {
      const headers = await asA();
      for (const [method, url, body] of [
        ['POST', '/plans/build/preview', REQUEST],
        [
          'POST',
          '/plans/build',
          { id: NEW_1, request: REQUEST, draftHash: 'ab', replacesPlanIds: [] },
        ],
        ['POST', `/plans/${OLD}/restore`, { replacesPlanIds: [] }],
      ] as const) {
        const res = await call(appOff, method, url, headers, body);
        expect(res.statusCode, url).toBe(404);
      }
    });

    it('needs a token and accepted terms', async () => {
      for (const [url, body] of [
        ['/plans/build/preview', REQUEST],
        ['/plans/build', { id: NEW_1, request: REQUEST, draftHash: 'ab', replacesPlanIds: [] }],
        [`/plans/${OLD}/restore`, { replacesPlanIds: [] }],
      ] as const) {
        expect((await call(app, 'POST', url, {}, body)).statusCode, url).toBe(401);
        const noTerms = await call(app, 'POST', url, await asC(), body);
        expect(noTerms.statusCode, url).toBe(403);
        expect(noTerms.json().error.code).toBe('terms_not_accepted');
      }
    });

    it('rejects unknown keys, a user id and free text with 400', async () => {
      const headers = await asA();
      const bad = [
        { ...REQUEST, userId: A },
        { ...REQUEST, user_id: A },
        { ...REQUEST, note: 'I am Jane Doe, jane@example.com' },
        { ...REQUEST, weekPattern: { ...REQUEST.weekPattern, extra: 1 } },
        { ...REQUEST, targetRoleIds: ['Data Analyst at ACME'] },
        { ...REQUEST, budget: { mode: 'limit' } },
        { ...REQUEST, deadline: undefined },
      ];
      for (const body of bad) {
        const res = await call(app, 'POST', '/plans/build/preview', headers, body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
      }
      const draftHash = 'abcdef0123456789';
      for (const extra of [{ user_id: A }, { userId: A }, { name: 'x' }]) {
        const res = await call(app, 'POST', '/plans/build', headers, {
          id: NEW_1,
          request: REQUEST,
          draftHash,
          replacesPlanIds: [],
          ...extra,
        });
        expect(res.statusCode).toBe(400);
      }
      const nested = await call(app, 'POST', '/plans/build', headers, {
        id: NEW_1,
        request: { ...REQUEST, userId: B },
        draftHash,
        replacesPlanIds: [],
      });
      expect(nested.statusCode).toBe(400);
      expect(
        (
          await call(app, 'POST', `/plans/${OLD}/restore`, headers, {
            replacesPlanIds: [],
            user_id: B,
          })
        ).statusCode,
      ).toBe(400);
      expect(await count('select count(*) as n from rnd.plans')).toBe(0);
    });

    it('maps builder errors to 422 with codes and ids only', async () => {
      const unknown = await callA('POST', '/plans/build/preview', {
        ...REQUEST,
        targetRoleIds: ['no-such-role'],
      });
      expect(unknown.statusCode).toBe(422);
      const error = unknown.json().error;
      expect(error.code).toBe('unprocessable');
      expect(error.issues).toEqual([{ code: 'unknown_role', id: 'no-such-role' }]);
      expect(error.message).not.toContain('no-such-role');

      const order = await callA('POST', '/plans/build/preview', {
        ...REQUEST,
        deadline: '2026-11-02',
      });
      expect(order.statusCode).toBe(422);
      expect(order.json().error.issues.map((i: { code: string }) => i.code)).toContain(
        'deadline_not_after_start',
      );
      const far = await callA('POST', '/plans/build/preview', {
        ...REQUEST,
        deadline: '2030-01-01',
      });
      expect(far.statusCode).toBe(422);
      expect(far.json().error.issues.map((i: { code: string }) => i.code)).toContain(
        'deadline_too_far',
      );
      // The same mapping on create, and nothing is written.
      const create = await callA('POST', '/plans/build', {
        id: NEW_1,
        request: { ...REQUEST, extraSkillIds: ['no-such-skill'] },
        draftHash: 'abcdef0123456789',
        replacesPlanIds: [],
      });
      expect(create.statusCode).toBe(422);
      expect(create.json().error.issues).toEqual([{ code: 'unknown_skill', id: 'no-such-skill' }]);
      expect(await count('select count(*) as n from rnd.plans')).toBe(0);
    });
  });

  describe('preview', () => {
    it('returns the draft and saves nothing', async () => {
      await importDemo(OLD);
      const before = await tableCounts();
      const res = await callA('POST', '/plans/build/preview', REQUEST);
      expect(res.statusCode).toBe(200);
      const draft = BuildDraftSchema.parse(res.json());
      expect(draft.plan.tasks.length).toBeGreaterThan(0);
      expect(draft.plan.tasks.every((t) => t.source === 'builder')).toBe(true);
      expect(draft.draftHash).toMatch(/^[0-9a-f]+$/);
      // Again: the same request gives the same draft.
      expect((await callA('POST', '/plans/build/preview', REQUEST)).json().draftHash).toBe(
        draft.draftHash,
      );
      expect(await tableCounts()).toEqual(before);
      expect(await statusOf(OLD)).toBe('active');
    });

    it('computes today in the plan time zone', async () => {
      // 22:30 UTC on 1 November is 00:30 on 2 November in Jerusalem (UTC+2).
      clock = new Date('2026-11-01T22:30:00Z');
      const res = await callA('POST', '/plans/build/preview', {
        ...REQUEST,
        startDate: '2026-11-01',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.scheduleFrom).toBe('2026-11-02');
      clock = new Date('2026-11-01T21:30:00Z');
      const earlier = await callA('POST', '/plans/build/preview', {
        ...REQUEST,
        startDate: '2026-11-01',
      });
      expect(earlier.json().summary.scheduleFrom).toBe('2026-11-01');
    });
  });

  describe('build', () => {
    it('creates the plan and archives the active one in one step', async () => {
      await importDemo(OLD);
      const body = await bodyFor(NEW_1, [OLD]);
      const res = await callA('POST', '/plans/build', body);
      expect(res.statusCode).toBe(201);
      const plan = res.json();
      expect(plan).toMatchObject({ id: NEW_1, status: 'active', createdFrom: 'builder' });
      expect(plan.tasks.length).toBeGreaterThan(0);
      expect(plan.tasks.every((t: { source: string }) => t.source === 'builder')).toBe(true);
      expect(plan.summary).toMatchObject({ targetRoleIds: ['data-analyst'], builderVersion: 1 });
      expect(plan.endDate).toBe(REQUEST.deadline);

      const [row] = await rows<{ user_id: string; created_from: string }>(
        'select user_id, created_from from rnd.plans where id = $1',
        [NEW_1],
      );
      expect(row).toEqual({ user_id: A, created_from: 'builder' });
      expect(await statusOf(OLD)).toBe('archived');

      const archived = await rows<{ plan_id: string; payload: Record<string, unknown> }>(
        `select plan_id, payload from rnd.events where type = 'plan.archived'`,
      );
      expect(archived).toEqual([
        { plan_id: OLD, payload: { by: 'plan_builder', replacedBy: NEW_1 } },
      ]);
      const imported = await rows<{ payload: Record<string, unknown> }>(
        `select payload from rnd.events where type = 'plan.imported' and plan_id = $1`,
        [NEW_1],
      );
      expect(imported).toHaveLength(1);
      expect(imported[0]!.payload).toMatchObject({ createdFrom: 'builder', status: 'active' });
      expect(await count(`select count(*) as n from rnd.plans where status = 'active'`)).toBe(1);
    });

    it('archives nothing when there is no active plan', async () => {
      const res = await callA('POST', '/plans/build', await bodyFor(NEW_1, []));
      expect(res.statusCode).toBe(201);
      expect(await count(`select count(*) as n from rnd.events where type = 'plan.archived'`)).toBe(
        0,
      );
    });

    it('archives every active plan the user confirmed', async () => {
      await importDemo(OLD);
      await importDemo(OLD_2);
      const res = await callA('POST', '/plans/build', await bodyFor(NEW_1, [OLD_2, OLD]));
      expect(res.statusCode).toBe(201);
      expect(await statusOf(OLD)).toBe('archived');
      expect(await statusOf(OLD_2)).toBe('archived');
    });

    it('rolls everything back when the insert fails after the archive', async () => {
      await importDemo(OLD);
      await testDb.admin(async (c) => {
        await c.query(
          `create or replace function rnd.fail_task_insert() returns trigger language plpgsql as
           $$ begin raise exception 'forced failure'; end $$`,
        );
        await c.query(
          `create trigger fail_task_insert before insert on rnd.tasks
           for each row execute function rnd.fail_task_insert()`,
        );
      });
      const before = await tableCounts();
      const res = await callA('POST', '/plans/build', await bodyFor(NEW_1, [OLD]));
      expect(res.statusCode).toBe(500);
      await rows('drop trigger fail_task_insert on rnd.tasks');
      expect(await statusOf(OLD)).toBe('active');
      expect(await statusOf(NEW_1)).toBeUndefined();
      expect(await tableCounts()).toEqual(before);
    });

    it('is idempotent: the same body again answers 200 and archives nothing twice', async () => {
      await importDemo(OLD);
      const body = await bodyFor(NEW_1, [OLD]);
      const first = await callA('POST', '/plans/build', body);
      expect(first.statusCode).toBe(201);
      const again = await callA('POST', '/plans/build', body);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect(await count(`select count(*) as n from rnd.events where type = 'plan.archived'`)).toBe(
        1,
      );
      expect(await count('select count(*) as n from rnd.plans')).toBe(2);
      // The same id with another request is a conflict, and still nothing changes.
      const other = await callA('POST', '/plans/build', {
        ...body,
        request: { ...REQUEST, deadline: '2026-12-20' },
        draftHash: (await preview({ ...REQUEST, deadline: '2026-12-20' })).draftHash,
      });
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe('conflict');
      expect(await count('select count(*) as n from rnd.plans')).toBe(2);
    });

    it('answers a retry with 200 after the catalog changed', async () => {
      await importDemo(OLD);
      const body = await bodyFor(NEW_1, [OLD]);
      expect((await callA('POST', '/plans/build', body)).statusCode).toBe(201);
      // After a deploy with another catalog the draft hash differs, and the active set is not
      // what the body said any more. Neither may turn the retry into a 409.
      const retry = await call(appChanged, 'POST', '/plans/build', await asA(), body);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().id).toBe(NEW_1);
    });

    it('answers 409 draft_changed when the draft is not the one that was previewed', async () => {
      await importDemo(OLD);
      const body = await bodyFor(NEW_1, [OLD]);
      const stale = await call(appChanged, 'POST', '/plans/build', await asA(), body);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('draft_changed');
      const wrongHash = await callA('POST', '/plans/build', {
        ...body,
        draftHash: '0123456789abcdef',
      });
      expect(wrongHash.statusCode).toBe(409);
      expect(wrongHash.json().error.code).toBe('draft_changed');
      expect(await statusOf(OLD)).toBe('active');
      expect(await statusOf(NEW_1)).toBeUndefined();
    });

    it('answers 409 active_plan_changed when replacesPlanIds is not the active set', async () => {
      await importDemo(OLD);
      const before = await tableCounts();
      for (const replaces of [[], [GHOST], [OLD, GHOST]]) {
        const res = await callA('POST', '/plans/build', await bodyFor(NEW_1, replaces));
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('active_plan_changed');
      }
      expect(await tableCounts()).toEqual(before);
      expect(await statusOf(OLD)).toBe('active');
    });

    it('lets exactly one of two simultaneous builds succeed when there is no active plan', async () => {
      const [b1, b2] = [await bodyFor(NEW_1, []), await bodyFor(NEW_2, [])];
      const results = await Promise.all([
        callA('POST', '/plans/build', b1),
        callA('POST', '/plans/build', b2),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe(
        'active_plan_changed',
      );
      expect(await count(`select count(*) as n from rnd.plans where status = 'active'`)).toBe(1);
      expect(await count('select count(*) as n from rnd.plans')).toBe(1);
    });

    it('serialises a build and an import on the per-user lock', async () => {
      const body = await bodyFor(NEW_1, []);
      // Hold the user's lock from outside, queue the import and then the build behind it.
      const holder = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
          `active-plan:rnd:${A}`,
        ]);
        const waiting = async (n: number) => {
          for (let i = 0; i < 200; i++) {
            const waiters = await count(
              `select count(*) as n from pg_locks where locktype = 'advisory' and not granted`,
            );
            if (waiters >= n) return;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(`fewer than ${n} requests are waiting for the lock`);
        };
        const imported = importDemo(OLD);
        await waiting(1);
        const built = callA('POST', '/plans/build', body);
        await waiting(2);
        expect(await statusOf(OLD)).toBeUndefined();
        await holder.query('commit');
        const [importRes, buildRes] = await Promise.all([imported, built]);
        expect(importRes.statusCode).toBe(201);
        // The build's check saw the imported plan, which was not in its replacesPlanIds.
        expect(buildRes.statusCode).toBe(409);
        expect(buildRes.json().error.code).toBe('active_plan_changed');
        expect(await statusOf(OLD)).toBe('active');
        expect(await statusOf(NEW_1)).toBeUndefined();
      } finally {
        await holder.end();
      }
    });
  });

  describe('restore', () => {
    const buildOver = async () => {
      await importDemo(OLD);
      const res = await callA('POST', '/plans/build', await bodyFor(NEW_1, [OLD]));
      expect(res.statusCode).toBe(201);
    };

    it('swaps the active plan and the archived one in one step', async () => {
      await buildOver();
      const res = await callA('POST', `/plans/${OLD}/restore`, { replacesPlanIds: [NEW_1] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: OLD, status: 'active' });
      expect(await statusOf(OLD)).toBe('active');
      expect(await statusOf(NEW_1)).toBe('archived');
      const events = await rows<{
        plan_id: string;
        type: string;
        payload: Record<string, unknown>;
      }>(
        `select plan_id, type, payload from rnd.events
         where type in ('plan.restored', 'plan.archived') order by created_at, id`,
      );
      expect(events).toContainEqual({
        plan_id: OLD,
        type: 'plan.restored',
        payload: { replaced: [NEW_1] },
      });
      expect(events).toContainEqual({
        plan_id: NEW_1,
        type: 'plan.archived',
        payload: { by: 'restore', replacedBy: OLD },
      });
    });

    it('answers 200 for a retry and changes nothing', async () => {
      await buildOver();
      const body = { replacesPlanIds: [NEW_1] };
      expect((await callA('POST', `/plans/${OLD}/restore`, body)).statusCode).toBe(200);
      const events = await count('select count(*) as n from rnd.events');
      const retry = await callA('POST', `/plans/${OLD}/restore`, body);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().id).toBe(OLD);
      expect(await count('select count(*) as n from rnd.events')).toBe(events);
    });

    it('answers 409 when replacesPlanIds is not the active set', async () => {
      await buildOver();
      for (const replaces of [[], [OLD], [NEW_1, GHOST]]) {
        const res = await callA('POST', `/plans/${OLD}/restore`, { replacesPlanIds: replaces });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('active_plan_changed');
      }
      expect(await statusOf(OLD)).toBe('archived');
      expect(await statusOf(NEW_1)).toBe('active');
    });

    it('restores when no plan is active', async () => {
      await buildOver();
      await rows(`update rnd.plans set status = 'archived'`);
      const res = await callA('POST', `/plans/${OLD}/restore`, { replacesPlanIds: [] });
      expect(res.statusCode).toBe(200);
      expect(await statusOf(OLD)).toBe('active');
    });

    it('refuses a draft, a done plan and one that is active next to others', async () => {
      await importDemo(OLD, 'draft');
      await importDemo(OLD_2);
      await rows(`update rnd.plans set status = 'done' where id = $1`, [OLD_2]);
      const draft = await callA('POST', `/plans/${OLD}/restore`, { replacesPlanIds: [] });
      expect(draft.statusCode).toBe(409);
      expect(draft.json().error.code).toBe('plan_not_archived');
      const done = await callA('POST', `/plans/${OLD_2}/restore`, { replacesPlanIds: [] });
      expect(done.statusCode).toBe(409);
      expect(done.json().error.code).toBe('plan_not_archived');
      expect(await statusOf(OLD)).toBe('draft');
      expect(await statusOf(OLD_2)).toBe('done');
    });

    it('answers 404 for a plan that does not exist', async () => {
      const res = await callA('POST', `/plans/${GHOST}/restore`, { replacesPlanIds: [] });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('another user', () => {
    it('never sees, archives or restores the first user’s plans', async () => {
      await importDemo(OLD);
      const built = await callA('POST', '/plans/build', await bodyFor(NEW_1, [OLD]));
      expect(built.statusCode).toBe(201);
      // OLD is archived, NEW_1 is active, both are A's.
      const headers = await asB();
      expect((await callB('GET', '/plans')).json().plans).toEqual([]);
      for (const planId of [OLD, NEW_1]) {
        expect((await callB('GET', `/plans/${planId}`)).statusCode).toBe(404);
        expect(
          (await call(app, 'POST', `/plans/${planId}/restore`, headers, { replacesPlanIds: [] }))
            .statusCode,
        ).toBe(404);
        // An archived plan of someone else looks like no plan at all, not like a 409.
        expect(
          (await call(app, 'PUT', `/plans/${planId}/week-pattern`, headers, REQUEST.weekPattern))
            .statusCode,
        ).toBe(404);
      }
      // B builds a plan naming A's active plan: B has none, so the set does not match.
      const naming = await callB('POST', '/plans/build', await bodyFor(id(20), [NEW_1]));
      expect(naming.statusCode).toBe(409);
      expect(naming.json().error.code).toBe('active_plan_changed');
      // B's own build leaves A's plans alone and is owned by B.
      const own = await callB('POST', '/plans/build', await bodyFor(id(21), []));
      expect(own.statusCode).toBe(201);
      expect(await statusOf(NEW_1)).toBe('active');
      expect(await statusOf(OLD)).toBe('archived');
      expect(
        (
          await rows<{ user_id: string }>('select user_id from rnd.plans where id = $1', [id(21)])
        )[0]!.user_id,
      ).toBe(B);
      // Row-level security directly: B's session cannot even update A's rows.
      await db.withUser(B, async (ctx) => {
        const seen = await ctx.client.query('select id from rnd.plans');
        expect(seen.rows.map((r) => r.id)).toEqual([id(21)]);
        const updated = await ctx.client.query(
          `update rnd.plans set status = 'archived' where id = $1`,
          [NEW_1],
        );
        expect(updated.rowCount).toBe(0);
      });
    });
  });
});
