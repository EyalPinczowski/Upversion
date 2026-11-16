import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// ADR 018 B2: per-task skill ids (import, builder, GET plan), the goal in plans.summary, import
// archiving the active plan, GET goal-progress and the approve route.

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PLAN = id(1);
const PLAN_2 = id(2);
const PLAN_B = id(3);
const GHOST = id(99);
const CLOCK = '2026-11-01T10:00:00Z';

const demo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../data/sample-plans/demo-plan.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

/** A small plan file: sql 2 h + 1 h, python 2 h, a booking task that builds nothing. */
const task = (taskId: string, order: number, hours: number, extra: object = {}) => ({
  id: taskId,
  title: `Task ${taskId}`,
  type: 'course',
  estHours: hours,
  order,
  ...extra,
});
const planFile = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  name: 'Goal plan',
  startDate: '2026-11-03',
  endDate: '2026-12-15',
  weekPattern: demo.weekPattern,
  skillIds: ['sql', 'python'],
  tasks: [
    task('sql-a', 1, 2, { skillIds: ['sql'] }),
    task('sql-b', 2, 1, { skillIds: ['sql'] }),
    task('py-a', 3, 2, { skillIds: ['python'] }),
    task('book', 4, 1, { type: 'cert_exam', skillIds: [] }),
  ],
  ...extra,
});

const REQUEST = {
  targetRoleIds: ['data-analyst'],
  skillLevels: { sql: 1 },
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

describe.skipIf(!dbAvailable)('goal progress and task skill ids (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;

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
        now: () => new Date(CLOCK),
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  beforeEach(async () => {
    await testDb.admin(async (c) => {
      await c.query('drop trigger if exists fail_task_insert on rnd.tasks');
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

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const call = async (who: 'A' | 'B', method: Method, url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who === 'A' ? await as(A, 'a@example.com') : await as(B, 'b@example.com'),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const rows = <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(query, params)).rows as T[]);
  const count = async (query: string, params: unknown[] = []) =>
    Number((await rows<{ n: string }>(query, params))[0]!.n);

  const importPlan = (
    who: 'A' | 'B',
    planId: string,
    file: object = planFile(),
    extra: Record<string, unknown> = {},
  ) => call(who, 'POST', '/plans/import', { id: planId, ...file, ...extra });
  const importOk = async (planId: string = PLAN, file: object = planFile()) => {
    const res = await importPlan('A', planId, file);
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  const statusOf = async (planId: string) =>
    (await rows<{ status: string }>('select status from rnd.plans where id = $1', [planId]))[0]
      ?.status;
  const done = async (taskId: string, planId: string = PLAN) =>
    expect((await call('A', 'POST', `/plans/${planId}/tasks/${taskId}/complete`)).statusCode).toBe(
      200,
    );
  const progress = async (who: 'A' | 'B' = 'A', planId: string = PLAN) =>
    call(who, 'GET', `/plans/${planId}/goal-progress`);
  const approve = (who: 'A' | 'B', body: Record<string, unknown>) =>
    call(who, 'POST', '/me/level-ups/approve', body);
  const profileSkills = async (user: string) =>
    (
      await rows<{ skills: unknown }>('select skills from rnd.user_profiles where user_id = $1', [
        user,
      ])
    )[0]?.skills;
  const tableCounts = () =>
    testDb.admin(async (c) => {
      const out: Record<string, number> = {};
      for (const t of ['plans', 'tasks', 'events', 'user_profiles']) {
        out[t] = Number((await c.query(`select count(*) as n from rnd.${t}`)).rows[0].n);
      }
      return out;
    });

  describe('task skill ids: import, storage and GET plan', () => {
    it('stores per-task skill ids and returns them, [] included, absent when unknown', async () => {
      const file = planFile();
      file.tasks.push(task('plain', 5, 1)); // no skillIds at all
      const plan = await importOk(PLAN, file);
      const by = Object.fromEntries(
        plan.tasks.map((t: { id: string; skillIds?: string[] }) => [t.id, t.skillIds]),
      );
      expect(by).toEqual({
        'sql-a': ['sql'],
        'sql-b': ['sql'],
        'py-a': ['python'],
        book: [], // a booking task round-trips as an empty list, not as "unknown"
        plain: undefined,
      });
      const stored = await rows<{ id: string; skill_ids: string[] | null }>(
        'select id, skill_ids from rnd.tasks where plan_id = $1 order by id',
        [PLAN],
      );
      expect(Object.fromEntries(stored.map((r) => [r.id, r.skill_ids]))).toEqual({
        book: [],
        plain: null,
        'py-a': ['python'],
        'sql-a': ['sql'],
        'sql-b': ['sql'],
      });
      const again = await call('A', 'GET', `/plans/${PLAN}`);
      expect(again.json().tasks.find((t: { id: string }) => t.id === 'book').skillIds).toEqual([]);
    });

    it('rejects an unknown task skill id with 422 (like plan-level ids), storing nothing', async () => {
      const file = planFile();
      file.tasks[1] = task('sql-b', 2, 1, { skillIds: ['sql', 'not-a-skill'] });
      const before = await tableCounts();
      const res = await importPlan('A', PLAN, file);
      expect(res.statusCode).toBe(422);
      const message = res.json().error.message as string;
      expect(message).toContain('tasks.1.skillIds.1');
      expect(message).toContain('not-a-skill');
      expect(message).not.toContain('Goal plan');
      expect(await tableCounts()).toEqual(before);
    });

    it('drops repeats in a task list and keeps the order', async () => {
      const file = planFile();
      file.tasks[0] = task('sql-a', 1, 2, { skillIds: ['sql', 'python', 'sql'] });
      const plan = await importOk(PLAN, file);
      expect(plan.tasks[0].skillIds).toEqual(['sql', 'python']);
    });

    it('rows from before the migration (skill_ids NULL) read back without the field', async () => {
      await importOk();
      await rows('update rnd.tasks set skill_ids = null where plan_id = $1', [PLAN]);
      const res = await call('A', 'GET', `/plans/${PLAN}`);
      expect(res.statusCode).toBe(200);
      for (const t of res.json().tasks) expect(t).not.toHaveProperty('skillIds');
    });

    it('the builder stores the catalog skills of every task it writes', async () => {
      const draft = (await call('A', 'POST', '/plans/build/preview', REQUEST)).json();
      const res = await call('A', 'POST', '/plans/build', {
        id: PLAN,
        request: REQUEST,
        draftHash: draft.draftHash,
        replacesPlanIds: [],
      });
      expect(res.statusCode).toBe(201);
      const builderTasks = res.json().tasks as { externalRef?: string; skillIds?: string[] }[];
      expect(builderTasks.length).toBeGreaterThan(0);
      const fromCatalog = builderTasks.filter((t) => t.externalRef?.startsWith('catalog:'));
      expect(fromCatalog.length).toBeGreaterThan(0);
      for (const t of fromCatalog) {
        const item = BUNDLED_CATALOG.items.find((i) => `catalog:${i.id}` === t.externalRef)!;
        expect(Array.isArray(t.skillIds)).toBe(true);
        // A booking task is stored as [] (builds no skill), the item's own task as its skills.
        expect(new Set(t.skillIds)).toEqual(
          t.skillIds!.length === 0 ? new Set() : new Set(item.skills),
        );
      }
      expect(fromCatalog.some((t) => t.skillIds!.length > 0)).toBe(true);
    });
  });

  describe('the goal in plans.summary', () => {
    const GOAL_KEYS = ['createdFrom', 'deadline', 'skillIds', 'startLevels', 'targetRoleIds'];

    it('import writes a goal of ids and numbers only', async () => {
      const plan = await importOk();
      expect(plan.summary.goal).toEqual({
        targetRoleIds: [],
        skillIds: ['sql', 'python'],
        startLevels: {},
        deadline: '2026-12-15',
        createdFrom: 'import',
      });
      expect(Object.keys(plan.summary.goal).sort()).toEqual(GOAL_KEYS);
    });

    it('import without plan-level skill ids takes the skills of the tasks; none at all: no goal', async () => {
      const noPlanIds = await importOk(PLAN, planFile({ skillIds: undefined }));
      expect(noPlanIds.summary.goal.skillIds).toEqual(['sql', 'python']);
      const bare = planFile({ skillIds: undefined });
      bare.tasks = [task('x', 1, 1)];
      const res = await importPlan('A', PLAN_2, bare, { status: 'draft' });
      expect(res.statusCode).toBe(201);
      expect(res.json().summary).not.toHaveProperty('goal');
    });

    it('the builder writes the goal with the request’s roles, levels and deadline', async () => {
      const draft = (await call('A', 'POST', '/plans/build/preview', REQUEST)).json();
      const res = await call('A', 'POST', '/plans/build', {
        id: PLAN,
        request: REQUEST,
        draftHash: draft.draftHash,
        replacesPlanIds: [],
      });
      expect(res.statusCode).toBe(201);
      const goal = res.json().summary.goal;
      expect(Object.keys(goal).sort()).toEqual(GOAL_KEYS);
      expect(goal).toMatchObject({
        targetRoleIds: ['data-analyst'],
        deadline: '2026-12-15',
        createdFrom: 'builder',
      });
      expect(goal.skillIds.length).toBeGreaterThan(0);
      expect(goal.startLevels).toEqual({ sql: 1 });
      // Canary: nothing but ids and small numbers; no title, name or free text.
      expect(JSON.stringify(goal)).not.toMatch(/plan|Plan|title/);
    });
  });

  describe('import archives the active plan (ADR 018 Q2)', () => {
    it('archives the confirmed active plan in the same transaction and records why', async () => {
      await importOk(PLAN);
      const res = await importPlan('A', PLAN_2, planFile(), { replacesPlanIds: [PLAN] });
      expect(res.statusCode).toBe(201);
      expect(await statusOf(PLAN)).toBe('archived');
      expect(await statusOf(PLAN_2)).toBe('active');
      const events = await rows<{ plan_id: string; payload: unknown }>(
        `select plan_id, payload from rnd.events where type = 'plan.archived'`,
      );
      expect(events).toEqual([{ plan_id: PLAN, payload: { by: 'import', replacedBy: PLAN_2 } }]);
    });

    it('409 active_plan_changed when the confirm is missing or different; nothing is written', async () => {
      await importOk(PLAN);
      const before = await tableCounts();
      for (const extra of [{}, { replacesPlanIds: [] }, { replacesPlanIds: [GHOST] }]) {
        const res = await importPlan('A', PLAN_2, planFile(), extra);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('active_plan_changed');
      }
      expect(await tableCounts()).toEqual(before);
      expect(await statusOf(PLAN)).toBe('active');
    });

    it('another user’s plan id in replacesPlanIds is just a mismatch: it is never touched', async () => {
      expect((await importPlan('B', PLAN_B)).statusCode).toBe(201);
      const res = await importPlan('A', PLAN, planFile(), { replacesPlanIds: [PLAN_B] });
      // A has no active plan, so [PLAN_B] is not the set A could have confirmed.
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('active_plan_changed');
      expect(await statusOf(PLAN_B)).toBe('active');
      expect(await statusOf(PLAN)).toBeUndefined();
    });

    it('with no active plan, an omitted confirm is fine and archives nothing', async () => {
      expect((await importPlan('A', PLAN)).statusCode).toBe(201);
      expect(await count(`select count(*) as n from rnd.events where type = 'plan.archived'`)).toBe(
        0,
      );
    });

    it('a draft import neither archives nor needs the confirm', async () => {
      await importOk(PLAN);
      const res = await importPlan('A', PLAN_2, planFile(), { status: 'draft' });
      expect(res.statusCode).toBe(201);
      expect(await statusOf(PLAN)).toBe('active');
      expect(await statusOf(PLAN_2)).toBe('draft');
    });

    it('is idempotent: the retry answers 200 and archives nothing again', async () => {
      await importOk(PLAN);
      const body = { replacesPlanIds: [PLAN] };
      expect((await importPlan('A', PLAN_2, planFile(), body)).statusCode).toBe(201);
      const retry = await importPlan('A', PLAN_2, planFile(), body);
      expect(retry.statusCode).toBe(200);
      // A retry with the (now stale) old confirm, or none, still answers from the stored plan.
      expect((await importPlan('A', PLAN_2, planFile())).statusCode).toBe(200);
      expect(await count(`select count(*) as n from rnd.events where type = 'plan.archived'`)).toBe(
        1,
      );
      expect(await statusOf(PLAN_2)).toBe('active');
    });

    it('rolls the archive back when the insert fails', async () => {
      await importOk(PLAN);
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
      const res = await importPlan('A', PLAN_2, planFile(), { replacesPlanIds: [PLAN] });
      expect(res.statusCode).toBe(500);
      expect(await statusOf(PLAN)).toBe('active');
      expect(await statusOf(PLAN_2)).toBeUndefined();
    });

    it('two imports racing on one active plan: exactly one wins', async () => {
      await importOk(PLAN);
      const [r1, r2] = await Promise.all([
        importPlan('A', PLAN_2, planFile(), { replacesPlanIds: [PLAN] }),
        importPlan('A', id(4), planFile(), { replacesPlanIds: [PLAN] }),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
      expect(await count(`select count(*) as n from rnd.plans where status = 'active'`)).toBe(1);
    });
  });

  describe('GET /plans/:id/goal-progress', () => {
    it('needs a token', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/plans/${PLAN}/goal-progress` });
      expect(res.statusCode).toBe(401);
    });

    it('404 for another user’s plan and for one that does not exist; same body for both', async () => {
      await importOk(PLAN);
      const other = await progress('B', PLAN);
      const ghost = await progress('B', GHOST);
      expect(other.statusCode).toBe(404);
      expect(ghost.statusCode).toBe(404);
      const strip = (r: typeof other) => ({ ...r.json().error, requestId: undefined });
      expect(strip(other)).toEqual(strip(ghost));
    });

    it('rejects a user id in the query and a bad plan id', async () => {
      await importOk(PLAN);
      const withUser = await call('A', 'GET', `/plans/${PLAN}/goal-progress?userId=${B}`);
      expect(withUser.statusCode).toBe(400);
      expect((await call('A', 'GET', '/plans/nope/goal-progress')).statusCode).toBe(400);
    });

    it('reports the goal, coverage per skill and no suggestion at the start; writes nothing', async () => {
      await importOk(PLAN);
      const before = await tableCounts();
      const res = await progress();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ planId: PLAN, planStatus: 'active', suggestions: [] });
      expect(body.goal.skillIds).toEqual(['sql', 'python']);
      expect(body.progress.label).toBe('plan coverage');
      const sql = body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql');
      expect(sql).toMatchObject({
        plannedHours: 3,
        doneHours: 0,
        tasksTotal: 2,
        status: 'not_started',
      });
      // The booking task builds nothing: its hour is reported as unattributed, not hidden.
      expect(body.progress).toMatchObject({ unattributedHours: 1, unattributedTasks: 1 });
      expect(await tableCounts()).toEqual(before);
    });

    it('suggests one level up once every task of a skill is done, and still writes nothing', async () => {
      await importOk(PLAN);
      await done('sql-a');
      expect((await progress()).json().suggestions).toEqual([]); // sql-b is still open
      await done('sql-b');
      const before = await tableCounts();
      const body = (await progress()).json();
      expect(body.suggestions).toEqual([
        {
          skillId: 'sql',
          fromLevel: 0,
          toLevel: 1,
          reason: 'all_tasks_done',
          tasksDone: 2,
          practice: null,
        },
      ]);
      expect(await tableCounts()).toEqual(before);
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('uses the user’s profile level over the goal’s start level', async () => {
      await importOk(PLAN);
      await rows(`insert into rnd.user_profiles (user_id, skills) values ($1, $2::jsonb)`, [
        A,
        JSON.stringify([{ skillId: 'sql', level: 1, source: 'setup' }]),
      ]);
      await done('sql-a');
      await done('sql-b');
      const body = (await progress()).json();
      expect(body.suggestions).toMatchObject([{ skillId: 'sql', fromLevel: 1, toLevel: 2 }]);
      expect(body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql').level).toBe(
        1,
      );
    });

    it('reads practice scores as evidence only: they never create a suggestion', async () => {
      await importOk(PLAN);
      await rows(
        `insert into rnd.practice_sessions
           (user_id, id, plan_id, task_id, practice_kind, persona, channel, planned_minutes, prompt_used)
         values ($1, $2, $3, 'sql-a', 'sql', 'coach', 'self', 15, 'p')`,
        [A, id(50), PLAN],
      );
      await rows(
        `insert into rnd.practice_feedback (user_id, session_id, source, score)
         values ($1, $2, 'self_rubric', 8)`,
        [A, id(50)],
      );
      const body = (await progress()).json();
      const sql = body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql');
      expect(sql.practice).toEqual({ average: 8, count: 1 });
      expect(body.suggestions).toEqual([]);
    });

    it('an old plan (no goal key, NULL task skills) falls back to the summary skill ids and the catalog', async () => {
      const item = BUNDLED_CATALOG.items.find((i) => i.skills.includes('sql'))!;
      const file = planFile({ skillIds: ['sql'] });
      file.tasks = [task('cat', 1, 2, { externalRef: `catalog:${item.id}`, source: 'builder' })];
      await importOk(PLAN, file);
      await rows(`update rnd.plans set summary = summary - 'goal' where id = $1`, [PLAN]);
      await rows(`update rnd.tasks set skill_ids = null where plan_id = $1`, [PLAN]);
      const body = (await progress()).json();
      expect(body.goal).toMatchObject({ skillIds: ['sql'], startLevels: {} });
      const sql = body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql');
      expect(sql.plannedHours).toBeGreaterThan(0);
    });

    it('a plan that names no skill answers 200 with goal and progress null', async () => {
      const bare = planFile({ skillIds: undefined });
      bare.tasks = [task('x', 1, 1)];
      await importOk(PLAN, bare);
      const body = (await progress()).json();
      expect(body).toMatchObject({ goal: null, progress: null, suggestions: [] });
    });

    it('an archived plan can be read, with progress but no suggestions', async () => {
      await importOk(PLAN);
      await done('sql-a');
      await done('sql-b');
      expect(
        (await importPlan('A', PLAN_2, planFile(), { replacesPlanIds: [PLAN] })).statusCode,
      ).toBe(201);
      const body = (await progress('A', PLAN)).json();
      expect(body.planStatus).toBe('archived');
      expect(body.suggestions).toEqual([]);
      expect(
        body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql').status,
      ).toBe('done');
    });
  });

  describe('POST /me/level-ups/approve', () => {
    const SQL_UP = { planId: PLAN, skillId: 'sql', toLevel: 1 };
    const finishSql = async () => {
      await importOk(PLAN);
      await done('sql-a');
      await done('sql-b');
    };

    it('needs a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/level-ups/approve',
        payload: SQL_UP,
      });
      expect(res.statusCode).toBe(401);
    });

    it('writes the one profile skill with source manual, and the suggestion is gone', async () => {
      await finishSql();
      const res = await approve('A', SQL_UP);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ skillId: 'sql', fromLevel: 0, level: 1, source: 'manual' });
      expect(await profileSkills(A)).toEqual([{ skillId: 'sql', level: 1, source: 'manual' }]);
      const body = (await progress()).json();
      // One suggestion per plan and skill: the approved skill is not offered again.
      expect(body.suggestions).toEqual([]);
      expect(body.progress.skills.find((s: { skillId: string }) => s.skillId === 'sql').level).toBe(
        1,
      );
      expect(
        await count(`select count(*) as n from rnd.events where type = 'level_up.approved'`),
      ).toBe(1);
    });

    it('replaces an existing profile entry of that skill and keeps the others', async () => {
      await finishSql();
      await rows(`insert into rnd.user_profiles (user_id, skills) values ($1, $2::jsonb)`, [
        A,
        JSON.stringify([
          { skillId: 'python', level: 2, source: 'cv' },
          { skillId: 'sql', level: 0, source: 'cv' },
        ]),
      ]);
      expect((await approve('A', SQL_UP)).statusCode).toBe(200);
      expect(await profileSkills(A)).toEqual([
        { skillId: 'python', level: 2, source: 'cv' },
        { skillId: 'sql', level: 1, source: 'manual' },
      ]);
    });

    it('a second approve of the same level is 409 (no longer suggested) and changes nothing', async () => {
      await finishSql();
      expect((await approve('A', SQL_UP)).statusCode).toBe(200);
      const before = await tableCounts();
      const again = await approve('A', SQL_UP);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('not_suggested');
      expect(await tableCounts()).toEqual(before);
    });

    it('one suggestion per plan and skill: after 0 -> 1 there is no 1 -> 2 for the same tasks', async () => {
      await finishSql();
      expect((await approve('A', SQL_UP)).statusCode).toBe(200);
      const next = await approve('A', { ...SQL_UP, toLevel: 2 });
      expect(next.statusCode).toBe(409);
      expect(next.json().error.code).toBe('not_suggested');
      expect((await approve('A', { ...SQL_UP, toLevel: 3 })).statusCode).toBe(400);
      expect(await profileSkills(A)).toEqual([{ skillId: 'sql', level: 1, source: 'manual' }]);
    });

    it('a draft plan suggests nothing and approve answers 409 not_suggested', async () => {
      expect((await importPlan('A', PLAN, planFile(), { status: 'draft' })).statusCode).toBe(201);
      await done('sql-a');
      await done('sql-b');
      expect((await progress()).json().suggestions).toEqual([]);
      const res = await approve('A', SQL_UP);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_suggested');
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('the task share lock: a reopen that commits just before the write wins (409, nothing written)', async () => {
      await finishSql();
      const holder = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
      await holder.connect();
      try {
        await holder.query('begin');
        await holder.query(
          `update rnd.tasks set status = 'pending', done_hours = 0 where plan_id = $1 and id = 'sql-b'`,
          [PLAN],
        );
        const pending = approve('A', SQL_UP);
        await new Promise((r) => setTimeout(r, 500));
        await holder.query('commit');
        const res = await pending;
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('not_suggested');
      } finally {
        await holder.end();
      }
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('404 for another user’s plan and for a missing plan: nothing is written for anyone', async () => {
      await finishSql();
      const before = await tableCounts();
      const other = await approve('B', SQL_UP);
      const ghost = await approve('B', { ...SQL_UP, planId: GHOST });
      expect(other.statusCode).toBe(404);
      expect(ghost.statusCode).toBe(404);
      const strip = (r: typeof other) => ({ ...r.json().error, requestId: undefined });
      expect(strip(other)).toEqual(strip(ghost));
      expect(await tableCounts()).toEqual(before);
      expect(await profileSkills(A)).toBeUndefined();
      expect(await profileSkills(B)).toBeUndefined();
    });

    it('a user id in the body is refused (400), as is anything else unknown', async () => {
      await finishSql();
      for (const extra of [{ userId: B }, { user_id: B }, { source: 'cv' }, { level: 2 }]) {
        const res = await approve('A', { ...SQL_UP, ...extra });
        expect(res.statusCode).toBe(400);
      }
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('refuses levels outside 1..2 and malformed ids (400)', async () => {
      await finishSql();
      for (const bad of [
        { toLevel: 0 },
        { toLevel: 3 },
        { toLevel: 1.5 },
        { toLevel: '1' },
        { skillId: 'SQL' },
        { skillId: '' },
        { planId: 'nope' },
      ]) {
        expect((await approve('A', { ...SQL_UP, ...bad })).statusCode, JSON.stringify(bad)).toBe(
          400,
        );
      }
    });

    it('409 for a level that is not the suggested one (a jump), nothing written', async () => {
      await finishSql();
      const res = await approve('A', { ...SQL_UP, toLevel: 2 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_suggested');
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('409 for a stale suggestion: a task was reopened after the client read the suggestion', async () => {
      await finishSql();
      expect((await progress()).json().suggestions).toHaveLength(1);
      expect((await call('A', 'POST', `/plans/${PLAN}/tasks/sql-b/reopen`)).statusCode).toBe(200);
      const res = await approve('A', SQL_UP);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_suggested');
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('409 for a skill that is not in the plan’s goal, or whose tasks are not all done', async () => {
      await finishSql();
      for (const skillId of ['python', 'excel', 'not-a-skill']) {
        const res = await approve('A', { ...SQL_UP, skillId });
        expect(res.statusCode, skillId).toBe(409);
      }
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('409 when the profile level is already at the cap (2): never suggested above comfortable', async () => {
      await finishSql();
      await rows(`insert into rnd.user_profiles (user_id, skills) values ($1, $2::jsonb)`, [
        A,
        JSON.stringify([{ skillId: 'sql', level: 2, source: 'setup' }]),
      ]);
      for (const toLevel of [1, 2]) {
        expect((await approve('A', { ...SQL_UP, toLevel })).statusCode).toBe(409);
      }
      expect(await profileSkills(A)).toEqual([{ skillId: 'sql', level: 2, source: 'setup' }]);
    });

    it('an archived plan is read-only: 409 plan_archived, nothing written', async () => {
      await finishSql();
      expect(
        (await importPlan('A', PLAN_2, planFile(), { replacesPlanIds: [PLAN] })).statusCode,
      ).toBe(201);
      const res = await approve('A', SQL_UP);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('plan_archived');
      expect(await profileSkills(A)).toBeUndefined();
    });

    it('409 profile_skills_full when a new skill would be the 61st', async () => {
      await finishSql();
      const sixty = Array.from({ length: 60 }, (_, i) => ({
        skillId: `other-${i}`,
        level: 1,
        source: 'cv',
      }));
      await rows(`insert into rnd.user_profiles (user_id, skills) values ($1, $2::jsonb)`, [
        A,
        JSON.stringify(sixty),
      ]);
      const res = await approve('A', SQL_UP);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('profile_skills_full');
      expect(await profileSkills(A)).toEqual(sixty);
    });
  });
});
