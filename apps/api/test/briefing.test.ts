import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BriefingSchema } from '@upversion/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN = 'a0000000-0000-4000-8000-000000000001';
const PLAN_RISK = 'a0000000-0000-4000-8000-000000000002';
const MISSING = 'f0000000-0000-4000-8000-000000000009';
const LOG = 'c0000000-0000-4000-8000-000000000001';

const demo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../data/sample-plans/demo-plan.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown> & { tasks: Record<string, unknown>[] };

// The demo plan starts on Sunday 2026-11-01, studies Sunday to Thursday, in Jerusalem (UTC+2).
const SUN = '2026-11-01';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const at = (date: string, time = '08:00') => new Date(`${date}T${time}:00Z`);

type Method = 'GET' | 'POST' | 'PUT';

describe.skipIf(!dbAvailable)('day briefing (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let clock = at(SUN);

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
      now: () => clock,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
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
  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);

  /** Imports a plan for user A, then backdates its creation so the fixed clock stays inside it. */
  const importPlan = async (id: string, file: Record<string, unknown>) => {
    // Imported as a draft and activated directly: an active import would archive the user's
    // other active plan (ADR 018 Q2), and these tests keep two plans active side by side.
    const res = await call('POST', '/plans/import', await asA(), { id, ...file, status: 'draft' });
    expect(res.statusCode).toBe(201);
    await rows(
      `update rnd.plans set status = 'active', created_at = '2026-10-30T10:00:00Z' where id = $1`,
      [id],
    );
  };

  const BRIEFING = (date: string, plan = PLAN) => `/plans/${plan}/days/${date}/briefing`;
  const briefing = async (date: string, plan = PLAN) => {
    const res = await call('GET', BRIEFING(date, plan), await asA());
    expect(res.statusCode, res.body).toBe(200);
    return res;
  };

  beforeEach(async () => {
    clock = at(SUN);
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
    await importPlan(PLAN, demo);
  });

  describe('authentication and isolation', () => {
    it('answers 401 without a token', async () => {
      expect((await call('GET', BRIEFING(SUN), {})).statusCode).toBe(401);
      expect((await call('GET', BRIEFING(SUN), { authorization: 'Bearer nope' })).statusCode).toBe(
        401,
      );
    });

    it('answers 403 until the current terms are accepted', async () => {
      await rows('delete from rnd.legal_acceptances');
      const res = await call('GET', BRIEFING(SUN), await asA());
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('terms_not_accepted');
    });

    it('answers 404 for another user’s plan, identical to a missing plan', async () => {
      const missing = await call('GET', BRIEFING(SUN, MISSING), await asB());
      expect(missing.statusCode).toBe(404);
      const other = await call('GET', BRIEFING(SUN), await asB());
      expect(other.statusCode).toBe(404);
      expect(other.json().error.code).toBe('not_found');
      expect(other.json().error.message).toBe(missing.json().error.message);
      expect(await rows('select 1 from rnd.schedule_days')).toEqual([]);
    });

    it('answers 404 for an unknown plan and 400 for a malformed id or date', async () => {
      expect((await call('GET', BRIEFING(SUN, MISSING), await asA())).statusCode).toBe(404);
      expect((await call('GET', BRIEFING(SUN, 'not-a-uuid'), await asA())).statusCode).toBe(400);
      expect((await call('GET', BRIEFING('2026-13-45'), await asA())).statusCode).toBe(400);
    });
  });

  describe('which days have a briefing', () => {
    it('answers 422 for a future day', async () => {
      const res = await call('GET', BRIEFING(MON), await asA());
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('unprocessable');
    });

    it('answers 422 for a day before the plan began', async () => {
      expect((await call('GET', BRIEFING('2026-10-25'), await asA())).statusCode).toBe(422);
    });
  });

  describe('today’s briefing for the demo plan', () => {
    it('is built from the template with exact text', async () => {
      const body = (await briefing(SUN)).json();
      expect(BriefingSchema.parse(body)).toEqual(body);
      expect(body.source).toBe('template');
      expect(body.date).toBe(SUN);
      expect(body.overview).toBe(
        'Today is 6 hours 50 minutes of study: 1 admin task and 2 courses. ' +
          'This work leads toward Salesforce Certified Tableau Desktop Foundations, on 2026-11-24, in 17 study days.',
      );
      expect(body.suggestedOrder).toEqual([
        { taskId: 'setup', start: '09:00', end: '09:30' },
        { taskId: 'sql1', start: '09:30', end: '11:00' },
        { taskId: 'sql1', start: '11:10', end: '12:40' },
        { taskId: 'sqlbolt', start: '14:00', end: '16:00' },
        { taskId: 'sqlbolt', start: '16:10', end: '17:30' },
      ]);
      expect(body.tasks.map((t: { taskId: string; what: string }) => [t.taskId, t.what])).toEqual([
        ['setup', 'Admin task "Set up learning accounts and study workspace": 30 minutes.'],
        [
          'sql1',
          'Study "Intro to SQL (Kaggle Learn)" on Kaggle: 3 hours today. It has 1 lesson. 3 hours remain in total.',
        ],
        [
          'sqlbolt',
          'Study "SQLBolt interactive lessons" on SQLBolt: 3 hours 20 minutes today. It has 1 lesson. 4 hours remain in total.',
        ],
      ]);
      expect(body.tasks[1]).toMatchObject({
        provider: 'Kaggle',
        url: 'https://www.kaggle.com/learn/intro-to-sql',
        plannedMinutes: 180,
        start: '09:30',
        end: '12:40',
        carriedOver: false,
        lessons: [
          {
            title: 'Getting Started With SQL and BigQuery',
            url: 'https://www.kaggle.com/code/dansbecker/getting-started-with-sql-and-bigquery',
            needsCheck: false,
          },
        ],
        successCriteria: null,
        promptTemplate: null,
      });
    });

    it('mentions the work carried over from the day before', async () => {
      clock = at(MON);
      const body = (await briefing(MON)).json();
      // Nothing was logged on Sunday, so everything planned then is still open.
      expect(body.overview).toBe(
        'Today is 6 hours 50 minutes of study: 1 admin task and 2 courses. ' +
          'This work leads toward Salesforce Certified Tableau Desktop Foundations, on 2026-11-24, in 16 study days. ' +
          'Carried over from an earlier day: "Set up learning accounts and study workspace", "Intro to SQL (Kaggle Learn)" and "SQLBolt interactive lessons". ' +
          'Warning: Salesforce Certified Tableau Desktop Foundations on 2026-11-24 is at risk: 30 minutes of the study before it does not fit (1 other date is also at risk). Review the options in the schedule.',
      );
      expect(
        body.tasks.map((t: { taskId: string; carriedOver: boolean }) => [t.taskId, t.carriedOver]),
      ).toEqual([
        ['setup', true],
        ['sql1', true],
        ['sqlbolt', true],
      ]);
    });

    it('has no podcast when the plan stores no skills', async () => {
      await rows(`update rnd.plans set summary = summary - 'skillIds' where id = $1`, [PLAN]);
      const body = (await briefing(SUN)).json();
      expect('podcast' in body).toBe(false);
    });

    it('adds one Idea of the day podcast when the plan stores skills, in the schema shape', async () => {
      await rows(`update rnd.plans set summary = summary || $2::jsonb where id = $1`, [
        PLAN,
        JSON.stringify({ skillIds: ['python', 'not-a-string-next', 7] }),
      ]);
      const body = (await briefing(SUN)).json();
      expect(Object.keys(body.podcast).sort()).toEqual([
        'oneLine',
        'publisher',
        'skillLink',
        'spotifyUrl',
        'title',
      ]);
      expect(body.podcast.spotifyUrl).toMatch(/^https:\/\/open\.spotify\.com\/show\//);
      expect(BriefingSchema.parse(body).podcast).toEqual(body.podcast);
      // The same day always gives the same show.
      expect((await briefing(SUN)).json().podcast).toEqual(body.podcast);
    });

    it('an imported plan file with skillIds gets a podcast whose show matches one of them', async () => {
      // The demo file carries skillIds (python among them), imported through the real route in beforeEach.
      expect(
        (await rows(`select summary from rnd.plans where id = $1`, [PLAN]))[0]!.summary,
      ).toMatchObject({
        skillIds: demo.skillIds,
      });
      const body = (await briefing(SUN)).json();
      // 'python' is the only demo skill with shows: Command Line Heroes and CoRecursive.
      expect(['Command Line Heroes', 'CoRecursive']).toContain(body.podcast.title);
      // A plan file with data-analysis (Freakonomics Radio) and communication (Hidden Brain, ...).
      const rest = { ...demo, skillIds: undefined };
      await importPlan(PLAN_RISK, { ...rest, skillIds: ['data-analysis'] });
      const other = (await briefing(SUN, PLAN_RISK)).json();
      expect(other.podcast.title).toBe('Freakonomics Radio');
    });

    it('has no podcast when the stored skills match no show', async () => {
      await rows(`update rnd.plans set summary = summary || $2::jsonb where id = $1`, [
        PLAN,
        JSON.stringify({ skillIds: ['excel'] }),
      ]);
      expect('podcast' in (await briefing(SUN)).json()).toBe(false);
    });

    it('writes nothing for today: no events, no stored days', async () => {
      const before = await rows(`select type from rnd.events order by id`);
      await briefing(SUN);
      await briefing(SUN);
      expect(await rows(`select type from rnd.events order by id`)).toEqual(before);
      expect(await rows('select 1 from rnd.schedule_days')).toEqual([]);
      expect(await rows('select 1 from rnd.day_sessions')).toEqual([]);
    });

    it('never reads a user_id from the request', async () => {
      const res = await call('GET', `${BRIEFING(SUN)}?user_id=${B}`, await asA());
      expect(res.statusCode).toBe(200);
      const other = await call('GET', `${BRIEFING(SUN)}?user_id=${A}`, await asB());
      expect(other.statusCode).toBe(404);
    });
  });

  describe('a frozen past day', () => {
    it('uses the stored blocks and is byte-identical after later edits', async () => {
      const ended = await call('POST', `/plans/${PLAN}/days/${SUN}/end`, await asA());
      expect(ended.statusCode).toBe(200);
      const first = (await briefing(SUN)).body;
      const stored = await rows<{ blocks: { taskId: string; start: string; end: string }[] }>(
        `select blocks from rnd.schedule_days where plan_id = $1 and date = $2`,
        [PLAN, SUN],
      );
      expect(JSON.parse(first).suggestedOrder).toEqual(
        stored[0]!.blocks.map((b) => ({ taskId: b.taskId, start: b.start, end: b.end })),
      );

      // Later: the clock moves on, the user logs work and shortens the study hours.
      clock = at(TUE);
      const pattern = demo.weekPattern as Record<string, unknown>;
      const put = await call('PUT', `/plans/${PLAN}/week-pattern`, await asA(), {
        ...pattern,
        defaultHours: 3,
      });
      expect(put.statusCode).toBe(200);
      const log = await call('POST', `/plans/${PLAN}/tasks/sql1/logs`, await asA(), {
        id: LOG,
        date: MON,
        hours: 2,
      });
      expect(log.statusCode).toBeLessThan(300);

      expect((await briefing(SUN)).body).toBe(first);
      // The next day was frozen on the way, from its own stored blocks.
      expect((await briefing(MON)).statusCode).toBe(200);
    });

    it('shows a day that rolled over on its own from what was planned then', async () => {
      clock = at(TUE);
      const body = (await briefing(SUN)).json();
      expect(body.suggestedOrder).toHaveLength(5);
      expect(body.overview).toContain('Today is 6 hours 50 minutes of study');
      expect(body.overview).not.toContain('Carried over');
    });
  });

  describe('anchor at risk and links', () => {
    const risky = {
      formatVersion: 1,
      name: 'Risky',
      startDate: SUN,
      weekPattern: demo.weekPattern,
      tasks: [
        {
          id: 'prep',
          title: 'Prep course',
          type: 'course',
          estHours: 30,
          order: 0,
          lessons: [
            { title: 'With link', url: 'https://example.com/lesson-1' },
            { title: 'Without link' },
          ],
        },
        {
          id: 'exam',
          title: 'The exam',
          type: 'cert_exam',
          estHours: 2,
          order: 1,
          dependsOn: ['prep'],
          isAnchor: true,
          anchorDate: TUE,
          anchorStartTime: '10:00',
          isCertificate: true,
          certificateName: 'Risky Certificate',
          splittable: false,
        },
      ],
    };

    it('adds a warning sentence when the engine warns', async () => {
      await importPlan(PLAN_RISK, risky);
      const schedule = await call('GET', `/plans/${PLAN_RISK}/schedule`, await asA());
      expect(schedule.json().warnings.map((w: { kind: string }) => w.kind)).toContain(
        'anchor_at_risk',
      );
      const body = (await briefing(SUN, PLAN_RISK)).json();
      expect(body.overview).toBe(
        'Today is 7 hours of study: 1 course. ' +
          'This work leads toward Risky Certificate, on 2026-11-03, in 2 study days. ' +
          'Warning: Risky Certificate on 2026-11-03 is at risk: 15 hours of the study before it does not fit. Review the options in the schedule.',
      );
    });

    it('does not warn on a plan the engine finds fine', async () => {
      expect((await briefing(SUN)).json().overview).not.toContain('Warning');
    });

    it('shows a link only where the task or lesson has one', async () => {
      await importPlan(PLAN_RISK, risky);
      const body = (await briefing(SUN, PLAN_RISK)).json();
      const links = (JSON.stringify(body).match(/https?:\/\/[^"]+/g) ?? []).sort();
      expect(links).toEqual(['https://example.com/lesson-1']);
      expect(body.tasks[0].lessons).toEqual([
        { title: 'With link', url: 'https://example.com/lesson-1', needsCheck: false },
        { title: 'Without link', needsCheck: false },
      ]);
      expect(body.tasks[0]).not.toHaveProperty('url');
    });
  });
});
