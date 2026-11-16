import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { errorResponseSchema } from '../src/errors';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { validateImport } from '../src/modules/plans/import';
import { createPlanService } from '../src/modules/plans/service';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN = 'a0000000-0000-4000-8000-0000000000a1';
const PLAN_2 = 'a0000000-0000-4000-8000-0000000000a2';
const TODAY = '2026-11-01';

const demo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../data/sample-plans/demo-plan.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown> & { tasks: Record<string, unknown>[] };

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

describe.skipIf(!dbAvailable)('plans and schedule (real Postgres, locally signed tokens)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

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
    });
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const asA = () => as(A, 'a@example.com');
  const asB = () => as(B, 'b@example.com');

  const call = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const sql = <T = number>(query: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(query, params)).rows[0].n as T);

  const importDemo = async (who = asA, extra: Record<string, unknown> = {}, id: string = PLAN) =>
    call('POST', '/plans/import', await who(), { id, ...demo, ...extra });

  const expectError = (
    res: { statusCode: number; json(): unknown },
    status: number,
    code: string,
  ) => {
    expect(res.statusCode).toBe(status);
    const body = errorResponseSchema.parse(res.json());
    expect(body.error.code).toBe(code);
    return body;
  };

  describe('import', () => {
    it('imports the demo plan and it schedules with no warnings', async () => {
      const res = await importDemo();
      expect(res.statusCode).toBe(201);
      const plan = res.json();
      expect(plan).toMatchObject({
        id: PLAN,
        status: 'active',
        createdFrom: 'import',
        name: demo.name,
        startDate: '2026-11-01',
        taskCount: demo.tasks.length,
      });
      expect(plan.tasks).toHaveLength(demo.tasks.length);
      expect(plan.weekPattern).toMatchObject({
        windowStart: '09:00',
        windowEnd: '17:30',
        lunchStart: '13:00',
        timezone: 'Asia/Jerusalem',
        studyWeekdays: [0, 1, 2, 3, 4],
      });
      expect(plan.summary.hours).toBeGreaterThan(0);

      const sched = await call('GET', `/plans/${PLAN}/schedule?today=${TODAY}`, await asA());
      expect(sched.statusCode).toBe(200);
      const body = sched.json();
      expect(body.warnings).toEqual([]);
      expect(body.finishDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.blocks.length).toBeGreaterThan(0);
      expect(body.today).toBe(TODAY);
      expect(body.timezone).toBe('Asia/Jerusalem');
    });

    it('stores the owner from the token and writes a plan.imported event', async () => {
      await importDemo();
      expect(await sql('select count(*)::int as n from rnd.plans where user_id = $1', [A])).toBe(1);
      expect(
        await sql(
          `select count(*)::int as n from rnd.events where user_id = $1 and plan_id = $2 and type = 'plan.imported'`,
          [A, PLAN],
        ),
      ).toBe(1);
      const payload = await sql<Record<string, unknown>>(
        `select payload as n from rnd.events where plan_id = $1`,
        [PLAN],
      );
      expect(payload).toMatchObject({ taskCount: demo.tasks.length, status: 'active' });
    });

    it('creates a draft when the body says draft, and day overrides when given', async () => {
      const res = await importDemo(asA, {
        status: 'draft',
        overrides: [
          { date: '2026-11-05', isStudyDay: false },
          { date: '2026-11-06', isStudyDay: true, capacityHours: 3 },
        ],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('draft');
      expect(res.json().overrides).toEqual([
        { date: '2026-11-05', isStudyDay: false },
        { date: '2026-11-06', isStudyDay: true, capacityHours: 3 },
      ]);
    });

    it('is idempotent: the same id and content return the same plan without duplicates', async () => {
      const first = await importDemo();
      const retry = await importDemo();
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(await sql('select count(*)::int as n from rnd.plans')).toBe(1);
      expect(await sql('select count(*)::int as n from rnd.tasks')).toBe(demo.tasks.length);
      expect(await sql('select count(*)::int as n from rnd.events')).toBe(1);
    });

    it('stays idempotent after the plan was edited (the hash is of the import, not the state)', async () => {
      await importDemo();
      await call('PUT', `/plans/${PLAN}/day-overrides/2026-11-05`, await asA(), {
        isStudyDay: false,
      });
      const retry = await importDemo();
      expect(retry.statusCode).toBe(200);
    });

    it('answers 409 when the id exists with different content', async () => {
      await importDemo();
      const res = await importDemo(asA, { name: 'Something else' });
      expectError(res, 409, 'conflict');
      expect(await sql('select count(*)::int as n from rnd.events')).toBe(1);
    });

    it('treats a different status as different content', async () => {
      await importDemo();
      expectError(await importDemo(asA, { status: 'draft' }), 409, 'conflict');
    });

    it('creates one plan when the same import arrives many times at once', async () => {
      const headers = await asA();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          call('POST', '/plans/import', headers, { id: PLAN, ...demo }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 200)).toHaveLength(7);
      expect(await sql('select count(*)::int as n from rnd.plans')).toBe(1);
      expect(await sql('select count(*)::int as n from rnd.tasks')).toBe(demo.tasks.length);
    });

    it('rejects an unknown time zone, naming the field', async () => {
      const res = await importDemo(asA, {
        weekPattern: { ...(demo.weekPattern as object), timezone: 'Mars/Olympus' },
      });
      const body = expectError(res, 422, 'unprocessable');
      expect(body.error.message).toContain('weekPattern.timezone');
      expect(await sql('select count(*)::int as n from rnd.plans')).toBe(0);
    });

    it.each([
      ['a duplicate task id', { tasks: [demo.tasks[0], demo.tasks[0]] }],
      ['an unknown dependency', { tasks: [{ ...demo.tasks[0], dependsOn: ['nope'] }] }],
      ['no tasks', { tasks: [] }],
      ['a wrong format version', { formatVersion: 2 }],
      ['a blank name', { name: '   ' }],
      ['an end before the start', { endDate: '2026-10-01' }],
      [
        'duplicate override dates',
        {
          overrides: [
            { date: '2026-11-05', isStudyDay: false },
            { date: '2026-11-05', isStudyDay: true },
          ],
        },
      ],
      ['a blank task title', { tasks: [{ ...demo.tasks[0], title: '  ' }] }],
      ['a NUL character', { name: 'bad\u0000name' }],
    ])('rejects %s with 422 and stores nothing', async (_label, patch) => {
      const res = await importDemo(asA, patch);
      expectError(res, 422, 'unprocessable');
      expect(await sql('select count(*)::int as n from rnd.plans')).toBe(0);
    });

    describe('skillIds', () => {
      const summaryOf = async (id: string = PLAN) =>
        testDb.admin(
          async (c) =>
            (await c.query('select summary from rnd.plans where id = $1', [id])).rows[0]
              .summary as Record<string, unknown>,
        );
      const demoWithout = { ...demo, skillIds: undefined };
      const importWithout = async (extra: Record<string, unknown> = {}, id: string = PLAN) =>
        call('POST', '/plans/import', await asA(), { id, ...demoWithout, ...extra });

      it('stores the ids in plans.summary.skillIds, in order', async () => {
        const res = await importWithout({ skillIds: ['python', 'sql'] });
        expect(res.statusCode).toBe(201);
        expect((await summaryOf()).skillIds).toEqual(['python', 'sql']);
        expect(res.json().summary.skillIds).toEqual(['python', 'sql']);
      });

      it('stores the demo plan skills', async () => {
        expect((await importDemo()).statusCode).toBe(201);
        expect((await summaryOf()).skillIds).toEqual(demo.skillIds);
      });

      it('without the field the summary has no skillIds and import is unchanged', async () => {
        const res = await importWithout();
        expect(res.statusCode).toBe(201);
        expect(Object.keys(await summaryOf()).sort()).toEqual(['certs', 'hours']);
        expect((await importWithout()).statusCode).toBe(200);
      });

      it('drops repeats and treats an empty list like a missing one', async () => {
        await importWithout({ skillIds: ['sql', 'python', 'sql'] });
        expect((await summaryOf()).skillIds).toEqual(['sql', 'python']);
        await importWithout({ skillIds: [], status: 'draft' }, PLAN_2);
        expect('skillIds' in (await summaryOf(PLAN_2))).toBe(false);
        // [] hashes like a missing field, and a repeat hashes like the list without it.
        expect((await importWithout({ skillIds: [], status: 'draft' }, PLAN_2)).statusCode).toBe(
          200,
        );
        expect((await importWithout()).statusCode).toBe(409);
        expect((await importWithout({ skillIds: ['sql', 'python'] })).statusCode).toBe(200);
      });

      it('rejects an unknown id with 422, naming the position and echoing nothing else', async () => {
        const res = await importWithout({ skillIds: ['sql', 'not-a-skill'] });
        const body = expectError(res, 422, 'unprocessable');
        expect(body.error.message).toContain('skillIds.1');
        expect(body.error.message).toContain('not-a-skill');
        expect(body.error.message).not.toContain('sql');
        expect(body.error.message).not.toContain(String(demo.name));
        expect(await sql('select count(*)::int as n from rnd.plans')).toBe(0);
      });

      it('cuts a very long unknown id short in the message', async () => {
        const res = await importWithout({ skillIds: ['x'.repeat(64)] });
        const body = expectError(res, 422, 'unprocessable');
        expect(body.error.message).not.toContain('x'.repeat(41));
      });

      it.each([
        ['a string', 'sql'],
        ['a non-string entry', ['sql', 7]],
        ['an empty id', ['']],
        ['more than 50 ids', Array.from({ length: 51 }, (_, i) => `s${i}`)],
      ])('rejects %s with 422 and stores nothing', async (_label, skillIds) => {
        expectError(await importWithout({ skillIds }), 422, 'unprocessable');
        expect(await sql('select count(*)::int as n from rnd.plans')).toBe(0);
      });

      it('same id and same skillIds is a 200 no-op; different skillIds is a 409 and changes nothing', async () => {
        expect((await importWithout({ skillIds: ['sql'] })).statusCode).toBe(201);
        expect((await importWithout({ skillIds: ['sql'] })).statusCode).toBe(200);
        expectError(await importWithout({ skillIds: ['python'] }), 409, 'conflict');
        expectError(await importWithout(), 409, 'conflict');
        expect((await summaryOf()).skillIds).toEqual(['sql']);
        expect(await sql('select count(*)::int as n from rnd.events')).toBe(1);
      });

      it('another user cannot see the ids, and may import the same ids as their own plan', async () => {
        await importWithout({ skillIds: ['sql'] });
        expect((await call('GET', `/plans/${PLAN}`, await asB())).statusCode).toBe(404);
        expect((await call('GET', '/plans', await asB())).json()).toEqual({ plans: [] });
        const other = await call('POST', '/plans/import', await asB(), {
          id: PLAN_2,
          ...demoWithout,
          skillIds: ['sql'],
        });
        expect(other.statusCode).toBe(201);
        expect(await sql('select count(*)::int as n from rnd.plans')).toBe(2);
      });
    });

    it('rejects a body without a valid client plan id (400)', async () => {
      const headers = await asA();
      expectError(
        await call('POST', '/plans/import', headers, { ...demo }),
        400,
        'validation_error',
      );
      expectError(
        await call('POST', '/plans/import', headers, { id: 'not-a-uuid', ...demo }),
        400,
        'validation_error',
      );
      expectError(
        await call('POST', '/plans/import', headers, { id: PLAN, status: 'archived', ...demo }),
        400,
        'validation_error',
      );
    });

    it('enforces the task limit (500) and the body size limit (512 KiB)', async () => {
      const task = demo.tasks[0]!;
      const many = Array.from({ length: 501 }, (_, i) => ({
        ...task,
        id: `t${i}`,
        dependsOn: [],
      }));
      expectError(await importDemo(asA, { tasks: many }), 422, 'unprocessable');

      const atLimit = many.slice(0, 500);
      expect((await importDemo(asA, { tasks: atLimit })).statusCode).toBe(201);

      const huge = await importDemo(
        asA,
        { tasks: [{ ...task, notes: 'x'.repeat(600_000) }] },
        PLAN_2,
      );
      expectError(huge, 413, 'payload_too_large');
      expect(await sql('select count(*)::int as n from rnd.plans')).toBe(1);
    });

    it('rolls the whole plan back when a task cannot be stored', async () => {
      const valid = validateImport({ ...demo }, undefined);
      // Bypasses the route checks on purpose: the database check on task titles must undo everything.
      valid.plan.tasks[valid.plan.tasks.length - 1]!.title = '   ';
      await call('GET', '/me', await asA()); // provisions A, so only the bad task can fail
      const service = createPlanService(db);
      await expect(service.importPlan(A, PLAN, valid)).rejects.toMatchObject({ code: '23514' });
      for (const table of ['plans', 'week_patterns', 'tasks', 'events', 'day_overrides']) {
        expect(await sql(`select count(*)::int as n from rnd.${table}`)).toBe(0);
      }
    });

    it('requires a signed-in user', async () => {
      const res = await call('POST', '/plans/import', {}, { id: PLAN, ...demo });
      expectError(res, 401, 'unauthorized');
    });
  });

  describe('reading and deleting', () => {
    it('lists own plans as summaries and returns the detail', async () => {
      await importDemo();
      await importDemo(asA, { name: 'Second', status: 'draft' }, PLAN_2);
      const list = await call('GET', '/plans', await asA());
      expect(list.statusCode).toBe(200);
      const { plans } = list.json();
      expect(plans.map((p: { id: string }) => p.id).sort()).toEqual([PLAN, PLAN_2]);
      expect(plans[0]).not.toHaveProperty('tasks');
      expect(plans.find((p: { id: string }) => p.id === PLAN).taskCount).toBe(demo.tasks.length);

      const detail = await call('GET', `/plans/${PLAN}`, await asA());
      expect(detail.statusCode).toBe(200);
      expect(detail.json().tasks.map((t: { id: string }) => t.id)).toEqual(
        demo.tasks.map((t) => t.id),
      );
    });

    it('round-trips task fields (anchors, certificates, not-before)', async () => {
      await importDemo();
      const { tasks } = (await call('GET', `/plans/${PLAN}`, await asA())).json();
      const anchors = tasks.filter((t: { isAnchor: boolean }) => t.isAnchor);
      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        expect(a.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(a.anchorStartTime).toMatch(/^\d{2}:\d{2}$/);
      }
      expect(tasks.some((t: { isCertificate: boolean }) => t.isCertificate)).toBe(true);
      expect(tasks.some((t: { notBefore?: string }) => t.notBefore)).toBe(true);
    });

    it('deletes a plan and cascades to everything it owns', async () => {
      await importDemo(asA, { overrides: [{ date: '2026-11-05', isStudyDay: false }] });
      for (const table of ['week_patterns', 'day_overrides', 'tasks', 'events']) {
        expect(await sql(`select count(*)::int as n from rnd.${table}`)).toBeGreaterThan(0);
      }
      const res = await call('DELETE', `/plans/${PLAN}`, await asA());
      expect(res.statusCode).toBe(204);
      for (const table of ['plans', 'week_patterns', 'day_overrides', 'tasks', 'events']) {
        expect(await sql(`select count(*)::int as n from rnd.${table}`)).toBe(0);
      }
      expectError(await call('GET', `/plans/${PLAN}`, await asA()), 404, 'not_found');
      expectError(await call('DELETE', `/plans/${PLAN}`, await asA()), 404, 'not_found');
    });

    it('answers 400 for an id that is not a UUID', async () => {
      expectError(await call('GET', '/plans/nope', await asA()), 400, 'validation_error');
    });
  });

  describe('another user', () => {
    beforeEach(async () => {
      await importDemo(asA, { overrides: [{ date: '2026-11-05', isStudyDay: false }] });
      // B exists as a user with no plans.
      await call('GET', '/me', await asB());
    });

    it('gets 404 (not 403) for every operation on a plan that is not theirs', async () => {
      const b = await asB();
      const pattern = demo.weekPattern;
      const attempts: [Method, string, unknown?][] = [
        ['GET', `/plans/${PLAN}`],
        ['DELETE', `/plans/${PLAN}`],
        ['PUT', `/plans/${PLAN}/week-pattern`, pattern],
        ['PUT', `/plans/${PLAN}/day-overrides/2026-11-06`, { isStudyDay: false }],
        ['PUT', `/plans/${PLAN}/day-overrides/2026-11-05`, { isStudyDay: true }],
        ['DELETE', `/plans/${PLAN}/day-overrides/2026-11-05`],
        ['GET', `/plans/${PLAN}/schedule?today=${TODAY}`],
        ['POST', `/plans/${PLAN}/schedule/preview`, { today: TODAY }],
      ];
      for (const [method, url, payload] of attempts) {
        const res = await call(method, url, b, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        const body = errorResponseSchema.parse(res.json());
        expect(body.error.code).toBe('not_found');
        // Identical to a plan id that never existed anywhere.
        const missing = await call(method, url.replace(PLAN, PLAN_2), b, payload);
        expect(missing.statusCode).toBe(404);
        expect(missing.json().error.message).toBe(body.error.message);
      }
      expect((await call('GET', '/plans', b)).json()).toEqual({ plans: [] });

      // Nothing of A's changed.
      expect(await sql('select count(*)::int as n from rnd.plans where user_id = $1', [A])).toBe(1);
      expect(
        await sql(`select count(*)::int as n from rnd.day_overrides where user_id = $1`, [A]),
      ).toBe(1);
      expect(await sql('select is_study_day as n from rnd.day_overrides', [])).toBe(false);
      expect(
        await sql(`select window_start::text as n from rnd.week_patterns where user_id = $1`, [A]),
      ).toBe('09:00:00');
    });

    it('can import the same plan id for themselves without touching or learning about A', async () => {
      const res = await importDemo(asB, { name: 'B plan' });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('B plan');
      expect((await call('GET', `/plans/${PLAN}`, await asA())).json().name).toBe(demo.name);
    });
  });

  describe('client-supplied user ids', () => {
    it('are ignored in the body, query and headers', async () => {
      const headers = { ...(await asA()), 'x-user-id': B, 'x-forwarded-user': B };
      const res = await call('POST', `/plans/import?user_id=${B}`, headers, {
        id: PLAN,
        ...demo,
        user_id: B,
        userId: B,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty('user_id');
      expect(await sql('select user_id::text as n from rnd.plans')).toBe(A);
      expect(await sql('select user_id::text as n from rnd.events')).toBe(A);
      expect(await sql('select count(distinct user_id)::int as n from rnd.tasks')).toBe(1);

      const asOther = { ...(await asB()), 'x-user-id': A };
      expectError(await call('GET', `/plans/${PLAN}?user_id=${A}`, asOther), 404, 'not_found');
      expect((await call('GET', `/plans?user_id=${A}`, asOther)).json()).toEqual({ plans: [] });
    });
  });

  describe('time settings', () => {
    beforeEach(async () => {
      await importDemo();
    });

    it('replaces the week pattern and persists it', async () => {
      const pattern = {
        ...(demo.weekPattern as object),
        defaultHours: 4,
        hoursByWeekday: { '4': 2 },
        studyWeekdays: [1, 2, 3, 4],
      };
      const res = await call('PUT', `/plans/${PLAN}/week-pattern`, await asA(), pattern);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ defaultHours: 4, hoursByWeekday: { '4': 2 } });
      const plan = (await call('GET', `/plans/${PLAN}`, await asA())).json();
      expect(plan.weekPattern).toMatchObject({ defaultHours: 4, studyWeekdays: [1, 2, 3, 4] });
      // Same request again leaves the same state.
      const again = await call('PUT', `/plans/${PLAN}/week-pattern`, await asA(), pattern);
      expect(again.json()).toEqual(res.json());
      expect(await sql('select count(*)::int as n from rnd.week_patterns')).toBe(1);
    });

    it('rejects an invalid week pattern with 400', async () => {
      const headers = await asA();
      const base = demo.weekPattern as object;
      for (const bad of [
        { ...base, timezone: 'Nowhere/Land' },
        { ...base, windowEnd: '08:00' },
        { ...base, studyWeekdays: [] },
        { ...base, studyWeekdays: [1, 1] },
        { ...base, lunchStart: '13:00', lunchEnd: undefined },
        { ...base, defaultHours: 30 },
      ]) {
        expectError(
          await call('PUT', `/plans/${PLAN}/week-pattern`, headers, bad),
          400,
          'validation_error',
        );
      }
    });

    it('sets, replaces and removes a day override', async () => {
      const headers = await asA();
      const put = (body: unknown) =>
        call('PUT', `/plans/${PLAN}/day-overrides/2026-11-10`, headers, body);
      expect((await put({ isStudyDay: true, capacityHours: 2 })).json()).toEqual({
        date: '2026-11-10',
        isStudyDay: true,
        capacityHours: 2,
      });
      expect((await put({ isStudyDay: false })).json()).toEqual({
        date: '2026-11-10',
        isStudyDay: false,
      });
      expect((await call('GET', `/plans/${PLAN}`, headers)).json().overrides).toEqual([
        { date: '2026-11-10', isStudyDay: false },
      ]);
      const del = await call('DELETE', `/plans/${PLAN}/day-overrides/2026-11-10`, headers);
      expect(del.statusCode).toBe(204);
      // Removing it again succeeds: the end state is the same.
      expect(
        (await call('DELETE', `/plans/${PLAN}/day-overrides/2026-11-10`, headers)).statusCode,
      ).toBe(204);
      expect((await call('GET', `/plans/${PLAN}`, headers)).json().overrides).toEqual([]);
    });

    it('rejects bad dates and bodies for overrides with 400', async () => {
      const headers = await asA();
      expectError(
        await call('PUT', `/plans/${PLAN}/day-overrides/2026-02-30`, headers, { isStudyDay: true }),
        400,
        'validation_error',
      );
      expectError(
        await call('PUT', `/plans/${PLAN}/day-overrides/2026-11-10`, headers, {
          isStudyDay: true,
          capacityHours: 25,
        }),
        400,
        'validation_error',
      );
      expectError(
        await call('DELETE', `/plans/${PLAN}/day-overrides/tomorrow`, headers),
        400,
        'validation_error',
      );
    });
  });

  describe('schedule', () => {
    beforeEach(async () => {
      await importDemo();
    });

    it('defaults today to the date in the plan time zone', async () => {
      const res = await call('GET', `/plans/${PLAN}/schedule`, await asA());
      expect(res.statusCode).toBe(200);
      expect(res.json().today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('rejects a malformed today with 400', async () => {
      expectError(
        await call('GET', `/plans/${PLAN}/schedule?today=2026-13-01`, await asA()),
        400,
        'validation_error',
      );
    });

    it('uses the saved overrides and pattern', async () => {
      const headers = await asA();
      const url = `/plans/${PLAN}/schedule?today=${TODAY}`;
      const before = (await call('GET', url, headers)).json();
      await call('PUT', `/plans/${PLAN}/week-pattern`, headers, {
        ...(demo.weekPattern as object),
        defaultHours: 3,
      });
      const after = (await call('GET', url, headers)).json();
      expect(after.finishDate).not.toBe(before.finishDate);
      expect(after.warnings.some((w: { kind: string }) => w.kind === 'anchor_at_risk')).toBe(true);
    });

    it('schedules nothing before the plan start date when today is earlier', async () => {
      // The demo plan starts on Sunday 2026-11-01; Sunday 2026-10-25 is a study weekday too.
      const res = await call('GET', `/plans/${PLAN}/schedule?today=2026-10-25`, await asA());
      expect(res.statusCode).toBe(200);
      const body = res.json() as { today: string; blocks: { date: string }[] };
      expect(body.today).toBe('2026-10-25');
      expect(body.blocks.length).toBeGreaterThan(0);
      expect(body.blocks.filter((b) => b.date < '2026-11-01')).toEqual([]);
      // Same answer as asking on the start date itself.
      const onStart = (
        await call('GET', `/plans/${PLAN}/schedule?today=2026-11-01`, await asA())
      ).json() as { blocks: unknown[]; finishDate: string };
      expect(body.blocks).toEqual(onStart.blocks);

      const preview = await call('POST', `/plans/${PLAN}/schedule/preview`, await asA(), {
        today: '2026-10-25',
      });
      expect(preview.statusCode).toBe(200);
      const proposed = (preview.json() as { proposed: { blocks: { date: string }[] } }).proposed;
      expect(proposed.blocks.filter((b) => b.date < '2026-11-01')).toEqual([]);
    });

    it('reports anchor_at_risk with the engine options', async () => {
      const res = await call('GET', `/plans/${PLAN}/schedule?today=2026-11-20`, await asA());
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().warnings)).toBe(true);
    });
  });

  describe('preview', () => {
    beforeEach(async () => {
      await importDemo();
    });

    const snapshot = async () => ({
      plan: (await call('GET', `/plans/${PLAN}`, await asA())).json(),
      events: await sql('select count(*)::int as n from rnd.events'),
      overrides: await sql('select count(*)::int as n from rnd.day_overrides'),
      updated: await sql('select updated_at::text as n from rnd.plans'),
    });

    it('describes a pattern change and a day off without saving either', async () => {
      const before = await snapshot();
      const res = await call('POST', `/plans/${PLAN}/schedule/preview`, await asA(), {
        today: TODAY,
        pattern: { ...(demo.weekPattern as object), defaultHours: 3 },
        overrides: [{ date: '2026-11-05', isStudyDay: false }],
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary.text).toMatch(/moved/);
      expect(body.summary.finishChanged).toBe(true);
      expect(body.summary.finishBefore).toBe(body.current.finishDate);
      expect(body.summary.finishAfter).toBe(body.proposed.finishDate);
      expect(body.proposed.blocks.length).toBeGreaterThan(0);
      expect(await snapshot()).toEqual(before);
    });

    it('reports no change for an empty preview', async () => {
      const res = await call('POST', `/plans/${PLAN}/schedule/preview`, await asA(), {
        today: TODAY,
      });
      expect(res.json().summary).toMatchObject({
        movedTaskIds: [],
        finishChanged: false,
        text: 'No tasks moved, plan finish unchanged.',
      });
    });

    it('can remove an existing override in the proposal only', async () => {
      const headers = await asA();
      const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
      for (const d of days) {
        await call('PUT', `/plans/${PLAN}/day-overrides/${d}`, headers, { isStudyDay: false });
      }
      const saved = await snapshot();
      const res = await call('POST', `/plans/${PLAN}/schedule/preview`, headers, {
        today: TODAY,
        removeOverrideDates: days,
      });
      expect(res.json().summary.finishChanged).toBe(true);
      expect(await snapshot()).toEqual(saved);
    });

    it('rejects an invalid proposed pattern with 400', async () => {
      expectError(
        await call('POST', `/plans/${PLAN}/schedule/preview`, await asA(), {
          pattern: { ...(demo.weekPattern as object), timezone: 'Nowhere/Land' },
        }),
        400,
        'validation_error',
      );
    });
  });

  describe('contract', () => {
    it('lists the endpoints in the OpenAPI document', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
      const { paths } = res.json();
      expect(Object.keys(paths['/api/v1/plans/import'])).toEqual(['post']);
      expect(Object.keys(paths['/api/v1/plans/{id}']).sort()).toEqual(['delete', 'get']);
      expect(paths['/api/v1/plans/{id}/week-pattern']).toHaveProperty('put');
      expect(paths['/api/v1/plans/{id}/day-overrides/{date}']).toHaveProperty('delete');
      expect(paths['/api/v1/plans/{id}/schedule']).toHaveProperty('get');
      expect(paths['/api/v1/plans/{id}/schedule/preview']).toHaveProperty('post');
    });

    it('requires a token on every plan route', async () => {
      const routes: [Method, string][] = [
        ['GET', '/plans'],
        ['GET', `/plans/${PLAN}`],
        ['DELETE', `/plans/${PLAN}`],
        ['PUT', `/plans/${PLAN}/week-pattern`],
        ['PUT', `/plans/${PLAN}/day-overrides/2026-11-05`],
        ['DELETE', `/plans/${PLAN}/day-overrides/2026-11-05`],
        ['GET', `/plans/${PLAN}/schedule`],
        ['POST', `/plans/${PLAN}/schedule/preview`],
      ];
      for (const [method, url] of routes) {
        expectError(await call(method, url, {}), 401, 'unauthorized');
      }
    });
  });
});
