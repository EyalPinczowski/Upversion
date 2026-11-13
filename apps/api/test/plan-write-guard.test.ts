import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN = 'c0000000-0000-4000-8000-0000000000a1';
const OTHER_ACTIVE = 'c0000000-0000-4000-8000-0000000000a2';
const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S1 = uuid(101);
const S2 = uuid(102);
const S3 = uuid(103);
const DAY = '2026-11-02';
const WEEK = {
  studyWeekdays: [0, 1, 2, 3, 4],
  defaultHours: 3,
  windowStart: '09:00',
  windowEnd: '17:30',
  timezone: 'Asia/Jerusalem',
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Entry {
  /** What the route does on an archived plan. */
  rule: 'guarded' | 'allowed';
  /** The task id the path uses (default c1). */
  task?: string;
  body?: unknown;
}

/**
 * Every write route under /plans/{id} or /plans/{planId}, and what it does on an archived plan
 * (ADR 017 section 4.1). The test fails for a route that is missing here, so a new route cannot
 * skip the decision, and for an entry whose route no longer exists.
 */
const TABLE: Record<string, Entry> = {
  'PUT /api/v1/plans/{id}/week-pattern': { rule: 'guarded', body: WEEK },
  'PUT /api/v1/plans/{id}/start-date': { rule: 'guarded', body: { startDate: '2026-11-10' } },
  'PUT /api/v1/plans/{id}/day-overrides/{date}': { rule: 'guarded', body: { isStudyDay: false } },
  'DELETE /api/v1/plans/{id}/day-overrides/{date}': { rule: 'guarded' },
  'PATCH /api/v1/plans/{planId}/tasks/{taskId}': { rule: 'guarded', body: { title: 'New title' } },
  'DELETE /api/v1/plans/{planId}/tasks/{taskId}': { rule: 'guarded' },
  'POST /api/v1/plans/{planId}/tasks/{taskId}/logs': {
    rule: 'guarded',
    body: { id: uuid(201), date: DAY, hours: 1 },
  },
  'POST /api/v1/plans/{planId}/tasks/{taskId}/complete': { rule: 'guarded' },
  'POST /api/v1/plans/{planId}/tasks/{taskId}/reopen': { rule: 'guarded' },
  'POST /api/v1/plans/{planId}/tasks/{taskId}/skip': { rule: 'guarded' },
  'POST /api/v1/plans/{planId}/tasks/{taskId}/practice/sessions': {
    rule: 'guarded',
    task: 'p4',
    body: { id: uuid(202), channel: 'external' },
  },
  'PUT /api/v1/plans/{planId}/practice/context': { rule: 'guarded', body: { jobDescription: 'x' } },
  'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/messages': {
    rule: 'guarded',
    body: { id: uuid(203), content: 'Hello' },
  },
  'POST /api/v1/plans/{planId}/days/{date}/start': { rule: 'guarded' },
  'POST /api/v1/plans/{planId}/days/{date}/end': { rule: 'guarded' },
  'PUT /api/v1/plans/{planId}/days/{date}/review': {
    rule: 'guarded',
    body: { date: DAY, difficulty: 3, density: 3, energy: 3 },
  },
  'POST /api/v1/plans/{planId}/suggestions/{id}/accept': { rule: 'guarded', body: { option: 0 } },
  'POST /api/v1/plans/{planId}/suggestions/{id}/reject': { rule: 'guarded' },

  // Allowed on an archived plan.
  'DELETE /api/v1/plans/{id}': { rule: 'allowed' },
  'POST /api/v1/plans/{id}/restore': { rule: 'allowed', body: { replacesPlanIds: [OTHER_ACTIVE] } },
  'POST /api/v1/plans/{id}/schedule/preview': { rule: 'allowed', body: {} },
  'POST /api/v1/plans/{planId}/suggestions/{id}/preview': { rule: 'allowed', body: { option: 0 } },
  'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/finish': {
    rule: 'allowed',
    body: { markDone: false },
  },
  'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/abandon': { rule: 'allowed' },
  'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/feedback': {
    rule: 'allowed',
    body: { text: 'I answered every question and kept to the time.', markDone: false },
  },
};

const METHODS = ['post', 'put', 'patch', 'delete'] as const;

describe.skipIf(!dbAvailable)('writes on archived plans (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let clock = new Date('2026-11-02T10:00:00Z');

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    const base = testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 });
    app = buildApp(
      { ...base, features: { ...base.features, planBuilder: true } },
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        now: () => clock,
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  const rows = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(query, params)).rows as T[]);
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
  const statusOf = async (planId: string) =>
    (await rows<{ status: string }>('select status from rnd.plans where id = $1', [planId]))[0]
      ?.status;

  const call = async (
    method: Method,
    url: string,
    payload?: unknown,
    who: { sub: string; email: string } = { sub: A, email: 'a@example.com' },
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await keys.sign(who)}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** A plan with a course, four practice tasks and a week pattern, for the signed-in user. */
  async function seedPlan(planId: string, status: string, user = A) {
    await testDb.admin(async (c) => {
      await c.query(
        `insert into rnd.plans (user_id, id, created_from, name, status, start_date, created_at)
         values ($1, $2, 'builder', 'Plan', $3, '2026-11-01', '2026-10-30T10:00:00Z')`,
        [user, planId, status],
      );
      await c.query(
        `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
           window_start, window_end, timezone)
         values ($1, $2, '{0,1,2,3,4}', 3, '09:00', '17:30', 'Asia/Jerusalem')`,
        [user, planId],
      );
      const task = (taskId: string, order: number, type: string) =>
        c.query(
          `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order,
             practice_kind, how_to_steps, prompt_template)
           values ($1, $2, $3, $4, $5, 2, $6, $7, $8::jsonb, 'Run a mock interview with me.')`,
          [
            user,
            planId,
            taskId,
            `Task ${taskId}`,
            type,
            order,
            type === 'practice' ? 'mock_interview' : null,
            JSON.stringify(type === 'practice' ? ['Prepare', 'Answer', 'Review', 'Note gaps'] : []),
          ],
        );
      await task('c1', 0, 'course');
      for (const [i, t] of ['p1', 'p2', 'p3', 'p4'].entries()) await task(t, i + 1, 'practice');
    });
  }

  beforeEach(async () => {
    clock = new Date('2026-11-02T10:00:00Z');
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
    });
  });

  const concretize = (path: string, entry: Entry, sessionId: string) =>
    path
      .replace(/^\/api\/v1/, '')
      .replace(/^\/plans\/\{(?:id|planId)\}/, `/plans/${PLAN}`)
      .replace('{taskId}', entry.task ?? 'c1')
      .replace('{date}', DAY)
      .replace('{sessionId}', sessionId)
      .replace('{id}', 'sg_00ff');

  it('classifies every write route under /plans/{id} (a new route must be added to the table)', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Partial<Record<string, object>>>;
    };
    const found = Object.entries(doc.paths)
      .filter(([path]) => /^\/api\/v1\/plans\/\{(id|planId)\}/.test(path))
      .flatMap(([path, item]) =>
        METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
    expect(found.filter((key) => !(key in TABLE))).toEqual([]);
    expect(Object.keys(TABLE).filter((key) => !found.includes(key))).toEqual([]);
    expect(found.length).toBeGreaterThanOrEqual(25);
  });

  it('refuses every guarded write with 409 plan_archived and writes nothing', async () => {
    await seedPlan(PLAN, 'active');
    await rows(`update rnd.plans set status = 'archived' where id = $1`, [PLAN]);
    const before = await tableCounts();
    const guarded = Object.entries(TABLE).filter(([, e]) => e.rule === 'guarded');
    expect(guarded.length).toBe(18);
    for (const [key, entry] of guarded) {
      const [method, path] = key.split(' ') as [Method, string];
      const res = await call(method, concretize(path, entry, S1), entry.body);
      expect(res.statusCode, `${key}: ${res.body}`).toBe(409);
      expect(res.json().error.code, key).toBe('plan_archived');
    }
    expect(await tableCounts()).toEqual(before);
  });

  it('allows the routes that must work on an archived plan', async () => {
    await seedPlan(PLAN, 'active');
    // Three sessions that are open when the plan is archived.
    for (const [session, task] of [
      [S1, 'p1'],
      [S2, 'p2'],
      [S3, 'p3'],
    ] as const) {
      const res = await call('POST', `/plans/${PLAN}/tasks/${task}/practice/sessions`, {
        id: session,
        channel: 'external',
      });
      expect(res.statusCode).toBe(201);
    }
    await rows(`update rnd.plans set status = 'archived' where id = $1`, [PLAN]);
    await seedPlan(OTHER_ACTIVE, 'active');

    const run = (key: string, session = S1) => {
      const entry = TABLE[key]!;
      const [method, path] = key.split(' ') as [Method, string];
      return call(method, concretize(path, entry, session), entry.body);
    };
    const preview = await run('POST /api/v1/plans/{id}/schedule/preview');
    expect(preview.statusCode).toBe(200);
    const suggestion = await run('POST /api/v1/plans/{planId}/suggestions/{id}/preview');
    // No such suggestion, but the plan being archived is not why.
    expect(suggestion.json().error.code).not.toBe('plan_archived');
    expect(suggestion.statusCode).toBeLessThan(500);

    const finish = await run(
      'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/finish',
      S1,
    );
    expect([200, 201], finish.body).toContain(finish.statusCode);
    expect(finish.json().session.status).toBe('finished');
    const abandon = await run(
      'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/abandon',
      S2,
    );
    expect([200, 201], abandon.body).toContain(abandon.statusCode);
    expect(abandon.json().session.status).toBe('abandoned');
    const feedback = await run(
      'POST /api/v1/plans/{planId}/practice/sessions/{sessionId}/feedback',
      S3,
    );
    expect([200, 201], feedback.body).toContain(feedback.statusCode);

    // The plan is archived the whole time.
    expect(await statusOf(PLAN)).toBe('archived');
    const restore = await run('POST /api/v1/plans/{id}/restore');
    expect(restore.statusCode, restore.body).toBe(200);
    expect(await statusOf(PLAN)).toBe('active');
    expect(await statusOf(OTHER_ACTIVE)).toBe('archived');

    // Deleting an archived plan works too.
    await rows(`update rnd.plans set status = 'archived' where id = $1`, [PLAN]);
    const deleted = await run('DELETE /api/v1/plans/{id}');
    expect(deleted.statusCode).toBe(204);
    expect(await statusOf(PLAN)).toBeUndefined();
  });

  it('still freezes past days when the archived plan’s progress is read', async () => {
    await seedPlan(PLAN, 'archived');
    clock = new Date('2026-11-05T10:00:00Z');
    expect(await rows('select 1 from rnd.schedule_days')).toHaveLength(0);
    const res = await call('GET', `/plans/${PLAN}/progress`);
    expect(res.statusCode).toBe(200);
    const days = await rows<{ date: string }>('select date from rnd.schedule_days order by date');
    expect(days.length).toBeGreaterThan(0);
    // ...while a write on the same plan is refused.
    const write = await call('PATCH', `/plans/${PLAN}/tasks/c1`, { title: 'x' });
    expect(write.statusCode).toBe(409);
  });

  it('keeps reading an archived plan working', async () => {
    await seedPlan(PLAN, 'archived');
    for (const url of [
      `/plans/${PLAN}`,
      `/plans/${PLAN}/tasks`,
      `/plans/${PLAN}/tasks/c1`,
      `/plans/${PLAN}/schedule`,
      `/plans/${PLAN}/logs`,
      `/plans/${PLAN}/practice/context`,
      `/plans/${PLAN}/days/${DAY}`,
    ]) {
      expect((await call('GET', url)).statusCode, url).toBe(200);
    }
  });

  it.each(['draft', 'done'])('keeps a %s plan writable', async (status) => {
    await seedPlan(PLAN, status);
    const patch = await call('PATCH', `/plans/${PLAN}/tasks/c1`, { title: 'Edited' });
    expect(patch.statusCode, patch.body).toBe(200);
    const week = await call('PUT', `/plans/${PLAN}/week-pattern`, WEEK);
    expect(week.statusCode, week.body).toBe(200);
    const log = await call('POST', `/plans/${PLAN}/tasks/c1/logs`, {
      id: uuid(301),
      date: DAY,
      hours: 1,
    });
    expect(log.statusCode, log.body).toBe(201);
    const session = await call('POST', `/plans/${PLAN}/tasks/p1/practice/sessions`, {
      id: S1,
      channel: 'external',
    });
    expect(session.statusCode, session.body).toBe(201);
    expect((await call('POST', `/plans/${PLAN}/tasks/c1/complete`)).statusCode).toBe(200);
  });

  it('answers 404, not 409, for another user’s archived plan', async () => {
    await seedPlan(PLAN, 'archived');
    const res = await call(
      'PATCH',
      `/plans/${PLAN}/tasks/c1`,
      { title: 'x' },
      {
        sub: B,
        email: 'b@example.com',
      },
    );
    expect(res.statusCode).toBe(404);
  });
});
