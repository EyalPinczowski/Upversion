import rolesData from '../../../data/catalog/roles.json';
import skillsData from '../../../data/catalog/skills.json';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDatabase, type Database } from '../src/db/database';
import { errorResponseSchema } from '../src/errors';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const skillIds = (skillsData as { skills: { id: string }[] }).skills.map((s) => s.id);
const roleIds = (rolesData as { roles: { id: string }[] }).roles.map((r) => r.id);
const CANARY = 'canary-answer-text-7f3a91';

type Method = 'GET' | 'PUT' | 'PATCH' | 'DELETE';
const ROUTES: Array<[Method, string, unknown?]> = [
  ['GET', '/me/profile'],
  ['PUT', '/me/profile/answers', { answers: { hours_per_day: 2 } }],
  [
    'PUT',
    '/me/profile/import',
    { skills: [], rolesHeld: [], yearsExperience: null, education: null, tools: [] },
  ],
  ['PATCH', '/me/profile/setup', { status: 'in_progress' }],
  ['DELETE', '/me/profile'],
];

describe.skipIf(!dbAvailable)('user profile (real Postgres, locally signed tokens)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let offApp: ReturnType<typeof buildApp>;
  const logLines: string[] = [];

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    const verifier = createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys });
    const features = { ...loadConfig({}).features, profileSetup: true };
    app = buildApp(
      testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000, logLevel: 'info', features }),
      { verifier, db, logStream: { write: (line) => void logLines.push(line) } },
    );
    // The flag is off by default.
    offApp = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), { verifier, db });
    await app.ready();
    await offApp.ready();
  });

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
  });

  beforeEach(async () => {
    logLines.length = 0;
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com'), ('c@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com'), ($3, 'c@example.com')`,
        [A, B, C],
      );
      await acceptCurrentLegal(c, [A, B]);
    });
  });

  const asA = async () => ({
    authorization: `Bearer ${await keys.sign({ sub: A, email: 'a@example.com' })}`,
  });
  const asB = async () => ({
    authorization: `Bearer ${await keys.sign({ sub: B, email: 'b@example.com' })}`,
  });
  // C exists but has not accepted the Terms.
  const asC = async () => ({
    authorization: `Bearer ${await keys.sign({ sub: C, email: 'c@example.com' })}`,
  });

  const call = (
    method: Method,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
    server = app,
  ) =>
    server.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const row = (userId: string) =>
    testDb.admin(
      async (c) =>
        (await c.query('select * from rnd.user_profiles where user_id = $1', [userId])).rows[0] as
          Record<string, unknown> | undefined,
    );

  const importBody = (over: Record<string, unknown> = {}) => ({
    skills: [],
    rolesHeld: [],
    yearsExperience: null,
    education: null,
    tools: [],
    ...over,
  });

  describe('flag and guards', () => {
    it.each(ROUTES)('%s %s answers 404 when FEATURE_PROFILE_SETUP is off', async (m, u, body) => {
      const res = await call(m, u, await asA(), body, offApp);
      expect(res.statusCode).toBe(404);
      expect(await row(A)).toBeUndefined();
    });

    it.each(ROUTES)('%s %s answers 401 without a token', async (m, u, body) => {
      const res = await call(m, u, {}, body);
      expect(res.statusCode).toBe(401);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('unauthorized');
    });

    it.each(ROUTES)(
      '%s %s answers 403 terms_not_accepted until the Terms are accepted',
      async (m, u, body) => {
        const res = await call(m, u, await asC(), body);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('terms_not_accepted');
        expect(await row(C)).toBeUndefined();
      },
    );
  });

  describe('GET', () => {
    it('answers the defaults when there is no row', async () => {
      const res = await call('GET', '/me/profile', await asA());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        answers: {},
        skills: [],
        rolesHeld: [],
        yearsExperience: null,
        cvImportedAt: null,
        setupStatus: 'not_started',
        setupStep: null,
        setupCompletedAt: null,
      });
      expect(await row(A)).toBeUndefined();
    });
  });

  describe('PUT /me/profile/answers', () => {
    it('saves validated answers and merges later ones', async () => {
      const first = await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student', days_per_week: [3, 1], hours_per_day: 1.5 },
      });
      expect(first.statusCode).toBe(200);
      // Weekdays come back normalised (sorted).
      expect(first.json().answers).toEqual({
        current_status: 'student',
        days_per_week: [1, 3],
        hours_per_day: 1.5,
      });
      const second = await call('PUT', '/me/profile/answers', await asA(), {
        answers: {
          hours_per_day: 2,
          target_role: [roleIds[0]!],
          target_skills: skillIds.slice(0, 5),
        },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().answers).toEqual({
        current_status: 'student',
        days_per_week: [1, 3],
        hours_per_day: 2,
        target_role: [roleIds[0]],
        target_skills: skillIds.slice(0, 5),
      });
      const again = await call('PUT', '/me/profile/answers', await asA(), {
        answers: { hours_per_day: 2 },
      });
      expect(again.json().answers).toEqual(second.json().answers);
      expect(await call('GET', '/me/profile', await asA())).toMatchObject({ statusCode: 200 });
    });

    it.each([
      ['an unknown question id', { nope: 'x' }],
      ['a question that is not a setup question', { goal_type: 'new_role' }],
      ['an option that does not exist', { current_status: 'astronaut' }],
      ['a number below the minimum', { hours_per_day: 0 }],
      ['a number off the step', { hours_per_day: 1.2 }],
      ['a weekday out of range', { days_per_week: [7] }],
      ['an unknown role id', { target_role: ['no-such-role'] }],
      ['an unknown skill id', { target_skills: ['no-such-skill'] }],
      ['more roles than max', { target_role: roleIds.slice(0, 3) }],
      ['more skills than max', { target_skills: skillIds.slice(0, 6) }],
      ['"Other" as a role', { target_role: ['Other'] }],
      ['a typed role value', { target_role: ['Chief Snack Officer'] }],
      ['a typed skill value', { target_skills: [CANARY] }],
      ['a string instead of a list', { target_role: roleIds[0] }],
    ])('rejects %s and saves nothing', async (_name, answers) => {
      await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student' },
      });
      const res = await call('PUT', '/me/profile/answers', await asA(), {
        answers: { hours_per_day: 3, ...answers },
      });
      expect(res.statusCode).toBe(400);
      expect(errorResponseSchema.parse(res.json()).error.code).toMatch(/invalid_answer/);
      expect((await row(A))!.answers).toEqual({ current_status: 'student' });
    });

    it('does not echo a rejected value in the error or the logs', async () => {
      const res = await call('PUT', '/me/profile/answers', await asA(), {
        answers: { target_skills: [CANARY] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(CANARY);
      expect(logLines.join('\n')).not.toContain(CANARY);
    });

    it('never logs saved answers', async () => {
      await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student' },
      });
      await call(
        'PUT',
        '/me/profile/import',
        await asA(),
        importBody({ rolesHeld: [{ roleId: null, title: CANARY, years: 1 }] }),
      );
      await call('GET', '/me/profile', await asA());
      expect(logLines.length).toBeGreaterThan(0);
      expect(logLines.join('\n')).not.toContain(CANARY);
      expect(logLines.join('\n')).not.toContain('student');
    });

    it('refuses unknown keys and a userId, in the body and the query', async () => {
      for (const payload of [
        { answers: {}, extra: 1 },
        { answers: {}, userId: B },
        { answers: {}, user_id: B },
        { userId: B },
        {},
      ]) {
        const res = await call('PUT', '/me/profile/answers', await asA(), payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(await row(A)).toBeUndefined();
      expect(await row(B)).toBeUndefined();
    });
  });

  describe('PUT /me/profile/import', () => {
    const skill = (i: number) => skillIds[i]!;

    it('saves the confirmed items and pre-fills education and tools where empty', async () => {
      const res = await call(
        'PUT',
        '/me/profile/import',
        await asA(),
        importBody({
          skills: [
            { skillId: skill(0), level: 2 },
            { skillId: skill(1), level: 1 },
          ],
          rolesHeld: [
            { roleId: roleIds[0], title: 'Operations lead', years: 3.5 },
            { roleId: null, title: 'Barista', years: null },
          ],
          yearsExperience: 6,
          education: 'bachelor',
          tools: ['Excel', 'SQL'],
        }),
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skills).toEqual([
        { skillId: skill(0), level: 2, source: 'cv' },
        { skillId: skill(1), level: 1, source: 'cv' },
      ]);
      expect(body.rolesHeld).toHaveLength(2);
      expect(body.yearsExperience).toBe(6);
      expect(body.cvImportedAt).not.toBeNull();
      expect(body.answers).toEqual({ education: 'bachelor', tools_known: ['Excel', 'SQL'] });
    });

    it('replaces only cv skills: manual and setup ones stay, and the user’s own level wins', async () => {
      await testDb.admin((c) =>
        c.query(
          `insert into rnd.user_profiles (user_id, skills, answers) values ($1, $2::jsonb, $3::jsonb)`,
          [
            A,
            JSON.stringify([
              { skillId: skill(0), level: 3, source: 'manual' },
              { skillId: skill(1), level: 1, source: 'setup' },
              { skillId: skill(2), level: 1, source: 'cv' },
              { skillId: skill(3), level: 2, source: 'cv' },
            ]),
            JSON.stringify({ education: 'master' }),
          ],
        ),
      );
      const res = await call(
        'PUT',
        '/me/profile/import',
        await asA(),
        importBody({
          skills: [
            { skillId: skill(0), level: 1 }, // clashes with manual: manual stays
            { skillId: skill(1), level: 3 }, // clashes with setup: setup stays
            { skillId: skill(3), level: 1 }, // was cv: replaced
            { skillId: skill(4), level: 2 }, // new
          ],
          education: 'bachelor',
          tools: ['Git'],
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().skills).toEqual([
        { skillId: skill(0), level: 3, source: 'manual' },
        { skillId: skill(1), level: 1, source: 'setup' },
        { skillId: skill(3), level: 1, source: 'cv' },
        { skillId: skill(4), level: 2, source: 'cv' },
      ]);
      // skill(2) (an old cv item that was not confirmed again) is gone; education was not empty.
      expect(res.json().answers).toEqual({ education: 'master', tools_known: ['Git'] });
    });

    it('an import with no skills removes the old cv skills only', async () => {
      await testDb.admin((c) =>
        c.query(`insert into rnd.user_profiles (user_id, skills) values ($1, $2::jsonb)`, [
          A,
          JSON.stringify([
            { skillId: skill(0), level: 3, source: 'manual' },
            { skillId: skill(2), level: 1, source: 'cv' },
          ]),
        ]),
      );
      const res = await call('PUT', '/me/profile/import', await asA(), importBody());
      expect(res.json().skills).toEqual([{ skillId: skill(0), level: 3, source: 'manual' }]);
    });

    it.each([
      [
        'an unknown skill id',
        () => importBody({ skills: [{ skillId: 'no-such-skill', level: 1 }] }),
      ],
      [
        'a duplicate skill',
        () =>
          importBody({
            skills: [
              { skillId: skillIds[0], level: 1 },
              { skillId: skillIds[0], level: 2 },
            ],
          }),
      ],
      ['a level above 3', () => importBody({ skills: [{ skillId: skillIds[0], level: 4 }] })],
      [
        'an unknown role id',
        () => importBody({ rolesHeld: [{ roleId: 'no-such-role', title: 'x', years: 1 }] }),
      ],
      [
        'a title with an email',
        () =>
          importBody({
            rolesHeld: [{ roleId: null, title: 'Lead, jane.doe@example.com', years: 1 }],
          }),
      ],
      [
        'a title with a link',
        () =>
          importBody({
            rolesHeld: [{ roleId: null, title: 'Lead at https://acme.example/jobs', years: 1 }],
          }),
      ],
      [
        'a title with a handle',
        () => importBody({ rolesHeld: [{ roleId: null, title: 'Lead @janedoe', years: 1 }] }),
      ],
      [
        'a title with a phone number',
        () => importBody({ rolesHeld: [{ roleId: null, title: 'Lead 054-123-4567', years: 1 }] }),
      ],
      [
        'a title over 80 characters',
        () => importBody({ rolesHeld: [{ roleId: null, title: 'x'.repeat(81), years: 1 }] }),
      ],
      ['years over 50', () => importBody({ yearsExperience: 51 })],
      ['an unknown education value', () => importBody({ education: 'wizard' })],
      ['a tool that is not an option', () => importBody({ tools: ['Fortran'] })],
      ['raw CV text', () => importBody({ text: 'my whole CV' })],
      [
        'evidence',
        () => importBody({ skills: [{ skillId: skillIds[0], level: 1, evidence: 'snippet' }] }),
      ],
      ['a userId', () => importBody({ userId: B })],
    ])('rejects %s and saves nothing', async (_name, body) => {
      const res = await call('PUT', '/me/profile/import', await asA(), body());
      expect(res.statusCode).toBe(400);
      expect(await row(A)).toBeUndefined();
    });

    it('never stores CV text: the row has no column for it and the payload is allowlisted', async () => {
      await call(
        'PUT',
        '/me/profile/import',
        await asA(),
        importBody({ skills: [{ skillId: skill(0), level: 1 }] }),
      );
      const stored = JSON.stringify(await row(A));
      expect(stored).not.toContain('evidence');
    });
  });

  describe('PATCH /me/profile/setup', () => {
    it('creates the row, moves the status and keeps the first completion time', async () => {
      const progress = await call('PATCH', '/me/profile/setup', await asA(), {
        status: 'in_progress',
        step: 'q3',
      });
      expect(progress.statusCode).toBe(200);
      expect(progress.json()).toMatchObject({
        setupStatus: 'in_progress',
        setupStep: 'q3',
        setupCompletedAt: null,
      });
      // Step is kept when omitted.
      const same = await call('PATCH', '/me/profile/setup', await asA(), { status: 'in_progress' });
      expect(same.json().setupStep).toBe('q3');
      const done = await call('PATCH', '/me/profile/setup', await asA(), {
        status: 'completed',
        step: 'done',
      });
      expect(done.json().setupStatus).toBe('completed');
      const at = done.json().setupCompletedAt as string;
      expect(at).toBeTruthy();
      const again = await call('PATCH', '/me/profile/setup', await asA(), { status: 'completed' });
      expect(again.json().setupCompletedAt).toBe(at);
      const dismissed = await call('PATCH', '/me/profile/setup', await asA(), {
        status: 'dismissed',
      });
      expect(dismissed.json().setupStatus).toBe('dismissed');
    });

    it.each([
      ['an unknown status', { status: 'finished' }],
      ['no status', { step: 'x' }],
      ['a step over 40 characters', { status: 'in_progress', step: 'x'.repeat(41) }],
      ['an unknown key', { status: 'in_progress', extra: true }],
      ['a userId', { status: 'in_progress', userId: B }],
    ])('rejects %s', async (_name, body) => {
      const res = await call('PATCH', '/me/profile/setup', await asA(), body);
      expect(res.statusCode).toBe(400);
      expect(await row(A)).toBeUndefined();
    });
  });

  describe('DELETE /me/profile', () => {
    it('clears everything personal but keeps the row as dismissed', async () => {
      await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student' },
      });
      await call(
        'PUT',
        '/me/profile/import',
        await asA(),
        importBody({
          skills: [{ skillId: skillIds[0], level: 2 }],
          rolesHeld: [{ roleId: null, title: 'Barista', years: 2 }],
          yearsExperience: 4,
          education: 'bachelor',
        }),
      );
      await call('PATCH', '/me/profile/setup', await asA(), { status: 'completed', step: 'done' });

      const res = await call('DELETE', '/me/profile', await asA());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        answers: {},
        skills: [],
        rolesHeld: [],
        yearsExperience: null,
        cvImportedAt: null,
        setupStatus: 'dismissed',
        setupStep: null,
        setupCompletedAt: null,
      });
      expect(await row(A)).toMatchObject({
        setup_status: 'dismissed',
        answers: {},
        skills: [],
        roles_held: [],
      });
      const get = await call('GET', '/me/profile', await asA());
      expect(get.json().setupStatus).toBe('dismissed');
    });

    it('works when there is no row yet, and refuses a body that names a user', async () => {
      const bad = await call('DELETE', '/me/profile', await asA(), { userId: B });
      expect(bad.statusCode).toBe(400);
      expect(await row(A)).toBeUndefined();
      const ok = await call('DELETE', '/me/profile', await asA());
      expect(ok.statusCode).toBe(200);
      expect(ok.json().setupStatus).toBe('dismissed');
    });
  });

  describe('ownership', () => {
    it.each(ROUTES)('%s %s with a userId in the query is a 400', async (m, u, body) => {
      const res = await call(m, `${u}?userId=${B}`, await asA(), body);
      expect(res.statusCode).toBe(400);
      expect(await row(B)).toBeUndefined();
    });

    it('keeps one user’s profile out of another’s requests and writes', async () => {
      await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student' },
      });
      await call('PATCH', '/me/profile/setup', await asB(), { status: 'completed' });
      const b = await call('GET', '/me/profile', await asB());
      expect(b.json().answers).toEqual({});
      expect(b.json().setupStatus).toBe('completed');
      await call('DELETE', '/me/profile', await asB());
      const a = await call('GET', '/me/profile', await asA());
      expect(a.json().answers).toEqual({ current_status: 'student' });
      expect(a.json().setupStatus).toBe('not_started');
    });
  });

  describe('account export', () => {
    it('includes the profile of the signed-in user only', async () => {
      await call('PUT', '/me/profile/answers', await asA(), {
        answers: { current_status: 'student' },
      });
      await call('PUT', '/me/profile/answers', await asB(), {
        answers: { current_status: 'employed' },
      });
      const res = await call('GET', '/me/export', await asA());
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.userProfiles).toHaveLength(1);
      expect(body.userProfiles[0]).toMatchObject({
        user_id: A,
        answers: { current_status: 'student' },
      });
      expect(JSON.stringify(body)).not.toContain('employed');
    });
  });
});
