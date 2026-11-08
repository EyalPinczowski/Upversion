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
      await c.query(
        `insert into rnd.plans (user_id, id, created_from, name, start_date)
         values ($1, $2, 'builder', 'Plan', '2026-11-01')`,
        [A, PLAN_A],
      );
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

  it('returns start, end, all-day flag and title, ordered, and nothing else', async () => {
    await busy(A, '2026-11-10', 'e2', 840, 900, { title: 'Dentist' });
    await busy(A, '2026-11-09', 'e1', 600, 660, { title: 'Interview' });
    await busy(A, '2026-11-11', 'e3', 0, 1440, { kind: 'all_day', blocksDay: true, title: 'Away' });
    const res = await get(RANGE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { date: '2026-11-09', startMinute: 600, endMinute: 660, allDay: false, title: 'Interview' },
        { date: '2026-11-10', startMinute: 840, endMinute: 900, allDay: false, title: 'Dentist' },
        { date: '2026-11-11', startMinute: 0, endMinute: 1440, allDay: true, title: 'Away' },
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

  it('leaves out tentative events and all-day events that do not block the day', async () => {
    await busy(A, '2026-11-09', 'tent', 600, 660, { kind: 'tentative' });
    await busy(A, '2026-11-10', 'bday', 0, 1440, { kind: 'all_day', blocksDay: false });
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

  it('shows slots of blocks deleted in Google as busy, in the sync time zone, and not moved ones', async () => {
    await sql(
      `insert into rnd.calendar_connections (user_id, refresh_token_ciphertext, sync_timezone)
       values ($1, 'ct', 'Europe/Berlin')`,
      [A],
    );
    await sql(
      `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
       values ($1, $2, 'k1', 't1', '2026-11-10 08:00+00', '2026-11-10 09:30+00', 'deleted'),
              ($1, $2, 'k2', 't2', '2026-11-11 08:00+00', '2026-11-11 09:00+00', 'moved')`,
      [A, PLAN_A],
    );
    const res = await get(RANGE);
    expect(res.json().items).toEqual([
      { date: '2026-11-10', startMinute: 540, endMinute: 630, allDay: false, title: '' },
    ]);
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
