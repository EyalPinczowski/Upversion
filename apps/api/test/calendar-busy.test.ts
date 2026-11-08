import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testApp, testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'a0000000-0000-4000-8000-000000000002';
const PLAN_OF_B = 'b0000000-0000-4000-8000-000000000001';
const google = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://app.example.test/calendar/callback',
  apiBase: 'http://127.0.0.1:9/calendar/v3',
  oauthBase: 'http://127.0.0.1:9',
};
const calendar = { enabled: true, tokenKeys: [{ id: 'v1', key: randomBytes(32) }], google };

describe('GET /calendar/busy without the feature or a token', () => {
  it('does not exist with the flag off (404)', async () => {
    const app = testApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/calendar/busy?from=2026-11-08&to=2026-11-14',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('needs a token with the flag on (401)', async () => {
    const app = testApp({ calendar });
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/calendar/busy?from=2026-11-08&to=2026-11-14',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe.skipIf(!dbAvailable)('GET /calendar/busy (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000, calendar }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  const sql = (text: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(text, params)).rows);

  const busy = (
    user: string,
    date: string,
    id: string,
    start: number,
    end: number,
    over: { cal?: string; kind?: string; title?: string; blocksDay?: boolean } = {},
  ) =>
    sql(
      `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id,
         start_minute, end_minute, title, kind, blocks_day)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        user,
        date,
        id,
        over.cal ?? 'work',
        start,
        end,
        over.title ?? '',
        over.kind ?? 'busy',
        over.blocksDay ?? false,
      ],
    );

  beforeEach(async () => {
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`,
        [A, B],
      );
      await acceptCurrentLegal(c, [A, B]);
      // Plan A (Berlin) is older; plan B (New York) is the newest active plan.
      for (const [user, plan, zone, created] of [
        [A, PLAN_A, 'Europe/Berlin', '2026-11-01'],
        [A, PLAN_B, 'America/New_York', '2026-11-02'],
        [B, PLAN_OF_B, 'Europe/Berlin', '2026-11-01'],
      ]) {
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, start_date, status, created_at)
           values ($1, $2, 'builder', 'Plan', '2026-11-01', 'active', $3)`,
          [user, plan, created],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
           values ($1, $2, '{0,1,2,3,4}', 7, '09:00', '17:00', '13:00', '14:00', 0, $3)`,
          [user, plan, zone],
        );
      }
      for (const u of [A, B]) {
        await c.query(
          `insert into rnd.calendar_sources (user_id, calendar_id, name, blocks_time)
           values ($1, 'work', 'Work', true), ($1, 'family', 'Family', false)`,
          [u],
        );
      }
    });
  });

  const get = async (query: string, user = A) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/calendar/busy${query}`,
      headers: {
        authorization: `Bearer ${await keys.sign({ sub: user, email: user === A ? 'a@example.com' : 'b@example.com' })}`,
      },
    });
  const RANGE = '?from=2026-11-08&to=2026-11-14';

  it('returns an empty list when nothing is synced', async () => {
    const res = await get(RANGE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it('returns start, end, all-day flag, kind and title, ordered, and nothing else', async () => {
    await busy(A, '2026-11-10', 'e2', 840, 900, { title: 'Dentist' });
    await busy(A, '2026-11-09', 'e1', 600, 660, { title: 'Interview' });
    await busy(A, '2026-11-11', 'e3', 0, 1440, { kind: 'all_day', blocksDay: true, title: 'Away' });
    const res = await get(RANGE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          date: '2026-11-09',
          startMinute: 600,
          endMinute: 660,
          allDay: false,
          kind: 'busy',
          title: 'Interview',
        },
        {
          date: '2026-11-10',
          startMinute: 840,
          endMinute: 900,
          allDay: false,
          kind: 'busy',
          title: 'Dentist',
        },
        {
          date: '2026-11-11',
          startMinute: 0,
          endMinute: 1440,
          allDay: true,
          kind: 'busy',
          title: 'Away',
        },
      ],
    });
  });

  it('keeps to the date range, both ends included', async () => {
    await busy(A, '2026-11-07', 'before', 600, 660);
    await busy(A, '2026-11-08', 'first', 600, 660);
    await busy(A, '2026-11-14', 'last', 600, 660);
    await busy(A, '2026-11-15', 'after', 600, 660);
    const dates = (await get(RANGE)).json().items.map((i: { date: string }) => i.date);
    expect(dates).toEqual(['2026-11-08', '2026-11-14']);
  });

  it('returns only calendars the owner chose to block time', async () => {
    await busy(A, '2026-11-09', 'mine', 600, 660, { cal: 'work' });
    await busy(A, '2026-11-09', 'not-chosen', 700, 760, { cal: 'family' });
    await busy(A, '2026-11-09', 'orphan', 800, 860, { cal: 'removed-calendar' });
    const items = (await get(RANGE)).json().items;
    expect(items.map((i: { startMinute: number }) => i.startMinute)).toEqual([600]);
  });

  it('returns tentative events as tentative and non-blocking all-day events as non_blocking', async () => {
    await busy(A, '2026-11-09', 'tent', 600, 660, { kind: 'tentative', title: 'Maybe lunch' });
    await busy(A, '2026-11-10', 'bday', 0, 1440, {
      kind: 'all_day',
      blocksDay: false,
      title: 'Bday',
    });
    await busy(A, '2026-11-11', 'away', 0, 1440, {
      kind: 'all_day',
      blocksDay: true,
      title: 'Away',
    });
    expect((await get(RANGE)).json().items).toEqual([
      {
        date: '2026-11-09',
        startMinute: 600,
        endMinute: 660,
        allDay: false,
        kind: 'tentative',
        title: 'Maybe lunch',
      },
      {
        date: '2026-11-10',
        startMinute: 0,
        endMinute: 1440,
        allDay: true,
        kind: 'non_blocking',
        title: 'Bday',
      },
      {
        date: '2026-11-11',
        startMinute: 0,
        endMinute: 1440,
        allDay: true,
        kind: 'busy',
        title: 'Away',
      },
    ]);
  });

  it('still limits tentative and non-blocking events to the calendars the owner chose', async () => {
    await busy(A, '2026-11-09', 'tent', 600, 660, { kind: 'tentative', cal: 'family' });
    await busy(A, '2026-11-10', 'bday', 0, 1440, { kind: 'all_day', cal: 'family' });
    expect((await get(RANGE)).json().items).toEqual([]);
  });

  it("never returns another user's rows", async () => {
    await busy(A, '2026-11-09', 'a-event', 600, 660, { title: 'A secret' });
    await busy(B, '2026-11-09', 'b-event', 700, 760, { title: 'B secret' });
    const forA = JSON.stringify((await get(RANGE, A)).json());
    const forB = JSON.stringify((await get(RANGE, B)).json());
    expect(forA).toContain('A secret');
    expect(forA).not.toContain('B secret');
    expect(forB).toContain('B secret');
    expect(forB).not.toContain('A secret');
  });

  it('rejects a user id sent by the client (strict query)', async () => {
    await busy(B, '2026-11-09', 'b-event', 700, 760);
    const res = await get(`${RANGE}&userId=${B}`);
    expect(res.statusCode).toBe(400);
  });

  const lock = (
    user: string,
    plan: string,
    key: string,
    start: string,
    end: string,
    reason = 'deleted',
  ) =>
    sql(
      `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
       values ($1, $2, $3, 't', $4, $5, $6)`,
      [user, plan, key, start, end, reason],
    );
  const setSyncZone = (zone: string) =>
    sql(
      `insert into rnd.calendar_connections (user_id, refresh_token_ciphertext, sync_timezone)
       values ($1, 'ct', $2)`,
      [A, zone],
    );

  describe('slots of blocks deleted in Google', () => {
    it('are busy, in the plan time zone (not the sync zone), and moved ones are not', async () => {
      await setSyncZone('Asia/Tokyo');
      await lock(A, PLAN_A, 'k1', '2026-11-10 08:00+00', '2026-11-10 09:30+00');
      await lock(A, PLAN_A, 'k2', '2026-11-11 08:00+00', '2026-11-11 09:00+00', 'moved');
      const res = await get(`${RANGE}&planId=${PLAN_A}`);
      // Berlin is UTC+1 in November: 09:00 to 10:30.
      expect(res.json().items).toEqual([
        {
          date: '2026-11-10',
          startMinute: 540,
          endMinute: 630,
          allDay: false,
          kind: 'busy',
          title: '',
        },
      ]);
    });

    it('are filtered by the plan shown: another plan of the same user is not drawn', async () => {
      await lock(A, PLAN_A, 'k1', '2026-11-10 08:00+00', '2026-11-10 09:00+00');
      await lock(A, PLAN_B, 'k1', '2026-11-12 08:00+00', '2026-11-12 09:00+00');
      const a = (await get(`${RANGE}&planId=${PLAN_A}`)).json().items;
      const b = (await get(`${RANGE}&planId=${PLAN_B}`)).json().items;
      expect(a.map((i: { date: string }) => i.date)).toEqual(['2026-11-10']);
      expect(b.map((i: { date: string }) => i.date)).toEqual(['2026-11-12']);
    });

    it("default to the user's newest active plan, in that plan's zone", async () => {
      await lock(A, PLAN_A, 'k1', '2026-11-10 08:00+00', '2026-11-10 09:00+00');
      await lock(A, PLAN_B, 'k1', '2026-11-12 14:00+00', '2026-11-12 15:00+00');
      // Plan B is the newest; New York is UTC-5 in November: 09:00 to 10:00.
      expect((await get(RANGE)).json().items).toEqual([
        {
          date: '2026-11-12',
          startMinute: 540,
          endMinute: 600,
          allDay: false,
          kind: 'busy',
          title: '',
        },
      ]);
    });

    it("never include another user's deleted locks, with or without a planId", async () => {
      await lock(B, PLAN_OF_B, 'k1', '2026-11-10 08:00+00', '2026-11-10 09:00+00');
      expect((await get(RANGE, A)).json().items).toEqual([]);
      // Asking for another user's plan is not found, and shows nothing about it.
      const res = await get(`${RANGE}&planId=${PLAN_OF_B}`, A);
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify((await get(RANGE, B)).json())).toContain('"startMinute":540');
    });

    it('split on the plan zone across a daylight-saving change', async () => {
      await setSyncZone('Asia/Tokyo');
      // New York springs forward on 2026-03-08 (02:00 to 03:00): 15:00Z is 11:00 EDT, not 10:00 EST.
      await lock(A, PLAN_B, 'dst', '2026-03-08 15:00+00', '2026-03-08 16:00+00');
      const res = await get(`?from=2026-03-08&to=2026-03-08&planId=${PLAN_B}`);
      expect(res.json().items).toEqual([
        {
          date: '2026-03-08',
          startMinute: 660,
          endMinute: 720,
          allDay: false,
          kind: 'busy',
          title: '',
        },
      ]);
    });

    it('rejects a planId that is not a uuid (400)', async () => {
      expect((await get(`${RANGE}&planId=nope`)).statusCode).toBe(400);
    });
  });

  describe('range validation', () => {
    it('accepts exactly 14 days', async () => {
      expect((await get('?from=2026-11-01&to=2026-11-14')).statusCode).toBe(200);
    });
    it.each([
      ['more than 14 days', '?from=2026-11-01&to=2026-11-15'],
      ['from after to', '?from=2026-11-14&to=2026-11-08'],
      ['a missing end', '?from=2026-11-08'],
      ['not a date', '?from=yesterday&to=2026-11-08'],
      ['an impossible date', '?from=2026-02-30&to=2026-03-02'],
    ])('rejects %s (400)', async (_name, query) => {
      expect((await get(query)).statusCode).toBe(400);
    });
  });
});
