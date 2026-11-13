import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real sync engine is replaced by a spy: this test is about which routes ask for a sync, not
// about what the sync does (calendar-sync.test.ts covers that, including archived plans).
const afterReschedule = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/calendar/sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCalendarSync: () => ({
    afterReschedule,
    idle: async () => undefined,
    deletePlanEvents: async () => undefined,
  }),
}));

import { buildApp, RESCHEDULING_ROUTE } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const OLD = 'd0000000-0000-4000-8000-000000000001';
const NEW = 'd0000000-0000-4000-8000-000000000002';

const REQUEST = {
  targetRoleIds: ['data-analyst'],
  startDate: '2026-11-03',
  deadline: '2026-12-15',
  weekPattern: {
    studyWeekdays: [0, 1, 2, 3, 4],
    defaultHours: 3,
    windowStart: '09:00',
    windowEnd: '17:30',
    timezone: 'Asia/Jerusalem',
  },
  budget: { mode: 'flexible' },
  certPreference: 'none',
  interviewPrep: 'no',
};

describe('RESCHEDULING_ROUTE', () => {
  it('matches the build and restore routes and still not the previews', () => {
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/build')).toBe(true);
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/:id/restore')).toBe(true);
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/import')).toBe(true);
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/build/preview')).toBe(false);
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/:id/schedule/preview')).toBe(false);
    expect(RESCHEDULING_ROUTE.test('/api/v1/plans/:id')).toBe(false);
  });
});

describe.skipIf(!dbAvailable)('calendar sync after build and restore (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    const base = testConfig({
      appEnv: 'rnd',
      rateLimitPerMinute: 100_000,
      calendar: {
        enabled: true,
        tokenKeys: [{ id: 'v1', key: Buffer.alloc(32, 7) }],
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret-plaintext',
          redirectUri: 'https://app.example.test/calendar/callback',
          apiBase: 'https://calendar.invalid/calendar/v3',
          oauthBase: 'https://oauth.invalid',
        },
      },
    });
    app = buildApp(
      { ...base, features: { ...base.features, planBuilder: true } },
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        now: () => new Date('2026-11-01T10:00:00Z'),
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  beforeEach(async () => {
    afterReschedule.mockClear();
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(`insert into rnd.allowed_emails (email) values ('a@example.com')`);
      await c.query(`insert into rnd.app_users (id, email) values ($1, 'a@example.com')`, [A]);
      await acceptCurrentLegal(c, [A]);
    });
  });

  const call = async (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await keys.sign({ sub: A, email: 'a@example.com' })}` },
      payload: payload as object,
    });
  const settle = () => new Promise((r) => setImmediate(r));

  it('asks for a sync after a build and after a restore, not after a preview or a refusal', async () => {
    const preview = await call('/plans/build/preview', REQUEST);
    expect(preview.statusCode).toBe(200);
    await settle();
    expect(afterReschedule).not.toHaveBeenCalled();

    const draftHash = preview.json().draftHash;
    const built = await call('/plans/build', {
      id: OLD,
      request: REQUEST,
      draftHash,
      replacesPlanIds: [],
    });
    expect(built.statusCode).toBe(201);
    await settle();
    expect(afterReschedule).toHaveBeenCalledTimes(1);
    expect(afterReschedule).toHaveBeenLastCalledWith(A);

    // A refused call (409) does not.
    const stale = await call('/plans/build', {
      id: NEW,
      request: REQUEST,
      draftHash,
      replacesPlanIds: [],
    });
    expect(stale.statusCode).toBe(409);
    await settle();
    expect(afterReschedule).toHaveBeenCalledTimes(1);

    const second = await call('/plans/build', {
      id: NEW,
      request: REQUEST,
      draftHash,
      replacesPlanIds: [OLD],
    });
    expect(second.statusCode).toBe(201);
    await settle();
    expect(afterReschedule).toHaveBeenCalledTimes(2);

    const restored = await call(`/plans/${OLD}/restore`, { replacesPlanIds: [NEW] });
    expect(restored.statusCode).toBe(200);
    await settle();
    expect(afterReschedule).toHaveBeenCalledTimes(3);
    expect(afterReschedule).toHaveBeenLastCalledWith(A);
  });
});
