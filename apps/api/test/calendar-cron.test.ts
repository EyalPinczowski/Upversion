import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { CalendarTokenCrypto } from '../src/calendar-crypto';
import { ConfigError, loadConfig } from '../src/config';
import { HttpError } from '../src/errors';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { createCalendarCron, GLOBAL_RUNS_PER_MINUTE } from '../src/modules/calendar/cron';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { GoogleStub } from './google-stub';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const SECRET = 'cron-secret-0123456789-abcdefghijklmnop-XYZ';
const URL = '/api/v1/internal/calendar/sync-due';
const REFRESH = 'refresh-token-plaintext-0001';
const APP_KEY = Buffer.alloc(32, 7);
const crypto = new CalendarTokenCrypto([{ id: 'v1', key: APP_KEY }]);
const uid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-1111111111${String(n).repeat(2)}`;
const plan = (n: number) => `a000000${n}-0000-4000-8000-000000000001`;
const primary = (n: number) => `u${n}@example.com`;
const appCal = (n: number) => `app-cal-u${n}`;
const email = primary;

// ------------------------------------------------------------------ configuration (no database)

describe('cron configuration', () => {
  const base = { LOG_LEVEL: 'silent' };
  it('is off by default', () => {
    expect(loadConfig(base).calendar.cron ?? null).toBeNull();
  });
  it('needs both the flag and the secret', () => {
    expect(loadConfig({ ...base, FEATURE_CALENDAR_CRON: 'true' }).calendar.cron ?? null).toBeNull();
    expect(loadConfig({ ...base, CALENDAR_CRON_SECRET: SECRET }).calendar.cron ?? null).toBeNull();
    expect(
      loadConfig({ ...base, FEATURE_CALENDAR_CRON: 'true', CALENDAR_CRON_SECRET: SECRET }).calendar
        .cron,
    ).toEqual({ secret: SECRET, maxUsers: 20 });
  });
  it('refuses a secret shorter than 32 characters, without echoing it', () => {
    const short = 'too-short-secret-value';
    try {
      loadConfig({ ...base, CALENDAR_CRON_SECRET: short });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('CALENDAR_CRON_SECRET');
      expect((error as Error).message).not.toContain(short);
    }
  });
  it('reads and bounds CALENDAR_CRON_MAX_USERS', () => {
    const on = { ...base, FEATURE_CALENDAR_CRON: 'true', CALENDAR_CRON_SECRET: SECRET };
    expect(loadConfig({ ...on, CALENDAR_CRON_MAX_USERS: '5' }).calendar.cron?.maxUsers).toBe(5);
    expect(() => loadConfig({ ...on, CALENDAR_CRON_MAX_USERS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...on, CALENDAR_CRON_MAX_USERS: '101' })).toThrow(ConfigError);
  });
});

// ------------------------------------------------------------------ the service (no database)

describe('cron service', () => {
  const quiet = { info: () => undefined, warn: () => undefined };
  const dbWith = (ids: string[]) =>
    ({ dueCalendarUsers: async (_ms: number, limit: number) => ids.slice(0, limit) }) as never;

  it('keeps going after one user fails, and counts without naming anyone', async () => {
    const seen: string[] = [];
    const cron = createCalendarCron({
      db: dbWith(['u1', 'u2', 'u3', 'u4']),
      maxUsers: 20,
      log: quiet,
      sync: {
        syncNow: async (user: string) => {
          seen.push(user);
          if (user === 'u1') throw new Error('boom secret-title');
          if (user === 'u2') throw new HttpError(409, 'calendar_reconnect_required', 'x');
          return { status: user === 'u3' ? 'cached' : 'synced' } as never;
        },
      },
    });
    const result = await cron.run();
    expect(seen).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(result).toEqual({ due: 4, synced: 1, cached: 1, failed: 1, skipped: 1 });
  });

  it('moves on when one user takes longer than the per-user budget', async () => {
    const cron = createCalendarCron({
      db: dbWith(['slow', 'fast']),
      maxUsers: 20,
      log: quiet,
      userBudgetMs: 30,
      sync: {
        syncNow: (user: string) =>
          user === 'slow'
            ? new Promise<never>(() => undefined)
            : Promise.resolve({ status: 'synced' } as never),
      },
    });
    expect(await cron.run()).toEqual({ due: 2, synced: 1, cached: 0, failed: 1, skipped: 0 });
  });

  it('stops starting users when the run budget is used up (the rest are skipped)', async () => {
    let t = 0;
    const cron = createCalendarCron({
      db: dbWith(['a', 'b', 'c']),
      maxUsers: 20,
      log: quiet,
      runBudgetMs: 100,
      now: () => t,
      sync: {
        syncNow: async () => {
          t += 100;
          return { status: 'synced' } as never;
        },
      },
    });
    expect(await cron.run()).toEqual({ due: 3, synced: 1, cached: 0, failed: 0, skipped: 2 });
  });

  it('passes the configured batch limit to the database', async () => {
    let asked = 0;
    const cron = createCalendarCron({
      db: {
        dueCalendarUsers: async (_ms: number, limit: number) => ((asked = limit), []),
      } as never,
      maxUsers: 7,
      log: quiet,
      sync: { syncNow: async () => ({ status: 'synced' }) as never },
    });
    await cron.run();
    expect(asked).toBe(7);
  });

  it('allows at most six authenticated runs a minute, across callers', () => {
    let t = 0;
    const cron = createCalendarCron({
      db: dbWith([]),
      maxUsers: 1,
      log: quiet,
      now: () => t,
      sync: { syncNow: async () => ({ status: 'synced' }) as never },
    });
    const results = Array.from({ length: GLOBAL_RUNS_PER_MINUTE + 2 }, () => cron.allowRun());
    expect(results).toEqual([true, true, true, true, true, true, false, false]);
    t = 60_001;
    expect(cron.allowRun()).toBe(true);
  });
});

// ------------------------------------------------------------------ the endpoint (real Postgres)

describe.skipIf(!dbAvailable)('scheduled calendar sync (real Postgres, stub Google)', () => {
  let testDb: TestDb;
  let realDb: Database;
  let keys: TestKeys;
  let google: GoogleStub;
  let app: ReturnType<typeof buildApp>;
  let logs: string[];

  const today = new Date().toISOString().slice(0, 10);

  async function startApp(opts: { cron?: boolean; maxUsers?: number } = {}) {
    logs = [];
    app = buildApp(
      testConfig({
        appEnv: 'rnd',
        rateLimitPerMinute: 100_000,
        logLevel: 'trace',
        calendar: {
          enabled: true,
          tokenKeys: [{ id: 'v1', key: APP_KEY }],
          google: {
            clientId: 'client-id',
            clientSecret: 'client-secret-plaintext',
            redirectUri: 'https://app.example.test/calendar/callback',
            apiBase: `${google.base}/calendar/v3`,
            oauthBase: google.base,
          },
          cron: opts.cron === false ? null : { secret: SECRET, maxUsers: opts.maxUsers ?? 20 },
        },
      }),
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db: realDb,
        logStream: { write: (line) => logs.push(line) },
      },
    );
    await app.ready();
  }

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    google = new GoogleStub();
    await google.start();
    realDb = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
  });

  afterAll(async () => {
    await realDb?.close();
    await new Promise((r) => google.server.close(r));
  });

  /** Users 1..N get a plan, tasks and a connection last synced `minutesAgo[n]` minutes ago. */
  async function seed(minutesAgo: Record<number, number | null>) {
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      const ns = Object.keys(minutesAgo).map(Number);
      for (const n of ns) {
        await c.query(`insert into rnd.allowed_emails (email) values ($1)`, [email(n)]);
        await c.query(`insert into rnd.app_users (id, email) values ($1, $2)`, [uid(n), email(n)]);
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
           values ($1, $2, 'builder', 'Plan', 'active', $3, now() - interval '1 day')`,
          [uid(n), plan(n), today],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
           values ($1, $2, '{0,1,2,3,4,5,6}', 7, '09:00', '17:00', '13:00', '14:00', 0, 'UTC')`,
          [uid(n), plan(n)],
        );
        await c.query(
          `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
           values ($1, $2, 'big', 'Big course', 'course', 20, 0)`,
          [uid(n), plan(n)],
        );
        const ago = minutesAgo[n];
        await c.query(
          `insert into rnd.calendar_connections
             (user_id, app_calendar_id, status, refresh_token_ciphertext, last_synced_at)
           values ($1, $2, 'connected', $3, ${ago === null ? 'null' : `now() - interval '${ago} minutes'`})`,
          [uid(n), appCal(n), crypto.encrypt(REFRESH, uid(n))],
        );
        await c.query(
          `insert into rnd.calendar_sources (user_id, calendar_id, name, blocks_time)
           values ($1, $2, 'Personal', true)`,
          [uid(n), primary(n)],
        );
      }
      await acceptCurrentLegal(c, ns.map(uid));
    });
  }

  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);
  const synced = async (n: number) =>
    (
      await rows<{ last_synced_at: Date | null }>(
        'select last_synced_at from rnd.calendar_connections where user_id = $1',
        [uid(n)],
      )
    )[0]!.last_synced_at;
  const call = (
    headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
    payload?: object,
  ) => app.inject({ method: 'POST', url: URL, headers, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    google.seen = [];
    google.cals = new Map();
    google.failWith = null;
    google.failCals = new Set();
    google.hold = null;
    google.grantRevoked = false;
    await startApp();
  });

  afterEach(async () => {
    await app.calendarSyncIdle();
    await app.close();
    const all = logs.join('\n');
    for (const secret of [
      SECRET,
      REFRESH,
      'access-sync',
      'client-secret-plaintext',
      'Title ',
      'Big course',
    ]) {
      expect(all, `logs contain ${secret}`).not.toContain(secret);
    }
  });

  describe('availability', () => {
    it('answers 404 when the secret or the flag is not set (route does not exist)', async () => {
      await seed({ 1: 60 });
      await app.close();
      await startApp({ cron: false });
      const res = await call();
      expect(res.statusCode).toBe(404);
      expect(google.seen).toEqual([]);
      expect(await synced(1)).not.toBeNull();
    });

    it('is not in the OpenAPI document', async () => {
      const doc = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
      expect(doc.body).not.toContain('sync-due');
    });
  });

  describe('authentication', () => {
    it.each([
      ['no header', {}],
      ['a wrong secret', { authorization: `Bearer ${SECRET.replace('0', '1')}` }],
      ['a short secret', { authorization: 'Bearer short' }],
      ['a prefix of the secret', { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
      ['the secret with extra characters', { authorization: `Bearer ${SECRET}x` }],
      ['another scheme', { authorization: `Basic ${SECRET}` }],
      ['no token', { authorization: 'Bearer ' }],
      ['the bare secret', { authorization: SECRET }],
    ])('rejects %s with a generic 401 and does nothing', async (_name, headers) => {
      await seed({ 1: 60 });
      const before = await synced(1);
      const res = await call(headers as Record<string, string>);
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('unauthorized');
      expect(res.body).not.toContain(SECRET);
      expect(google.seen).toEqual([]);
      expect(await synced(1)).toEqual(before);
    });

    it('does not accept a user token, and checks the secret before the body', async () => {
      await seed({ 1: 60 });
      const token = await keys.sign({ sub: uid(1), email: email(1) });
      expect((await call({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
      const res = await call({ authorization: 'Bearer nope' }, { userId: uid(1) });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('the request body', () => {
    it.each([
      { userId: uid(1) },
      { user_id: uid(1) },
      { force: true },
      { limit: 100 },
      { anything: 'at all' },
    ])('rejects %j with 400 and syncs nobody', async (payload) => {
      await seed({ 1: 60 });
      const before = await synced(1);
      const res = await call(undefined, payload);
      expect(res.statusCode).toBe(400);
      expect(google.seen).toEqual([]);
      expect(await synced(1)).toEqual(before);
    });

    it('accepts no body and an empty object', async () => {
      await seed({ 1: 5 });
      expect((await call()).statusCode).toBe(200);
      expect((await call(undefined, {})).statusCode).toBe(200);
    });
  });

  describe('who is synced', () => {
    it('syncs only due users: not recent, disconnected, reconnect-required or switched off', async () => {
      await seed({ 1: 30, 2: 3, 3: 60, 4: 60, 5: 60, 6: null });
      await testDb.admin(async (c) => {
        await c.query(
          `update rnd.calendar_connections set status = 'disconnected', refresh_token_ciphertext = null where user_id = $1`,
          [uid(3)],
        );
        await c.query(
          `update rnd.calendar_connections set status = 'needs_reconnect' where user_id = $1`,
          [uid(4)],
        );
        await c.query(`update rnd.calendar_connections set auto_sync = false where user_id = $1`, [
          uid(5),
        ]);
      });
      const before = {
        2: await synced(2),
        3: await synced(3),
        4: await synced(4),
        5: await synced(5),
      };
      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ due: 2, synced: 2, cached: 0, failed: 0, skipped: 0 });
      expect(await synced(2)).toEqual(before[2]);
      expect(await synced(3)).toEqual(before[3]);
      expect(await synced(4)).toEqual(before[4]);
      expect(await synced(5)).toEqual(before[5]);
      expect(Date.now() - (await synced(1))!.getTime()).toBeLessThan(60_000);
      expect(Date.now() - (await synced(6))!.getTime()).toBeLessThan(60_000);
      // Only the two due users' calendars were read.
      const touched = new Set(google.seen.map((s) => decodeURIComponent(s.path)));
      for (const n of [2, 3, 4, 5]) {
        expect([...touched].some((p) => p.includes(primary(n)) || p.includes(appCal(n)))).toBe(
          false,
        );
      }
    });

    it('takes at most the configured batch, oldest sync first', async () => {
      await app.close();
      await startApp({ maxUsers: 3 });
      await seed({ 1: 20, 2: 90, 3: 40, 4: 120, 5: 60 });
      const before = [1, 2, 3, 4, 5].map(async (n) => synced(n));
      const res = await call();
      expect(res.json()).toEqual({ due: 3, synced: 3, cached: 0, failed: 0, skipped: 0 });
      const prev = await Promise.all(before);
      // The three oldest (4: 120, 2: 90, 5: 60) were synced; 3 (40) and 1 (20) were not.
      const after = await Promise.all([1, 2, 3, 4, 5].map((n) => synced(n)));
      const changed = [1, 2, 3, 4, 5].filter((_, i) => after[i]!.getTime() !== prev[i]!.getTime());
      expect(changed).toEqual([2, 4, 5]);
    });

    it('a second run right after finds nobody due', async () => {
      await seed({ 1: 60, 2: 60 });
      expect((await call()).json().synced).toBe(2);
      expect((await call()).json()).toEqual({
        due: 0,
        synced: 0,
        cached: 0,
        failed: 0,
        skipped: 0,
      });
    });
  });

  describe('failures stay with the user they belong to', () => {
    it('one failing user does not stop the others; Google trouble is retried on the next run', async () => {
      await seed({ 1: 60, 2: 90, 3: 120 });
      google.failCals.add(appCal(2));
      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ due: 3, synced: 2, cached: 0, failed: 1, skipped: 0 });
      // User 2 was not marked synced and not flagged, so the next run tries again.
      const conn = (
        await rows<{ status: string; last_error_code: string | null }>(
          'select status, last_error_code from rnd.calendar_connections where user_id = $1',
          [uid(2)],
        )
      )[0]!;
      expect(conn.status).toBe('connected');
      google.failCals.clear();
      const again = await call();
      expect(again.json()).toEqual({ due: 1, synced: 1, cached: 0, failed: 0, skipped: 0 });
    });

    it('a user who needs to reconnect is marked and skipped from then on', async () => {
      await seed({ 1: 60, 2: 90 });
      // User 2's stored token cannot be read (encrypted for somebody else).
      await testDb.admin((c) =>
        c.query(
          'update rnd.calendar_connections set refresh_token_ciphertext = $2 where user_id = $1',
          [uid(2), crypto.encrypt(REFRESH, uid(1))],
        ),
      );
      const res = await call();
      expect(res.json()).toEqual({ due: 2, synced: 1, cached: 0, failed: 0, skipped: 1 });
      const status = (
        await rows<{ status: string }>(
          'select status from rnd.calendar_connections where user_id = $1',
          [uid(2)],
        )
      )[0]!.status;
      expect(status).toBe('needs_reconnect');
      await testDb.admin((c) =>
        c.query(`update rnd.calendar_connections set last_synced_at = now() - interval '2 hours'`),
      );
      expect((await call()).json()).toEqual({
        due: 1,
        synced: 1,
        cached: 0,
        failed: 0,
        skipped: 0,
      });
    });
  });

  describe('overlap and rate limits', () => {
    it('never runs twice at once: the second call answers 409 already_running', async () => {
      await seed({ 1: 60 });
      const held = google.holdInserts();
      const first = call();
      await held.reached;
      const second = await call();
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('already_running');
      held.release();
      const done = await first;
      expect(done.statusCode).toBe(200);
      expect(done.json().synced).toBe(1);
      // The lock is released afterwards.
      expect((await call()).statusCode).toBe(200);
    });

    it('limits calls to six a minute', async () => {
      await seed({ 1: 3 });
      const codes: number[] = [];
      for (let i = 0; i < 8; i += 1) codes.push((await call()).statusCode);
      expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    });

    it('limits bad guesses per IP too (they are never free)', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 8; i += 1)
        codes.push((await call({ authorization: 'Bearer wrong' })).statusCode);
      expect(codes.slice(0, 6).every((c) => c === 401)).toBe(true);
      expect(codes.slice(6)).toEqual([429, 429]);
    });
  });

  describe('isolation and secrecy', () => {
    it('syncing one user never reads or writes another user’s rows', async () => {
      await seed({ 1: 60, 2: 3 });
      await rows(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title, kind)
         values ($1, $3, 'b-event', $2, 600, 660, 'B private', 'busy')`,
        [uid(2), primary(2), today],
      );
      google.put(primary(1), {
        id: 'meet1',
        status: 'confirmed',
        summary: 'Title meet1',
        start: { dateTime: `${today}T11:00:00Z` },
        end: { dateTime: `${today}T12:00:00Z` },
      });
      const snapshot = async () => ({
        busy: await rows('select * from rnd.calendar_busy where user_id = $1 order by 2,3', [
          uid(2),
        ]),
        links: await rows('select * from rnd.calendar_event_links where user_id = $1', [uid(2)]),
        locked: await rows('select * from rnd.calendar_locked_blocks where user_id = $1', [uid(2)]),
        conn: await rows('select * from rnd.calendar_connections where user_id = $1', [uid(2)]),
        sources: await rows('select * from rnd.calendar_sources where user_id = $1', [uid(2)]),
      });
      const before = await snapshot();
      expect((await call()).json().synced).toBe(1);
      expect(await snapshot()).toEqual(before);
      const links = await rows<{ user_id: string }>('select user_id from rnd.calendar_event_links');
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((l) => l.user_id === uid(1))).toBe(true);
    });

    it('the database function returns user ids only', async () => {
      await seed({ 1: 60, 2: 90 });
      const ids = await realDb.dueCalendarUsers(10 * 60_000, 20);
      expect(ids).toEqual([uid(2), uid(1)]);
      const { rows: raw } = await testDb.admin((c) =>
        c.query(`select * from rnd.calendar_users_due('10 minutes', 20)`),
      );
      expect(raw.every((r) => Object.keys(r).join() === 'user_id')).toBe(true);
    });

    it('the response and the logs carry counts only', async () => {
      await seed({ 1: 60, 2: 60 });
      google.put(primary(1), {
        id: 'secret-meet',
        status: 'confirmed',
        summary: 'Title secret-meet',
        start: { dateTime: `${today}T11:00:00Z` },
        end: { dateTime: `${today}T12:00:00Z` },
      });
      google.failCals.add(appCal(2));
      const res = await call();
      expect(Object.keys(res.json()).sort()).toEqual([
        'cached',
        'due',
        'failed',
        'skipped',
        'synced',
      ]);
      const everything = `${res.body}\n${logs.join('\n')}`;
      for (const leak of [
        REFRESH,
        'access-sync',
        'Title ',
        'secret-meet',
        'Big course',
        SECRET,
        uid(1),
        uid(2),
        email(1),
        email(2),
        'ciphertext',
      ]) {
        expect(everything, `leaked ${leak}`).not.toContain(leak);
      }
      // The run itself is logged, with counts.
      expect(logs.some((l) => l.includes('scheduled calendar sync finished'))).toBe(true);
    });

    it('keeps the write guard: only the app calendar is written, other events are untouched', async () => {
      await seed({ 1: 60 });
      const foreign = {
        id: 'foreign1',
        status: 'confirmed',
        summary: 'Title foreign',
        start: { dateTime: `${today}T11:00:00Z` },
        end: { dateTime: `${today}T12:00:00Z` },
      };
      google.put(primary(1), foreign);
      const stored = JSON.stringify(google.get(primary(1), 'foreign1'));
      expect((await call()).json().synced).toBe(1);
      const writes = google.writes();
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) {
        expect(decodeURIComponent(w.path)).toContain(`/calendars/${appCal(1)}/events`);
      }
      expect(JSON.stringify(google.get(primary(1), 'foreign1'))).toBe(stored);
      for (const e of google.live(appCal(1))) {
        const tags = (e.extendedProperties as { private?: Record<string, string> } | undefined)
          ?.private;
        expect(tags).toBeTruthy();
      }
    });
  });

  describe('the user’s auto-sync setting', () => {
    const asUser = async (n: number) => ({
      authorization: `Bearer ${await keys.sign({ sub: uid(n), email: email(n) })}`,
    });
    const put = async (n: number, payload: object) =>
      app.inject({
        method: 'PUT',
        url: '/api/v1/calendar/settings',
        headers: await asUser(n),
        payload,
      });

    it('is on by default, shown in the calendar view, and changed only for the signed-in user', async () => {
      await seed({ 1: 60, 2: 60 });
      const view = await app.inject({
        method: 'GET',
        url: '/api/v1/calendar',
        headers: await asUser(1),
      });
      expect(view.json().autoSync).toBe(true);
      const res = await put(1, { autoSync: false });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoSync).toBe(false);
      expect(
        await rows('select user_id, auto_sync from rnd.calendar_connections order by user_id'),
      ).toEqual([
        { user_id: uid(1), auto_sync: false },
        { user_id: uid(2), auto_sync: true },
      ]);
      // The scheduled sync now skips user 1 and still does user 2.
      expect((await call()).json()).toMatchObject({ due: 1, synced: 1 });
      expect((await put(1, { autoSync: true })).json().autoSync).toBe(true);
    });

    it('rejects a userId or anything else in the body, and a missing value', async () => {
      await seed({ 1: 60, 2: 60 });
      expect((await put(1, { autoSync: false, userId: uid(2) })).statusCode).toBe(400);
      expect((await put(1, { autoSync: 'no' })).statusCode).toBe(400);
      expect((await put(1, {})).statusCode).toBe(400);
      expect(
        await rows('select auto_sync from rnd.calendar_connections where auto_sync = false'),
      ).toEqual([]);
    });

    it('answers 409 when no calendar is connected, and needs a signed-in user', async () => {
      await seed({ 1: 60 });
      await testDb.admin((c) => c.query('delete from rnd.calendar_connections'));
      expect((await put(1, { autoSync: false })).statusCode).toBe(409);
      const anon = await app.inject({
        method: 'PUT',
        url: '/api/v1/calendar/settings',
        payload: { autoSync: false },
      });
      expect(anon.statusCode).toBe(401);
    });
  });
});
