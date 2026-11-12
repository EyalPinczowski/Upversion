import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  APP_EVENT_SOURCE,
  EVENT_COLOR_PALETTE,
  NEUTRAL_COLOR_ID,
  type Block,
} from '@upversion/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { CalendarTokenCrypto } from '../src/calendar-crypto';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { eventIdFor } from '../src/modules/calendar/event-id';
import { syncRepo } from '../src/modules/calendar/sync-repo';
import { createCalendarSync, desiredBlocks } from '../src/modules/calendar/sync';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { GoogleStub, type Raw } from './google-stub';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000001';
const PRIMARY = 'a@example.com';
const WORK = 'work@example.com';
const APP_CAL = 'app-cal@group.calendar.example';
const REFRESH = 'refresh-token-plaintext-0001';
const APP_KEY = Buffer.alloc(32, 7);
const crypto = new CalendarTokenCrypto([{ id: 'v1', key: APP_KEY }]);

// ------------------------------------------------------------------ fixtures

// Plan A starts Sunday 2026-11-01, studies Sunday to Thursday, 7 h a day in 09:00-17:00 minus
// lunch 13:00-14:00, in Jerusalem (UTC+2 in November).
const SUN = '2026-11-01';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const START_CLOCK = '2026-11-01T05:00:00Z'; // Sunday 07:00 local
const minutesLater = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
/** A wall-clock time in Jerusalem in November, as an RFC 3339 string. */
const L = (date: string, hhmm: string) => `${date}T${hhmm}:00+02:00`;
const timed = (id: string, date: string, from: string, to: string, extra: object = {}): Raw => ({
  id,
  status: 'confirmed',
  summary: `Title ${id}`,
  start: { dateTime: L(date, from) },
  end: { dateTime: L(date, to) },
  ...extra,
});

describe('a failed reconnect flag', () => {
  it('cannot replace the answer with a database error that echoes data', async () => {
    const leak = 'Failing row contains (secret-event-title)';
    const ctx = {
      schema: 'rnd',
      client: {
        query: async (sql: string) => {
          if (sql.includes('last_synced_at'))
            return { rows: [{ status: 'connected', last_synced_at: null }] };
          if (sql.includes('refresh_token_ciphertext'))
            return {
              rows: [
                {
                  status: 'connected',
                  app_calendar_id: 'c',
                  refresh_token_ciphertext: 'garbage',
                  sync_timezone: null,
                },
              ],
            };
          return { rows: [] };
        },
      },
    };
    const warnings: string[] = [];
    const sync = createCalendarSync({
      db: { withUser: (_u: string, fn: (c: never) => unknown) => fn(ctx as never) } as never,
      crypto,
      providerFor: () => {
        throw new Error('not reached');
      },
      markNeedsReconnect: async () => {
        throw new Error(leak);
      },
      scheduling: {} as never,
      log: { warn: (o) => warnings.push(JSON.stringify(o)) },
    });
    const error = await sync.syncNow(A).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 409, code: 'calendar_reconnect_required' });
    expect(warnings.join()).not.toContain('secret-event-title');
  });
});

describe('desiredBlocks', () => {
  const task = (title: string) => ({
    title,
    open: true,
    type: 'course',
    estHours: 2,
    url: 'https://example.com/a',
    steps: ['Enrol'],
    colorId: '9',
  });
  const tasks = new Map([
    ['a', { ...task('Course A'), colorId: EVENT_COLOR_PALETTE[0]! }],
    ['b', { ...task('Closed'), open: false, colorId: EVENT_COLOR_PALETTE[1]! }],
  ]);
  const blk = (taskId: string, date: string, start: string, end: string, kind = 'study'): Block =>
    ({
      taskId,
      date,
      start,
      end,
      minutes: Number(end.slice(0, 2)) * 60 - Number(start.slice(0, 2)) * 60,
      kind,
    }) as Block;
  const base = {
    planName: 'My plan',
    tasks,
    locked: [],
    today: MON,
    horizon: '2026-11-15',
    timeZone: 'Asia/Jerusalem',
  };

  it('keys blocks as task:date:ordinal and keeps only open tasks inside the window', () => {
    const out = desiredBlocks({
      ...base,
      blocks: [
        blk('a', MON, '14:00', '17:00'),
        blk('a', MON, '09:00', '12:00'),
        blk('b', MON, '12:00', '13:00'),
        blk('a', SUN, '09:00', '12:00'), // before today
        blk('a', '2026-11-16', '09:00', '12:00'), // after the horizon
      ],
    });
    expect([...out.keys()]).toEqual([`a:${MON}:0`, `a:${MON}:1`]);
    expect(out.get(`a:${MON}:0`)!.start.toISOString()).toBe('2026-11-02T07:00:00.000Z');
    expect(out.get(`a:${MON}:0`)!.summary).toBe('Course: Course A');
    expect(out.get(`a:${MON}:0`)!.colorId).toBe(EVENT_COLOR_PALETTE[0]);
    expect(out.get(`a:${MON}:0`)!.description).toBe(
      'Plan: My plan\nType: Course\nEstimate: 2 h\nLink: https://example.com/a\n\nSteps:\n1. Enrol',
    );
    expect(out.get(`a:${MON}:0`)!.detailHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not reuse the key of a deleted or moved block', () => {
    const lockedRow = (reason: 'moved' | 'deleted') => ({
      block_key: `a:${MON}:0`,
      task_id: 'a',
      starts_at: new Date('2026-11-02T07:00:00Z'),
      ends_at: new Date('2026-11-02T08:00:00Z'),
      reason,
    });
    for (const reason of ['deleted', 'moved'] as const) {
      const out = desiredBlocks({
        ...base,
        locked: [lockedRow(reason)],
        blocks: [blk('a', MON, '14:00', '17:00')],
      });
      expect([...out.keys()]).toEqual([`a:${MON}:1`]);
    }
  });

  it('gives a locked block the key of its locked row', () => {
    const out = desiredBlocks({
      ...base,
      locked: [
        {
          block_key: `a:${MON}:3`,
          task_id: 'a',
          starts_at: new Date('2026-11-02T08:00:00Z'),
          ends_at: new Date('2026-11-02T09:00:00Z'),
          reason: 'moved',
        },
      ],
      blocks: [blk('a', MON, '09:00', '12:00'), blk('a', MON, '10:00', '11:00', 'locked')],
    });
    expect(out.has(`a:${MON}:3`)).toBe(true);
    expect(out.has(`a:${MON}:0`)).toBe(true);
  });
});

describe.skipIf(!dbAvailable)('calendar sync (real Postgres, stub Google)', () => {
  let testDb: TestDb;
  let db: Database;
  let realDb: Database;
  /** Every statement the app ran, for the tests that count them. */
  let statements: string[];
  let keys: TestKeys;
  let google: GoogleStub;
  let app: ReturnType<typeof buildApp>;
  let clock: Date;
  let logs: string[];

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    google = new GoogleStub();
    await google.start();
    realDb = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    statements = [];
    db = {
      ...realDb,
      withUser: (userId, fn) =>
        realDb.withUser(userId, (ctx) =>
          fn({
            ...ctx,
            client: {
              query: ((sql: unknown, ...rest: unknown[]) => {
                if (typeof sql === 'string') statements.push(sql);
                return (ctx.client.query as (...a: unknown[]) => unknown)(sql, ...rest);
              }) as typeof ctx.client.query,
            },
          }),
        ),
    };
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
        },
      }),
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        now: () => clock,
        logStream: { write: (line) => logs.push(line) },
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await realDb?.close();
    await new Promise((r) => google.server.close(r));
  });

  // A saved reschedule starts a sync in the background, after its response. A test must not
  // leave one running: it would hold the per-user lock (409) or stamp last_synced_at on the next
  // test's fresh connection (a cached answer with no busy rows) when the runner is slow.
  const settleBackground = async () => {
    await new Promise((r) => setImmediate(r)); // the onResponse hook runs just after inject()
    await app.calendarSyncIdle();
  };

  beforeEach(async () => {
    await settleBackground();
    clock = new Date(START_CLOCK);
    logs.length = 0;
    statements.length = 0;
    google.seen = [];
    google.cals = new Map();
    google.failWith = null;
    google.failCals = new Set();
    google.hold = null;
    google.grantRevoked = false;
    google.tokensExpired = false;
    google.hardDelete = false;
    google.deletePrecondition = 0;
    google.deleteFailsWith = null;
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
      for (const [user, plan] of [
        [A, PLAN_A],
        [B, PLAN_B],
      ] as const) {
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
           values ($1, $2, 'builder', 'Plan', 'active', $3, '2026-10-30T10:00:00Z')`,
          [user, plan, SUN],
        );
        await c.query(
          `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
             window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
           values ($1, $2, '{0,1,2,3,4}', 7, '09:00', '17:00', '13:00', '14:00', 0, 'Asia/Jerusalem')`,
          [user, plan],
        );
        await c.query(
          `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
           values ($1, $2, 'big', 'Big course', 'course', 20, 0),
                  ($1, $2, 'lk', 'Second task', 'course', 3, 1)`,
          [user, plan],
        );
        await c.query(
          `insert into rnd.calendar_connections (user_id, app_calendar_id, status, refresh_token_ciphertext)
           values ($1, $2, 'connected', $3)`,
          [user, APP_CAL, crypto.encrypt(REFRESH, user)],
        );
        await c.query(
          `insert into rnd.calendar_sources (user_id, calendar_id, name, blocks_time)
           values ($1, $2, 'Personal', true), ($1, $3, 'Work', false)`,
          [user, PRIMARY, WORK],
        );
      }
    });
  });

  afterEach(async () => {
    await settleBackground();
    // Whatever happened, no token and no event title may have reached the logs.
    const all = logs.join('\n');
    for (const secret of [
      REFRESH,
      'access-sync',
      'client-secret-plaintext',
      'Title ',
      'Big course',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  const asUser = async (sub: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email: sub === A ? 'a@example.com' : 'b@example.com' })}`,
  });
  const sync = async (body: object | undefined = {}, user = A) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/calendar/sync',
      headers: await asUser(user),
      ...(body ? { payload: body } : {}),
    });
  /** Moves the clock past the throttle, then syncs. */
  const syncAgain = async (body?: object) => {
    clock = minutesLater(clock, 6);
    return sync(body);
  };
  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);
  const schedule = async (): Promise<{ blocks: Block[] }> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${PLAN_A}/schedule`,
      headers: await asUser(A),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const busy = (user = A) =>
    rows<{
      date: string;
      external_event_id: string;
      start_minute: number;
      end_minute: number;
      title: string;
      kind: string;
      blocks_day: boolean;
      source_calendar_id: string;
    }>(
      `select date::text, external_event_id, start_minute, end_minute, title, kind, blocks_day,
              source_calendar_id from rnd.calendar_busy where user_id = $1
       order by date, external_event_id`,
      [user],
    );
  const links = (user = A) =>
    rows<{
      plan_id: string;
      block_key: string;
      task_id: string;
      event_id: string;
      last_start: Date;
      last_end: Date;
      generation: number;
      last_color: string | null;
      last_detail_hash: string | null;
    }>(
      `select plan_id, block_key, task_id, event_id, last_start, last_end, generation, last_color,
              last_detail_hash
       from rnd.calendar_event_links where user_id = $1 order by block_key`,
      [user],
    );
  const locked = (user = A) =>
    rows<{ block_key: string; task_id: string; starts_at: Date; ends_at: Date; reason: string }>(
      `select block_key, task_id, starts_at, ends_at, reason from rnd.calendar_locked_blocks
       where user_id = $1 order by block_key`,
      [user],
    );
  const connection = async (user = A) =>
    (
      await rows<{
        status: string;
        last_synced_at: Date | null;
        last_error_code: string | null;
        sync_timezone: string | null;
      }>(
        'select status, last_synced_at, last_error_code, sync_timezone from rnd.calendar_connections where user_id = $1',
        [user],
      )
    )[0]!;
  const sourceRow = async (cal = PRIMARY) =>
    (
      await rows<{ sync_token: string | null; window_end: string | null }>(
        `select sync_token, window_end::text from rnd.calendar_sources where user_id = $1 and calendar_id = $2`,
        [A, cal],
      )
    )[0]!;
  const startOf = (e: Raw) => Date.parse((e.start as { dateTime: string }).dateTime);
  const endOf = (e: Raw) => Date.parse((e.end as { dateTime: string }).dateTime);
  const tagsOf = (e: Raw) => (e.extendedProperties as { private: Record<string, string> }).private;

  // -------------------------------------------------------------------------- read side

  describe('reading busy time', () => {
    beforeEach(() => {
      google.put(
        PRIMARY,
        timed('meet1', MON, '11:00', '12:00', {
          description: 'secret-description',
          location: 'secret-location',
          attendees: [{ email: 'guest@example.com', self: true, responseStatus: 'accepted' }],
        }),
      );
      google.put(
        PRIMARY,
        timed('tent', MON, '15:00', '16:00', {
          organizer: { self: false },
          attendees: [{ self: true, responseStatus: 'tentative' }],
        }),
      );
      google.put(PRIMARY, timed('free1', MON, '09:00', '10:00', { transparency: 'transparent' }));
      google.put(
        PRIMARY,
        timed('dec', MON, '10:00', '11:00', {
          organizer: { self: false },
          attendees: [{ self: true, responseStatus: 'declined' }],
        }),
      );
      google.put(
        PRIMARY,
        timed('own', MON, '14:00', '15:00', {
          extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 'big' } },
        }),
      );
      google.put(PRIMARY, {
        id: 'bday',
        status: 'confirmed',
        summary: 'Holiday',
        start: { date: TUE },
        end: { date: '2026-11-04' },
      });
      google.put(WORK, timed('work1', MON, '09:00', '10:00'));
    });

    it('classifies events into calendar_busy and excludes ours, free and declined ones', async () => {
      const res = await sync();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'synced', finishChanged: expect.any(Boolean) });
      const rowsNow = await busy();
      expect(
        rowsNow.map((r) => [r.external_event_id, r.kind, r.start_minute, r.end_minute]),
      ).toEqual([
        ['meet1', 'busy', 660, 720],
        ['tent', 'tentative', 900, 960],
        ['bday', 'all_day', 0, 1440],
      ]);
      expect(rowsNow.every((r) => r.source_calendar_id === PRIMARY)).toBe(true);
      expect(rowsNow.find((r) => r.external_event_id === 'bday')!.blocks_day).toBe(false);
      // Title and times only: nothing from the description, location or attendees is stored.
      const dump = JSON.stringify(await rows('select * from rnd.calendar_busy'));
      for (const secret of ['secret-description', 'secret-location', 'guest@example.com']) {
        expect(dump).not.toContain(secret);
      }
      expect(rowsNow.find((r) => r.external_event_id === 'meet1')!.title).toBe('Title meet1');
    });

    it('subtracts busy time from the schedule', async () => {
      await sync();
      const monday = (await schedule()).blocks.filter((b) => b.date === MON);
      expect(monday.length).toBeGreaterThan(0);
      for (const b of monday) {
        expect(b.start < '12:00' && '11:00' < b.end).toBe(false);
      }
    });

    it('reads only sources that block time, and deletes rows when blocks_time is turned off', async () => {
      await sync();
      expect(google.eventListings(WORK)).toHaveLength(0);
      expect((await busy()).some((r) => r.source_calendar_id === WORK)).toBe(false);

      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/calendar/sources',
        headers: await asUser(A),
        payload: { sources: [{ calendarId: PRIMARY, blocksTime: false }] },
      });
      expect(put.statusCode).toBe(200);
      await syncAgain();
      expect(await busy()).toEqual([]);
      expect((await sourceRow()).sync_token).toBeNull();
    });

    it('uses the stored sync token afterwards and does a full listing again on 410', async () => {
      await sync();
      const token = (await sourceRow()).sync_token;
      expect(token).toMatch(/^tok-/);
      const first = google.eventListings(PRIMARY);
      expect(first.length).toBeGreaterThan(1); // paged
      expect(first[0]!.query.get('timeMin')).not.toBeNull();
      expect(first[0]!.query.get('singleEvents')).toBe('true');

      // Changes since the token: one event added, one cancelled.
      google.put(PRIMARY, timed('meet2', MON, '16:00', '16:30'));
      google.userDelete(PRIMARY, 'meet1');
      google.seen = [];
      await syncAgain();
      const second = google.eventListings(PRIMARY);
      expect(second).toHaveLength(1);
      expect(second[0]!.query.get('syncToken')).toBe(token);
      expect(second[0]!.query.get('timeMin')).toBeNull();
      const ids = (await busy()).map((r) => r.external_event_id).sort();
      expect(ids).toEqual(['bday', 'meet2', 'tent']);

      // The token expires: the next sync falls back to a full listing and the rows stay right.
      google.tokensExpired = true;
      google.put(PRIMARY, timed('meet3', MON, '16:30', '17:00'));
      google.seen = [];
      await syncAgain();
      const third = google.eventListings(PRIMARY);
      expect(third[0]!.query.get('syncToken')).not.toBeNull(); // tried the token first
      expect(third.slice(1).every((s) => s.query.get('syncToken') === null)).toBe(true);
      expect(third.length).toBeGreaterThan(1);
      expect((await busy()).map((r) => r.external_event_id).sort()).toEqual([
        'bday',
        'meet2',
        'meet3',
        'tent',
      ]);
    });

    it('keeps the all-day events the user marked as blocking when rows are replaced', async () => {
      await sync();
      await rows(`update rnd.calendar_busy set blocks_day = true where external_event_id = 'bday'`);
      google.tokensExpired = true; // forces a full replacement
      await syncAgain();
      expect((await busy()).find((r) => r.external_event_id === 'bday')!.blocks_day).toBe(true);
      // And the day is off in the schedule.
      expect((await schedule()).blocks.some((b) => b.date === TUE)).toBe(false);
    });

    it('clears busy rows and reads again when the plan time zone changed', async () => {
      await sync();
      expect((await busy())[0]!.start_minute).toBe(660);
      expect((await connection()).sync_timezone).toBe('Asia/Jerusalem');
      await rows(`update rnd.week_patterns set timezone = 'Asia/Tokyo' where user_id = $1`, [A]);
      google.seen = [];
      await syncAgain();
      const listings = google.eventListings(PRIMARY);
      expect(listings[0]!.query.get('syncToken')).toBeNull(); // a full listing, not a delta
      // 11:00 in Jerusalem is 18:00 in Tokyo.
      const meet = (await busy()).find((r) => r.external_event_id === 'meet1')!;
      expect(meet.start_minute).toBe(18 * 60);
      expect((await connection()).sync_timezone).toBe('Asia/Tokyo');
    });
  });

  // -------------------------------------------------------------------------- write side

  describe('writing study blocks to the app calendar', () => {
    it('creates one tagged event per planned block, with the plan data as its description', async () => {
      await sync();
      const sched = (await schedule()).blocks.filter(
        (b) => b.date >= SUN && b.date <= '2026-11-14',
      );
      const events = google.live(APP_CAL);
      expect(events).toHaveLength(sched.length);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(tagsOf(e)).toMatchObject({ source: APP_EVENT_SOURCE });
        expect(['big', 'lk']).toContain(tagsOf(e).task_id);
        expect(String(e.description)).toMatch(/^Plan: Plan\nType: Course\nEstimate: (20|3) h/);
        expect(['Course: Big course', 'Course: Second task']).toContain(e.summary);
      }
      const l = await links();
      expect(l).toHaveLength(events.length);
      const first = l.find((x) => x.block_key === `big:${SUN}:0`)!;
      expect(first.event_id).toBe(eventIdFor(`${PLAN_A}:big:${SUN}:0:1`));
      expect(google.get(APP_CAL, first.event_id)).toBeDefined();
    });

    it('makes no duplicates and no writes on later syncs', async () => {
      await sync();
      const before = google.live(APP_CAL).length;
      google.seen = [];
      await syncAgain();
      await syncAgain();
      expect(google.live(APP_CAL)).toHaveLength(before);
      expect(google.writes()).toEqual([]);
      expect(await links()).toHaveLength(before);
    });

    it('finishes a retried insert (the event landed, the link did not): same task, no duplicate', async () => {
      const key = `big:${SUN}:0`;
      const id = eventIdFor(`${PLAN_A}:${key}:1`);
      google.put(
        APP_CAL,
        timed(id, SUN, '08:00', '08:30', {
          extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 'big' } },
        }),
      );
      const res = await sync();
      expect(res.statusCode).toBe(200);
      expect(google.live(APP_CAL).filter((e) => e.id === id)).toHaveLength(1);
      const ev = google.get(APP_CAL, id)!;
      expect(startOf(ev)).toBe(Date.parse(L(SUN, '09:00'))); // brought to the planned time
      expect(ev.colorId).toBe(EVENT_COLOR_PALETTE[0]);
      expect((await links()).find((x) => x.block_key === key)!.event_id).toBe(id);
    });

    it('never writes events in the past', async () => {
      clock = new Date('2026-11-01T11:00:00Z'); // Sunday 13:00 local
      await sync();
      expect(google.live(APP_CAL).length).toBeGreaterThan(0);
      for (const e of google.live(APP_CAL)) expect(endOf(e)).toBeGreaterThan(clock.getTime());
    });

    it('patches an event only when its time or title changed', async () => {
      await sync();
      google.seen = [];
      await rows(`update rnd.tasks set title = 'Renamed' where id = 'big'`);
      await syncAgain();
      const writes = google.writes();
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((w) => w.method === 'PATCH')).toBe(true);
      expect(google.live(APP_CAL).filter((e) => e.summary === 'Course: Renamed').length).toBe(
        (await links()).filter((x) => x.task_id === 'big').length,
      );
    });

    it('colours each event by its task position: new events carry the colour, neighbours differ', async () => {
      await sync();
      const events = google.live(APP_CAL);
      const byTask = new Map(events.map((e) => [tagsOf(e).task_id, e.colorId]));
      expect(byTask.get('big')).toBe(EVENT_COLOR_PALETTE[0]);
      expect(byTask.get('lk')).toBe(EVENT_COLOR_PALETTE[1]);
      expect(byTask.get('big')).not.toBe(byTask.get('lk'));
      expect(
        (await links()).every(
          (l) => l.last_color === EVENT_COLOR_PALETTE[l.task_id === 'big' ? 0 : 1],
        ),
      ).toBe(true);
    });

    it('patches an event with no stored or a different colour once, and not again', async () => {
      await sync();
      const l = await links();
      // Events written before colours existed: no colour in Google, none stored.
      for (const e of google.live(APP_CAL)) google.put(APP_CAL, { ...e, colorId: undefined });
      await rows(`update rnd.calendar_event_links set last_color = null where user_id = '${A}'`);
      google.seen = [];
      await syncAgain();
      const writes = google.writes();
      expect(writes).toHaveLength(l.length);
      expect(writes.every((w) => w.method === 'PATCH')).toBe(true);
      const expectColours = (order: Record<string, number>) => {
        const live = google.live(APP_CAL);
        expect(live.length).toBeGreaterThan(0);
        for (const e of live)
          expect(e.colorId).toBe(EVENT_COLOR_PALETTE[order[tagsOf(e).task_id!]!]);
      };
      expectColours({ big: 0, lk: 1 });
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);

      // A changed task order recolours the existing events (one patch each, once).
      await rows(`update rnd.tasks set sort_order = 5 where id = 'big' and plan_id = '${PLAN_A}'`);
      google.seen = [];
      await syncAgain();
      expect(google.writes().length).toBeGreaterThan(0);
      expectColours({ big: 1, lk: 0 });
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);
    });

    it('recolours an existing event found by a retried insert, even when its times are right', async () => {
      await sync();
      const key = `big:${SUN}:0`;
      const link = (await links()).find((x) => x.block_key === key)!;
      // The insert landed but its answer and the link were lost; the event has no colour.
      google.put(APP_CAL, { ...google.get(APP_CAL, link.event_id)!, colorId: undefined });
      await rows(
        `delete from rnd.calendar_event_links where user_id = '${A}' and block_key = '${key}'`,
      );
      google.seen = [];
      await syncAgain();
      expect(google.get(APP_CAL, link.event_id)!.colorId).toBe(EVENT_COLOR_PALETTE[0]);
      expect(google.writes().filter((w) => w.method === 'PATCH')).toHaveLength(1);
      expect((await links()).find((x) => x.block_key === key)!.last_color).toBe(
        EVENT_COLOR_PALETTE[0],
      );
    });

    it('gives the parts of one course (same externalRef) one colour, and practice graphite', async () => {
      await rows(
        `update rnd.tasks set external_ref = 'same-course' where plan_id = '${PLAN_A}' and user_id = '${A}'`,
      );
      await sync();
      const shared = google.live(APP_CAL);
      expect(shared.length).toBeGreaterThan(0);
      for (const e of shared) expect(e.colorId).toBe(EVENT_COLOR_PALETTE[0]);

      await rows(
        `update rnd.tasks set type = 'practice' where id = 'lk' and plan_id = '${PLAN_A}'`,
      );
      google.seen = [];
      await syncAgain();
      for (const e of google.live(APP_CAL)) {
        const lk = tagsOf(e).task_id === 'lk';
        expect(e.colorId).toBe(lk ? NEUTRAL_COLOR_ID : EVENT_COLOR_PALETTE[0]);
        expect(e.summary).toBe(lk ? 'Practice: Second task' : 'Course: Big course');
      }
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);
    });

    it('writes the plan data into the description and patches changed details once', async () => {
      await rows(
        `update rnd.tasks set url = 'https://example.com/big', how_to_steps = '["Enrol","Do week 1"]'
         where id = 'big' and plan_id = '${PLAN_A}'`,
      );
      await sync();
      const big = google.live(APP_CAL).find((e) => tagsOf(e).task_id === 'big')!;
      expect(big.description).toBe(
        'Plan: Plan\nType: Course\nEstimate: 20 h\nLink: https://example.com/big\n\nSteps:\n1. Enrol\n2. Do week 1',
      );
      expect((await links()).every((l) => /^[0-9a-f]{64}$/.test(l.last_detail_hash ?? ''))).toBe(
        true,
      );

      // Events written before descriptions existed: no description in Google, no hash stored.
      for (const e of google.live(APP_CAL)) google.put(APP_CAL, { ...e, description: undefined });
      await rows(
        `update rnd.calendar_event_links set last_detail_hash = null where user_id = '${A}'`,
      );
      const n = (await links()).length;
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toHaveLength(n);
      for (const e of google.live(APP_CAL)) expect(e.description).toContain('Plan: Plan');
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);

      // Editing a detail patches that task's events once.
      await rows(`update rnd.tasks set est_hours = 21 where id = 'big' and plan_id = '${PLAN_A}'`);
      google.seen = [];
      await syncAgain();
      expect(google.writes().length).toBeGreaterThan(0);
      for (const e of google.live(APP_CAL).filter((x) => tagsOf(x).task_id === 'big')) {
        expect(e.description).toContain('Estimate: 21 h');
      }
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);
    });

    describe('one plan at a time', () => {
      const PLAN_NEW = 'a0000000-0000-4000-8000-000000000002';
      const addNewerPlan = () =>
        testDb.admin(async (c) => {
          await c.query(
            `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
             values ($1, $2, 'builder', 'Real plan', 'active', $3, '2026-10-31T10:00:00Z')`,
            [A, PLAN_NEW, SUN],
          );
          await c.query(
            `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
               window_start, window_end, lunch_start, lunch_end, break_minutes, timezone)
             values ($1, $2, '{0,1,2,3,4}', 7, '09:00', '17:00', '13:00', '14:00', 0, 'Asia/Jerusalem')`,
            [A, PLAN_NEW],
          );
          await c.query(
            `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
             values ($1, $2, 'new1', 'New course', 'course', 10, 0)`,
            [A, PLAN_NEW],
          );
        });
      const taskIds = () => new Set(google.live(APP_CAL).map((e) => tagsOf(e).task_id));

      it('writes only the newest created active plan when two are active', async () => {
        await addNewerPlan();
        await sync();
        expect(taskIds()).toEqual(new Set(['new1']));
        expect((await links()).every((l) => l.plan_id === PLAN_NEW)).toBe(true);
        google.seen = [];
        await syncAgain();
        expect(google.writes()).toEqual([]);
      });

      it('removes the older plan events when a newer plan appears, and keeps them out', async () => {
        await sync();
        expect(taskIds()).toEqual(new Set(['big', 'lk']));
        await addNewerPlan();
        await syncAgain();
        expect(taskIds()).toEqual(new Set(['new1']));
        expect((await links()).filter((l) => l.plan_id === PLAN_A)).toEqual([]);
        google.seen = [];
        await syncAgain();
        expect(google.writes()).toEqual([]);
        expect(taskIds()).toEqual(new Set(['new1']));
      });

      it('keeps the link when the delete is refused as a concurrent change, and retries', async () => {
        await sync();
        await addNewerPlan();
        google.deletePrecondition = 1;
        await syncAgain();
        const left = (await links()).filter((l) => l.plan_id === PLAN_A);
        expect(left).toHaveLength(1);
        expect(google.get(APP_CAL, left[0]!.event_id)!.status).toBe('confirmed');
        await syncAgain();
        expect((await links()).filter((l) => l.plan_id === PLAN_A)).toEqual([]);
        expect(taskIds()).toEqual(new Set(['new1']));
      });

      const addOldLink = (eventId: string, lastEnd: string) =>
        rows(
          `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
           values ($1, $2, 'old:1', 'big', $3, $4::timestamptz - interval '1 hour', $4)`,
          [A, PLAN_A, eventId, lastEnd],
        );

      it('never deletes an untagged event of the user, and forgets the link', async () => {
        google.put(APP_CAL, timed('foreignevent1', MON, '09:00', '10:00', { summary: 'Mine' }));
        await addOldLink('foreignevent1', '2026-11-30T10:00:00Z');
        await addNewerPlan();
        await sync();
        expect(google.get(APP_CAL, 'foreignevent1')!.status).toBe('confirmed');
        expect((await links()).filter((l) => l.plan_id === PLAN_A)).toEqual([]);
      });

      it('keeps past events of other plans', async () => {
        google.put(
          APP_CAL,
          timed('pastevent01', SUN, '09:00', '10:00', {
            extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 'big' } },
          }),
        );
        await addOldLink('pastevent01', '2026-10-31T10:00:00Z');
        await addNewerPlan();
        await sync();
        expect(google.get(APP_CAL, 'pastevent01')!.status).toBe('confirmed');
        expect((await links()).filter((l) => l.plan_id === PLAN_A)).toHaveLength(1);
      });

      it('still writes the current plan when removing an old plan event keeps failing', async () => {
        await sync();
        await addNewerPlan();
        google.deleteFailsWith = 503;
        const res = await syncAgain();
        expect(res.statusCode).toBe(503);
        expect(taskIds().has('new1')).toBe(true);
        google.deleteFailsWith = null;
        await syncAgain();
        expect(taskIds()).toEqual(new Set(['new1']));
      });

      it('removes the future events of archived plans when no plan is active any more', async () => {
        await sync();
        expect(taskIds().size).toBeGreaterThan(0);
        await rows(`update rnd.plans set status = 'archived' where id = '${PLAN_A}'`);
        await syncAgain();
        expect(google.live(APP_CAL)).toEqual([]);
        expect((await links()).filter((l) => l.plan_id === PLAN_A)).toEqual([]);
      });

      it('writes the older plan again once it is the newest active plan', async () => {
        await addNewerPlan();
        await sync();
        await rows(`update rnd.plans set status = 'archived' where id = '${PLAN_NEW}'`);
        await syncAgain();
        expect(taskIds()).toEqual(new Set(['big', 'lk']));
      });
    });

    it('deletes events whose block no longer exists', async () => {
      await sync();
      const bigBefore = (await links()).filter((x) => x.task_id === 'big');
      expect(bigBefore.length).toBeGreaterThan(0);
      await rows(`update rnd.tasks set status = 'done' where id = 'big'`);
      await syncAgain();
      expect((await links()).filter((x) => x.task_id === 'big')).toEqual([]);
      expect(google.live(APP_CAL).some((e) => tagsOf(e).task_id === 'big')).toBe(false);
    });

    it('never modifies or deletes a foreign event', async () => {
      // A foreign (untagged) event sits where one of our ids would go, and a stale link points at
      // another foreign event.
      const taken = eventIdFor(`${PLAN_A}:big:${SUN}:0:1`);
      google.put(APP_CAL, timed(taken, SUN, '09:00', '10:00', { summary: 'Not ours' }));
      google.put(APP_CAL, timed('foreignevent1', MON, '09:00', '10:00', { summary: 'Not ours 2' }));
      await rows(
        `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
         values ($1, $2, 'gone:2026-11-02:0', 'gone', 'foreignevent1', $3, $4)`,
        [A, PLAN_A, L(MON, '09:00'), L(MON, '10:00')],
      );
      const res = await sync();
      expect(res.statusCode).toBe(200);
      expect(google.get(APP_CAL, taken)!.summary).toBe('Not ours');
      expect(google.get(APP_CAL, 'foreignevent1')!.summary).toBe('Not ours 2');
      expect(google.get(APP_CAL, 'foreignevent1')!.status).toBe('confirmed');
      const touched = google
        .writes()
        .filter(
          (w) => w.path.endsWith(`/events/${taken}`) || w.path.endsWith('/events/foreignevent1'),
        );
      expect(touched).toEqual([]);
      // Our block still got an event, under the next generation of its id.
      const l = (await links()).find((x) => x.block_key === `big:${SUN}:0`)!;
      expect(l.generation).toBe(2);
      expect(l.event_id).toBe(eventIdFor(`${PLAN_A}:big:${SUN}:0:2`));
    });
  });

  // -------------------------------------------------------------------------- user edits

  describe('edits made in Google Calendar', () => {
    const firstMondayEvent = async () => {
      const l = (await links()).filter((x) => x.block_key.startsWith(`big:${MON}:`));
      return l[0]!;
    };

    it('locks a block the user moved and plans around it', async () => {
      await sync();
      const link = await firstMondayEvent();
      const ev = google.get(APP_CAL, link.event_id)!;
      const shifted = 60 * 60_000;
      google.put(APP_CAL, {
        ...ev,
        start: { dateTime: new Date(startOf(ev) + shifted).toISOString() },
        end: { dateTime: new Date(endOf(ev) + shifted).toISOString() },
      });
      const moved = { start: startOf(ev) + shifted, end: endOf(ev) + shifted };

      expect((await syncAgain()).statusCode).toBe(200);
      const [lock] = await locked();
      expect(lock).toMatchObject({ reason: 'moved', task_id: 'big', block_key: link.block_key });
      expect(lock!.starts_at.getTime()).toBe(moved.start);
      expect(lock!.ends_at.getTime()).toBe(moved.end);
      // The link follows the user's time, and Google's event stays where the user put it.
      expect(
        (await links()).find((x) => x.block_key === link.block_key)!.last_start.getTime(),
      ).toBe(moved.start);
      expect(startOf(google.get(APP_CAL, link.event_id)!)).toBe(moved.start);
      // The scheduler now holds a locked block at the user's time.
      const lockedBlocks = (await schedule()).blocks.filter((b) => b.kind === 'locked');
      expect(lockedBlocks).toHaveLength(1);
      expect(lockedBlocks[0]).toMatchObject({ taskId: 'big', date: MON, start: '10:00' });

      // Stable afterwards: nothing is written, nothing new is locked.
      google.seen = [];
      await syncAgain();
      expect(google.writes()).toEqual([]);
      expect(await locked()).toHaveLength(1);
    });

    for (const hard of [false, true]) {
      it(`treats a deleted block (${hard ? 'gone' : 'cancelled'}) as unavailable time and reschedules around it`, async () => {
        await sync();
        const link = (await links()).filter((x) => x.block_key.startsWith(`big:${TUE}:`))[0]!;
        const slot = { start: link.last_start.getTime(), end: link.last_end.getTime() };
        const hoursBefore = (await schedule()).blocks
          .filter((b) => b.taskId === 'big')
          .reduce((s, b) => s + b.minutes, 0);
        google.hardDelete = hard;
        google.userDelete(APP_CAL, link.event_id);

        expect((await syncAgain()).statusCode).toBe(200);
        const [lock] = await locked();
        expect(lock).toMatchObject({
          reason: 'deleted',
          task_id: 'big',
          block_key: link.block_key,
        });
        expect(lock!.starts_at.getTime()).toBe(slot.start);
        expect((await links()).some((x) => x.block_key === link.block_key)).toBe(false);

        // No block of any task in that slot, and the task still gets all its hours.
        const after = (await schedule()).blocks;
        const startMin = new Date(slot.start).getUTCHours() * 60 + 120; // local = UTC+2
        const endMin = startMin + (slot.end - slot.start) / 60_000;
        const clash = after.filter(
          (b) =>
            b.date === TUE &&
            Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3)) < endMin &&
            startMin < Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3)),
        );
        expect(clash).toEqual([]);
        expect(after.filter((b) => b.taskId === 'big').reduce((s, b) => s + b.minutes, 0)).toBe(
          hoursBefore,
        );
        // The deleted event is not recreated in its old slot.
        expect(
          google.live(APP_CAL).some((e) => startOf(e) === slot.start && endOf(e) === slot.end),
        ).toBe(false);
      });
    }

    it('removes a deleted-block lock when its task is done', async () => {
      await sync();
      const link = (await links()).filter((x) => x.block_key.startsWith(`big:${TUE}:`))[0]!;
      google.userDelete(APP_CAL, link.event_id);
      await syncAgain();
      expect(await locked()).toHaveLength(1);
      await rows(`update rnd.tasks set status = 'done' where id = 'big'`);
      await syncAgain();
      expect(await locked()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------- triggers

  describe('triggers and the throttle', () => {
    it('answers within five minutes from stored data without calling Google', async () => {
      const first = await sync();
      expect(first.json().status).toBe('synced');
      const syncedAt = first.json().syncedAt;
      google.seen = [];

      clock = minutesLater(clock, 2);
      const second = await sync();
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ status: 'cached', syncedAt });
      expect(second.json()).toHaveProperty('movedTaskIds');
      expect(second.json()).toHaveProperty('finishChanged');
      expect(typeof second.json().text).toBe('string');
      expect(google.seen).toEqual([]);

      // force works after a minute, not before.
      clock = minutesLater(new Date(syncedAt), 0.5);
      expect((await sync({ force: true })).json().status).toBe('cached');
      clock = minutesLater(new Date(syncedAt), 2);
      expect((await sync({ force: true })).json().status).toBe('synced');
      expect(google.seen.length).toBeGreaterThan(0);
    });

    it('accepts a request with no body at all', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/calendar/sync',
        headers: await asUser(A),
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects unknown body fields (never a user id) and needs a signed-in user', async () => {
      expect((await sync({ userId: B })).statusCode).toBe(400);
      expect((await sync({ force: 'yes' })).statusCode).toBe(400);
      const anon = await app.inject({ method: 'POST', url: '/api/v1/calendar/sync' });
      expect(anon.statusCode).toBe(401);
    });

    it('answers 409 calendar_not_connected without a connection', async () => {
      await rows('delete from rnd.calendar_connections where user_id = $1', [A]);
      const res = await sync();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('calendar_not_connected');
    });

    it('answers 409 sync_in_progress while a sync is held mid-run, and finishes the first', async () => {
      const held = google.holdInserts();
      const first = sync(); // stops at its first event insert
      await held.reached;
      const second = await sync();
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('sync_in_progress');
      held.release();
      expect((await first).statusCode).toBe(200);
      expect(google.live(APP_CAL).length).toBe((await links()).length); // never doubled
    });

    it('runs another write pass when a reschedule was saved during the sync', async () => {
      const held = google.holdInserts();
      const first = sync();
      await held.reached;
      // Monday becomes a day off while the first sync is still creating events for it.
      const save = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/day-overrides/${MON}`,
        headers: await asUser(A),
        payload: { isStudyDay: false },
      });
      expect(save.statusCode).toBe(200);
      held.release();
      expect((await first).statusCode).toBe(200);
      // No polling: the same request already made the extra pass.
      const onMonday = google
        .live(APP_CAL)
        .filter((e) => new Date(startOf(e)).toISOString().startsWith(MON));
      expect(onMonday).toEqual([]);
    });

    it('waits for a background sync after a saved reschedule until it has finished', async () => {
      const held = google.holdInserts();
      const save = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/day-overrides/${MON}`,
        headers: await asUser(A),
        payload: { isStudyDay: true, hours: 2 },
      });
      expect(save.statusCode).toBe(200);
      await held.reached; // the background run is mid-way, stopped at its first insert
      let settled = false;
      const idle = app.calendarSyncIdle().then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(settled).toBe(false);
      held.release();
      await idle;
      expect(google.live(APP_CAL).length).toBe((await links()).length);
      expect(google.live(APP_CAL).length).toBeGreaterThan(0);
    });

    it('syncs in the background after a saved reschedule, which commits first', async () => {
      await sync();
      const before = google.live(APP_CAL).length;
      google.seen = [];
      clock = minutesLater(clock, 1);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/day-overrides/${MON}`,
        headers: await asUser(A),
        payload: { isStudyDay: false },
      });
      expect(res.statusCode).toBe(200);
      // Saved already; the events catch up in the background: none is left on the day off.
      const onMonday = () =>
        google.live(APP_CAL).filter((e) => new Date(startOf(e)).toISOString().startsWith(MON));
      expect(before).toBeGreaterThan(0);
      await waitFor(async () => expect(onMonday()).toEqual([]));
      // Reads were not repeated for a reschedule.
      expect(google.eventListings(PRIMARY)).toHaveLength(0);
    });
  });

  describe('deleting a task', () => {
    it('removes the events of the deleted task after the response, and keeps the others', async () => {
      await sync();
      expect((await links()).some((x) => x.task_id === 'big')).toBe(true);
      expect(google.live(APP_CAL).some((e) => tagsOf(e).task_id === 'big')).toBe(true);
      clock = minutesLater(clock, 6);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${PLAN_A}/tasks/big`,
        headers: await asUser(A),
      });
      expect(res.statusCode).toBe(204);
      await waitFor(async () => {
        expect(google.live(APP_CAL).some((e) => tagsOf(e).task_id === 'big')).toBe(false);
      });
      expect((await links()).filter((x) => x.task_id === 'big')).toEqual([]);
      expect(google.live(APP_CAL).some((e) => tagsOf(e).task_id === 'lk')).toBe(true);
    });
  });

  describe('changing the start date', () => {
    it('syncs in the background: no event is left before the new start', async () => {
      await sync();
      const before = google
        .live(APP_CAL)
        .filter((e) => startOf(e) < Date.parse(L('2026-11-04', '00:00')));
      expect(before.length).toBeGreaterThan(0);
      clock = minutesLater(clock, 6);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/start-date`,
        headers: await asUser(A),
        payload: { startDate: '2026-11-04' },
      });
      expect(res.statusCode).toBe(200);
      await waitFor(async () => {
        const early = google
          .live(APP_CAL)
          .filter((e) => startOf(e) < Date.parse(L('2026-11-04', '00:00')));
        expect(early).toEqual([]);
      });
      expect(google.live(APP_CAL).length).toBeGreaterThan(0);
    });
  });

  describe('review fixes', () => {
    it('keeps the event of a block the user moved beyond the 14-day window', async () => {
      await sync();
      const link = (await links()).find((x) => x.block_key.startsWith(`big:${MON}:`))!;
      const ev = google.get(APP_CAL, link.event_id)!;
      const far = '2026-12-20'; // a Sunday, a study day, far outside the window
      google.put(APP_CAL, {
        ...ev,
        start: { dateTime: L(far, '10:00') },
        end: { dateTime: L(far, '12:00') },
      });
      expect((await syncAgain()).statusCode).toBe(200);
      expect((await locked())[0]).toMatchObject({ reason: 'moved', block_key: link.block_key });
      expect(google.get(APP_CAL, link.event_id)!.status).not.toBe('cancelled');
      expect(startOf(google.get(APP_CAL, link.event_id)!)).toBe(Date.parse(L(far, '10:00')));
      expect((await links()).some((x) => x.block_key === link.block_key)).toBe(true);
      // And it stays that way.
      await syncAgain();
      expect(google.get(APP_CAL, link.event_id)!.status).not.toBe('cancelled');
    });

    it('does not turn our own lost-response patch into a user move', async () => {
      await sync();
      const link = (await links()).find((x) => x.block_key.startsWith(`big:${MON}:`))!;
      // Google has the planned time; our link still holds an older one (the patch answer was lost).
      await rows(
        `update rnd.calendar_event_links set last_start = last_start - interval '1 hour',
           last_end = last_end - interval '1 hour' where user_id = $1 and block_key = $2`,
        [A, link.block_key],
      );
      google.seen = [];
      expect((await syncAgain()).statusCode).toBe(200);
      expect(await locked()).toEqual([]);
      const fixed = (await links()).find((x) => x.block_key === link.block_key)!;
      expect(fixed.last_start.getTime()).toBe(link.last_start.getTime());
      expect(google.writes()).toEqual([]);
    });

    it('still writes the study blocks when the busy read fails', async () => {
      google.failCals.add(PRIMARY);
      const res = await sync();
      expect(res.statusCode).toBe(503);
      expect(google.live(APP_CAL).length).toBeGreaterThan(0);
      expect((await links()).length).toBe(google.live(APP_CAL).length);
    });

    it('still reads busy time when the write side fails', async () => {
      google.put(PRIMARY, timed('meet1', MON, '11:00', '12:00'));
      google.failCals.add(APP_CAL);
      const res = await sync();
      expect(res.statusCode).toBe(503);
      expect((await busy()).map((r) => r.external_event_id)).toEqual(['meet1']);
    });

    it('syncs after a plan import', async () => {
      google.seen = [];
      const newPlan = 'c0000000-0000-4000-8000-000000000001';
      const demo = JSON.parse(
        readFileSync(
          fileURLToPath(new URL('../../../data/sample-plans/demo-plan.json', import.meta.url)),
          'utf8',
        ),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/plans/import',
        headers: await asUser(A),
        payload: { id: newPlan, ...demo, startDate: SUN, endDate: undefined },
      });
      expect(res.statusCode).toBe(201);
      await waitFor(async () => {
        expect((await links()).some((x) => x.plan_id === newPlan)).toBe(true);
      });
    });

    it('removes stale locks in one statement', async () => {
      await rows(
        `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
         select $1, $2, 'old:' || n, 'big', '2026-10-01T08:00:00Z', '2026-10-01T09:00:00Z', 'deleted'
         from generate_series(1, 4) n`,
        [A, PLAN_A],
      );
      statements.length = 0;
      expect((await sync()).statusCode).toBe(200);
      expect(await locked()).toEqual([]);
      expect(
        statements.filter((q) => /delete from \S*calendar_locked_blocks/.test(q)),
      ).toHaveLength(1);
    });

    it('answers a save with 2xx while Google is down, and the sync after it only logs a code', async () => {
      await sync();
      google.failWith = 503;
      const plan = await app.inject({
        method: 'GET',
        url: `/api/v1/plans/${PLAN_A}`,
        headers: await asUser(A),
      });
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/week-pattern`,
        headers: await asUser(A),
        payload: { ...plan.json().weekPattern, defaultHours: 5 },
      });
      expect(saved.statusCode).toBe(200);
      const task = await app.inject({
        method: 'PATCH',
        url: `/api/v1/plans/${PLAN_A}/tasks/big`,
        headers: await asUser(A),
        payload: { title: 'Renamed while down' },
      });
      expect(task.statusCode).toBe(200);
      await waitFor(async () => {
        expect(logs.join('\n')).toContain('did not finish');
      });
      expect(logs.join('\n')).not.toContain('Renamed while down');
    });
  });

  // -------------------------------------------------------------------------- errors

  describe('errors', () => {
    it('flags the connection when Google rejects the credentials and leaves all data alone', async () => {
      google.put(PRIMARY, timed('meet1', MON, '11:00', '12:00'));
      expect((await sync()).statusCode).toBe(200);
      const busyBefore = await busy();
      const linksBefore = await links();
      expect(busyBefore.length).toBeGreaterThan(0);

      google.grantRevoked = true;
      const res = await syncAgain();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('calendar_reconnect_required');
      expect((await connection()).status).toBe('needs_reconnect');
      expect(await busy()).toEqual(busyBefore);
      expect(await links()).toEqual(linksBefore);

      // A later call answers the same without calling Google.
      google.seen = [];
      const again = await syncAgain();
      expect(again.statusCode).toBe(409);
      expect(google.seen).toEqual([]);
    });

    it('answers 503 with Retry-After when Google cannot be reached, keeps data, and the schedule still works', async () => {
      google.put(PRIMARY, timed('meet1', MON, '11:00', '12:00'));
      await sync();
      const busyBefore = await busy();
      const linksBefore = await links();

      google.failWith = 503;
      const res = await syncAgain();
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.json().error.code).toBe('calendar_unavailable');
      expect((await connection()).last_error_code).toBe('unavailable');
      expect(await busy()).toEqual(busyBefore);
      expect(await links()).toEqual(linksBefore);

      // A reschedule still saves and the schedule still reads, with Google down.
      const save = await app.inject({
        method: 'PUT',
        url: `/api/v1/plans/${PLAN_A}/day-overrides/${TUE}`,
        headers: await asUser(A),
        payload: { isStudyDay: true, capacityHours: 2 },
      });
      expect(save.statusCode).toBe(200);
      expect((await schedule()).blocks.length).toBeGreaterThan(0);
      // The failed background sync was logged without any event data.
      await new Promise((r) => setTimeout(r, 100));
      expect(logs.join('\n')).not.toContain('Title ');
    });

    it('records a short code and changes nothing on an unexpected Google answer', async () => {
      await sync();
      const linksBefore = await links();
      google.failWith = 400;
      const res = await syncAgain();
      expect(res.statusCode).toBe(502);
      expect((await connection()).last_error_code).toBe('google_error');
      expect(await links()).toEqual(linksBefore);
    });
  });

  // -------------------------------------------------------------------------- plan delete

  describe('deleting a plan', () => {
    it('removes the plan’s events from Google first', async () => {
      await sync();
      expect(google.live(APP_CAL).length).toBeGreaterThan(0);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${PLAN_A}`,
        headers: await asUser(A),
      });
      expect(res.statusCode).toBe(204);
      expect(google.live(APP_CAL)).toEqual([]);
      expect(await links()).toEqual([]);
    });

    it('still deletes the plan when Google is down', async () => {
      await sync();
      google.failWith = 503;
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${PLAN_A}`,
        headers: await asUser(A),
      });
      expect(res.statusCode).toBe(204);
      expect(await rows('select 1 from rnd.plans where id = $1', [PLAN_A])).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------- isolation

  describe('AI inputs', () => {
    it('carry no busy-event titles: the briefing built from a plan with busy rows has none', async () => {
      const title = 'ZZ-DISTINCT-BUSY-TITLE';
      await rows(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title, kind)
         values ($1, $2, 'distinct', $3, 660, 720, $4, 'busy')`,
        [A, SUN, PRIMARY, title],
      );
      const headers = await asUser(A);
      const bodies: string[] = [];
      for (const url of [
        `/api/v1/plans/${PLAN_A}/days/${SUN}/briefing`,
        `/api/v1/plans/${PLAN_A}/schedule`,
        `/api/v1/plans/${PLAN_A}/open-tasks`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(200);
        bodies.push(res.body);
      }
      // The busy time did shape the plan ...
      const schedule = JSON.parse(bodies[1]!) as { blocks: Block[] };
      expect(
        schedule.blocks.some((b) => b.date === SUN && b.start < '12:00' && '11:00' < b.end),
      ).toBe(false);
      // ... but its title is nowhere in what feeds prompts or briefings.
      for (const body of bodies) expect(body).not.toContain(title);
    });
  });

  describe('isolation between users', () => {
    it('never touches another user’s calendar rows', async () => {
      google.put(PRIMARY, timed('meet1', MON, '11:00', '12:00'));
      // User B has rows of every kind.
      await rows(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title, kind)
         values ($1, '2026-11-02', 'b-event', $2, 600, 660, 'B private', 'busy')`,
        [B, PRIMARY],
      );
      await rows(
        `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
         values ($1, $2, 'big:2026-11-02:0', 'big', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z', 'moved')`,
        [B, PLAN_B],
      );
      // Same event id and date as A's event, and A's block keys, in B's own rows.
      await rows(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title, kind)
         values ($1, '2026-11-02', 'meet1', $2, 100, 200, 'B same id', 'busy')`,
        [B, PRIMARY],
      );
      await rows(
        `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
         values ($1, $2, 'big:2026-11-01:0', 'big', 'b-event-id', '2026-11-01T07:00:00Z', '2026-11-01T11:00:00Z')`,
        [B, PLAN_B],
      );
      const snapshot = async () => ({
        busy: await busy(B),
        links: await links(B),
        locked: await locked(B),
        conn: await connection(B),
        source: await rows(
          'select * from rnd.calendar_sources where user_id = $1 order by calendar_id',
          [B],
        ),
      });
      const before = await snapshot();
      expect((await sync()).statusCode).toBe(200);
      expect(await snapshot()).toEqual(before);
      // A's own data did get written.
      expect((await busy(A)).length).toBeGreaterThan(0);
      expect((await busy(B)).find((r) => r.external_event_id === 'meet1')!.title).toBe('B same id');
      expect((await links(A)).every((l) => l.plan_id === PLAN_A)).toBe(true);
    });

    it('cannot be pointed at another user’s rows, even by passing their id to the repository', async () => {
      await rows(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title, kind)
         values ($1, '2026-11-02', 'b-event', $2, 600, 660, 'B private', 'busy')`,
        [B, PRIMARY],
      );
      await rows(
        `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
         values ($1, $2, 'k', 'big', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z', 'moved')`,
        [B, PLAN_B],
      );
      const before = { busy: await busy(B), locked: await locked(B) };
      // A's database context, B's id in every call: row-level security leaves B's rows alone.
      await realDb.withUser(A, async (ctx) => {
        await syncRepo.clearAllBusy(ctx, B);
        await syncRepo.dropSources(ctx, B, [PRIMARY]);
        await syncRepo.deleteLockedMany(ctx, B, PLAN_B, ['k']);
        await syncRepo.deleteLocked(ctx, B, PLAN_B, 'k');
        await syncRepo.applySource(ctx, B, PRIMARY, {
          replaceAll: true,
          touchedIds: [],
          rows: [],
          keepFrom: '2099-01-01',
          syncToken: null,
          window: null,
        });
        expect(await syncRepo.activePlans(ctx, B, 5)).toEqual([]);
        expect(await syncRepo.links(ctx, B, PLAN_B)).toEqual([]);
        expect(await syncRepo.locked(ctx, B, PLAN_B)).toEqual([]);
      });
      expect({ busy: await busy(B), locked: await locked(B) }).toEqual(before);
    });
  });
});

/** Polls until the assertion passes (the background sync has no completion signal). */
async function waitFor(check: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
