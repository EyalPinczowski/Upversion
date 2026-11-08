import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDatabase, type Database } from '../src/db/database';
import { errorResponseSchema } from '../src/errors';
import { createSupabaseAuthAdmin } from '../src/modules/accounts/auth-admin';
import { EXPORT_EXCLUDED_TABLES, EXPORT_SECTIONS } from '../src/modules/accounts/service';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { FAKE_SERVICE_KEY, startFakeSupabase, type FakeSupabase } from './fake-supabase';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, unsignedToken, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000002';

const GENERIC_403 = {
  code: 'forbidden',
  message: 'This account cannot use Upversion.',
};

describe.skipIf(!dbAvailable)('accounts (real Postgres, locally signed tokens)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let fake: FakeSupabase;
  const logLines: string[] = [];

  beforeAll(async () => {
    fake = await startFakeSupabase();
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    // The tests run against the rnd schema, but this app plays the OPERATIONAL API: the one that
    // holds the service key and deletes the Auth user (see 'R&D API' below for the other case).
    app = buildApp(
      testConfig({ appEnv: 'operational', rateLimitPerMinute: 10_000, logLevel: 'info' }),
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        authAdmin: createSupabaseAuthAdmin({
          baseUrl: fake.baseUrl,
          serviceRoleKey: FAKE_SERVICE_KEY,
          timeoutMs: 2000,
        }),
        logStream: { write: (line) => void logLines.push(line) },
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await fake?.close();
  });

  /** Clean slate: allowlist a, b and c; no accounts; cap 25. */
  beforeEach(async () => {
    fake.requests.length = 0;
    fake.status = 200;
    delete fake.respond;
    logLines.length = 0;
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com'), ('c@example.com')`,
      );
      await c.query(`update rnd.app_settings set value = '25' where key = 'user_cap'`);
    });
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const asA = () => as(A, 'a@example.com');
  const asB = () => as(B, 'b@example.com');

  const call = async (
    method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const count = (sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows[0].n as number);

  /** One plan with a week pattern, a day override, a task, a log and an event for a user. */
  async function seedPlan(userId: string, planId: string, name: string) {
    await testDb.admin(async (c) => {
      await c.query(
        `insert into rnd.plans (user_id, id, created_from, name, start_date)
         values ($1, $2, 'builder', $3, '2026-11-01')`,
        [userId, planId, name],
      );
      await c.query(
        `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours, window_start, window_end, timezone)
         values ($1, $2, '{1,2,3}', 2, '09:00', '17:00', 'Asia/Jerusalem')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.day_overrides (user_id, plan_id, date, is_study_day) values ($1, $2, '2026-11-02', false)`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
         values ($1, $2, 't1', $3, 'course', 3, 0)`,
        [userId, planId, `${name} task`],
      );
      await c.query(
        `insert into rnd.logs (user_id, id, plan_id, task_id, date, hours)
         values ($1, gen_random_uuid(), $2, 't1', '2026-11-03', 1.5)`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.events (user_id, plan_id, type) values ($1, $2, 'task.started')`,
        [userId, planId],
      );
      // Every other user-owned table (v0.2 day state and reviews, v0.3 practice and AI usage).
      await c.query(
        `insert into rnd.day_sessions (user_id, plan_id, date) values ($1, $2, '2026-11-03')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
         values ($1, $2, '2026-11-03', '[]', 'day_end')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.day_reviews (user_id, plan_id, date, difficulty, density, energy)
         values ($1, $2, '2026-11-03', 3, 3, 3)`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status)
         values ($1, $2, 'sg1', 'density_too_low', 'k', '{}', 'rejected')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.practice_contexts (user_id, plan_id, job_description)
         values ($1, $2, 'a job')`,
        [userId, planId],
      );
      const sessionId = randomUUID();
      await c.query(
        `insert into rnd.practice_sessions (user_id, id, plan_id, task_id, practice_kind, persona,
           channel, status, planned_minutes, ended_at, prompt_used)
         values ($1, $2, $3, 't1', 'mock_interview', 'interviewer', 'in_app', 'finished', 30, now(), 'p')`,
        [userId, sessionId, planId],
      );
      await c.query(
        `insert into rnd.practice_messages (user_id, session_id, id, seq, role, content)
         values ($1, $2, gen_random_uuid(), 0, 'user', 'hello')`,
        [userId, sessionId],
      );
      await c.query(
        `insert into rnd.practice_feedback (user_id, session_id, source, score)
         values ($1, $2, 'pasted_block', 7)`,
        [userId, sessionId],
      );
      await c.query(
        `insert into rnd.ai_usage_daily (user_id, day, purpose, requests, avoided)
         values ($1, '2026-11-03', 'practice_message', 2, 1)`,
        [userId],
      );
      await c.query(
        `insert into rnd.ai_cache (user_id, key, purpose, text, expires_at)
         values ($1, $2, 'day_overview', 'cached', now() + interval '1 day')`,
        [userId, createHash('sha256').update(userId).digest('hex')],
      );
      await c.query(
        `insert into rnd.calendar_connections (user_id, refresh_token_ciphertext)
         values ($1, 'secret-ciphertext')`,
        [userId],
      );
      await c.query(
        `insert into rnd.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, expires_at)
         values ($1, $2, 'ct', now() + interval '10 minutes')`,
        [userId, createHash('sha256').update(`state${userId}`).digest('hex')],
      );
      await c.query(
        `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
         values ($1, $2, 'k1', 't1', 'ev1', '2026-11-03 09:00+00', '2026-11-03 10:00+00')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
         values ($1, $2, 'k2', 't1', '2026-11-03 11:00+00', '2026-11-03 12:00+00', 'moved')`,
        [userId, planId],
      );
      await c.query(
        `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, kind)
         values ($1, '2026-11-03', 'x1', 'cal', 60, 120, 'busy')`,
        [userId],
      );
      await c.query(`insert into rnd.calendar_sources (user_id, calendar_id) values ($1, 'cal')`, [
        userId,
      ]);
      await c.query(
        `insert into rnd.user_profiles (user_id, answers, setup_status) values ($1, '{"days_per_week":[1]}', 'in_progress')
         on conflict (user_id) do nothing`,
        [userId],
      );
    });
  }

  /** Every base table of the rnd schema that has a user_id column, read from the database. */
  const userTables = () =>
    testDb.admin(async (c) => {
      const { rows } = await c.query<{ table_name: string }>(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t
             on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'rnd' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'
          order by 1`,
      );
      return rows.map((r) => r.table_name);
    });

  describe('authentication (401)', () => {
    const routes: Array<['GET' | 'PATCH' | 'POST' | 'DELETE', string, unknown?]> = [
      ['GET', '/me'],
      ['PATCH', '/me', { displayName: 'x' }],
      ['POST', '/me/legal-acceptances', { document: 'terms', version: '0.1' }],
      ['GET', '/me/export'],
      ['DELETE', '/me', { confirmation: 'delete my account' }],
    ];

    it.each(routes)('%s %s without a token answers 401 in the error shape', async (m, u, body) => {
      const res = await call(m, u, {}, body);
      expect(res.statusCode).toBe(401);
      const parsed = errorResponseSchema.parse(res.json());
      expect(parsed.error.code).toBe('unauthorized');
      expect(parsed.error.requestId).toBe(res.headers['x-request-id']);
    });

    it('answers 401 before it validates the body (nothing is learned without a token)', async () => {
      const res = await call('PATCH', '/me', {}, { nonsense: true });
      expect(res.statusCode).toBe(401);
    });

    const bad: Array<[string, () => Promise<string>]> = [
      ['expired', () => keys.sign({ sub: A, email: 'a@example.com', expiresIn: -60 })],
      ['wrong audience', () => keys.sign({ sub: A, email: 'a@example.com', aud: 'anon' })],
      ['wrong issuer', () => keys.sign({ sub: A, email: 'a@example.com', iss: 'https://x.test' })],
      ['bad signature', () => keys.sign({ sub: A, email: 'a@example.com', otherKey: true })],
      ['alg none', async () => unsignedToken(A)],
      ['missing sub', () => keys.sign({ sub: null, email: 'a@example.com' })],
    ];

    it.each(bad)('rejects a token that is %s, and creates no account', async (_n, make) => {
      const res = await call('GET', '/me', { authorization: `Bearer ${await make()}` });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
    });

    it.each(['Basic abc', 'Bearer', 'Bearer  x', 'bearer x y', 'Token abc'])(
      'rejects the Authorization header %j',
      async (header) => {
        const res = await call('GET', '/me', { authorization: header });
        expect(res.statusCode).toBe(401);
      },
    );
  });

  describe('first sign-in and the allowlist', () => {
    it('provisions the account on the first GET /me and is idempotent', async () => {
      const first = await call('GET', '/me', await asA());
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        id: A,
        email: 'a@example.com',
        displayName: null,
        role: 'user',
        legal: {
          terms: { currentVersion: '0.1', accepted: false },
          privacy: { currentVersion: '0.1', accepted: false },
          allAccepted: false,
        },
      });
      const second = await call('GET', '/me', await asA());
      expect(second.statusCode).toBe(200);
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(1);
      expect(second.json().createdAt).toBe(first.json().createdAt);
      expect(new Date(second.json().lastSeenAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.json().lastSeenAt).getTime(),
      );
    });

    it('lower-cases the token email when matching the allowlist', async () => {
      const res = await call('GET', '/me', await as(A, 'A@Example.COM'));
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('a@example.com');
    });

    it('refuses an email that is not approved, with a generic 403 and no account', async () => {
      const res = await call('GET', '/me', await as(C, 'stranger@example.com'));
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject(GENERIC_403);
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
    });

    it('refuses a token without an email claim', async () => {
      const res = await call('GET', '/me', {
        authorization: `Bearer ${await keys.sign({ sub: A, email: null })}`,
      });
      expect(res.statusCode).toBe(403);
    });

    it('does not reveal whether an email is approved: same answer for every refusal', async () => {
      await testDb.admin((c) =>
        c.query(`update rnd.app_settings set value = '0' where key = 'user_cap'`),
      );
      const notApproved = await call('GET', '/me', await as(C, 'stranger@example.com'));
      const capReached = await call('GET', '/me', await asA());
      expect(capReached.statusCode).toBe(403);
      expect(notApproved.statusCode).toBe(capReached.statusCode);
      expect(notApproved.json().error.code).toBe(capReached.json().error.code);
      expect(notApproved.json().error.message).toBe(capReached.json().error.message);
    });

    it('enforces the user cap for new accounts but lets existing users in', async () => {
      await testDb.admin((c) =>
        c.query(`update rnd.app_settings set value = '1' where key = 'user_cap'`),
      );
      expect((await call('GET', '/me', await asA())).statusCode).toBe(200);
      expect((await call('GET', '/me', await asB())).statusCode).toBe(403);
      expect((await call('GET', '/me', await asA())).statusCode).toBe(200);
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(1);
    });

    it('refuses a disabled account', async () => {
      await call('GET', '/me', await asA());
      await testDb.admin((c) => c.query(`update rnd.app_users set status = 'disabled'`));
      const res = await call('GET', '/me', await asA());
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject(GENERIC_403);
    });

    it('ignores any user id the client sends (query, header, body)', async () => {
      await call('GET', '/me', await asB());
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/me?user_id=${B}&userId=${B}`,
        headers: { ...(await asA()), 'x-user-id': B },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(A);
    });
  });

  describe('PATCH /me', () => {
    // Changing the profile is not on the list of routes that work before the Terms are accepted.
    beforeEach(async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await testDb.admin((c) => acceptCurrentLegal(c, [A, B]));
    });

    it('changes the display name, trims it and can clear it', async () => {
      const res = await call('PATCH', '/me', await asA(), { displayName: '  Ada  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json().displayName).toBe('Ada');
      const cleared = await call('PATCH', '/me', await asA(), { displayName: null });
      expect(cleared.json().displayName).toBeNull();
    });

    it.each([
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(81) },
      { displayName: 'ok', role: 'admin' },
      { displayName: 'ok', userId: B },
      { displayName: 'ok', email: 'x@example.com' },
      { role: 'admin' },
      {},
    ])('rejects the body %j with 400 and changes nothing', async (body) => {
      await call('GET', '/me', await asA());
      const res = await call('PATCH', '/me', await asA(), body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
      const row = await testDb.admin(
        async (c) => (await c.query('select role, display_name from rnd.app_users')).rows[0],
      );
      expect(row).toEqual({ role: 'user', display_name: null });
    });

    it('does not touch another user', async () => {
      await call('GET', '/me', await asB());
      await call('PATCH', '/me', await asA(), { displayName: 'Ada' });
      const names = await testDb.admin(
        async (c) => (await c.query('select id, display_name from rnd.app_users order by id')).rows,
      );
      expect(names).toEqual([
        { id: A, display_name: 'Ada' },
        { id: B, display_name: null },
      ]);
    });
  });

  describe('POST /me/legal-acceptances', () => {
    const accept = async (document: string, version: string) =>
      call('POST', '/me/legal-acceptances', await asA(), { document, version });

    it('records the acceptance and reports it on /me', async () => {
      const terms = await accept('terms', '0.1');
      expect(terms.statusCode).toBe(200);
      expect(terms.json().legal.terms.accepted).toBe(true);
      expect(terms.json().legal.allAccepted).toBe(false);
      const both = await accept('privacy', '0.1');
      expect(both.json().legal.allAccepted).toBe(true);
      expect((await call('GET', '/me', await asA())).json().legal.allAccepted).toBe(true);
    });

    it('is idempotent and keeps the first acceptance time', async () => {
      await accept('terms', '0.1');
      const first = await testDb.admin(
        async (c) => (await c.query('select accepted_at from rnd.legal_acceptances')).rows[0],
      );
      const again = await accept('terms', '0.1');
      expect(again.statusCode).toBe(200);
      const rows = await testDb.admin(
        async (c) => (await c.query('select accepted_at from rnd.legal_acceptances')).rows,
      );
      expect(rows).toEqual([first]);
    });

    it('refuses a version that is not the current one (422) and an unknown document (400)', async () => {
      const old = await accept('terms', '0.0');
      expect(old.statusCode).toBe(422);
      expect(await count('select count(*)::int as n from rnd.legal_acceptances')).toBe(0);
      expect((await accept('cookies', '0.1')).statusCode).toBe(400);
    });

    it('does not report an older accepted version as accepted', async () => {
      await call('GET', '/me', await asA());
      await testDb.admin((c) =>
        c.query(
          `insert into rnd.legal_acceptances (user_id, document, version) values ($1, 'terms', '0.0')`,
          [A],
        ),
      );
      const me = await call('GET', '/me', await asA());
      expect(me.json().legal.terms.accepted).toBe(false);
    });
  });

  describe('GET /me/export', () => {
    it('contains all of the user rows and none of another user', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await seedPlan(A, PLAN_A, 'Plan of A');
      await seedPlan(B, PLAN_B, 'Plan of B');
      await call('POST', '/me/legal-acceptances', await asA(), {
        document: 'terms',
        version: '0.1',
      });

      const res = await call('GET', '/me/export', await asA());
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      const body = res.json();
      expect(body.formatVersion).toBe(1);
      expect(body.user).toMatchObject({ id: A, email: 'a@example.com' });
      expect(body.plans.map((p: { name: string }) => p.name)).toEqual(['Plan of A']);
      expect(body.weekPatterns).toHaveLength(1);
      expect(body.dayOverrides).toEqual([
        expect.objectContaining({ date: '2026-11-02', is_study_day: false }),
      ]);
      expect(body.tasks.map((t: { title: string }) => t.title)).toEqual(['Plan of A task']);
      expect(body.logs).toHaveLength(1);
      expect(body.logs[0].date).toBe('2026-11-03');
      expect(body.events).toHaveLength(1);
      expect(body.legalAcceptances).toEqual([expect.objectContaining({ document: 'terms' })]);

      // Every row of every section belongs to A.
      const owned = [
        body.plans,
        body.weekPatterns,
        body.dayOverrides,
        body.tasks,
        body.logs,
        body.events,
        body.legalAcceptances,
      ].flat();
      expect(owned.length).toBeGreaterThan(0);
      for (const row of owned) expect(row.user_id).toBe(A);
      expect(JSON.stringify(body)).not.toContain('Plan of B');
      expect(JSON.stringify(body)).not.toContain('b@example.com');
    });

    it('exports every table that has a user_id column, so a new table cannot be forgotten', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await seedPlan(A, PLAN_A, 'Plan of A');
      await seedPlan(B, PLAN_B, 'Plan of B');
      for (const who of [asA, asB]) {
        await call('POST', '/me/legal-acceptances', await who(), {
          document: 'terms',
          version: '0.1',
        });
      }

      // The tables of the database (plus app_users, exported as `user`) against the export list.
      const tables = await userTables();
      expect(tables.length).toBeGreaterThanOrEqual(17);
      expect(tables).toEqual(
        [...Object.values(EXPORT_SECTIONS).map((s) => s.table), ...EXPORT_EXCLUDED_TABLES].sort(),
      );

      // And the response really carries a non-empty section for each of them, A's rows only.
      const body = (await call('GET', '/me/export', await asA())).json();
      for (const [key, { table }] of Object.entries(EXPORT_SECTIONS)) {
        expect(Array.isArray(body[key]), key).toBe(true);
        expect(body[key].length, `${key} (${table}) has rows`).toBeGreaterThan(0);
        for (const row of body[key]) expect(row.user_id, key).toBe(A);
      }
      expect(JSON.stringify(body)).not.toContain('Plan of B');
      // Secrets stay out of the export.
      expect(JSON.stringify(body)).not.toContain('secret-ciphertext');
      expect(body.calendarConnections[0]).not.toHaveProperty('refresh_token_ciphertext');
    });

    it('does not let a second user read the first user data, even by asking for it', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await seedPlan(A, PLAN_A, 'Plan of A');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/me/export?user_id=${A}`,
        headers: { ...(await asB()), 'x-user-id': A },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.id).toBe(B);
      expect(body.plans).toEqual([]);
      expect(body.tasks).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('Plan of A');
    });
  });

  describe('DELETE /me', () => {
    const del = async (headers: Record<string, string>, confirmation: unknown) =>
      call('DELETE', '/me', headers, { confirmation });

    it('needs the typed confirmation and deletes nothing without it', async () => {
      await call('GET', '/me', await asA());
      for (const wrong of ['', 'delete', 'DELETE MY ACCOUNT', 'delete my account ', 'yes']) {
        const res = await del(await asA(), wrong);
        expect(res.statusCode).toBe(422);
      }
      expect((await call('DELETE', '/me', await asA())).statusCode).toBe(400);
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(1);
    });

    it('removes the account and every row it owns, and nobody else', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await seedPlan(A, PLAN_A, 'Plan of A');
      await seedPlan(B, PLAN_B, 'Plan of B');
      await call('POST', '/me/legal-acceptances', await asA(), {
        document: 'terms',
        version: '0.1',
      });
      await call('POST', '/me/legal-acceptances', await asB(), {
        document: 'terms',
        version: '0.1',
      });

      const res = await del(await asA(), 'delete my account');
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      for (const table of [
        'plans',
        'week_patterns',
        'day_overrides',
        'tasks',
        'logs',
        'events',
        'legal_acceptances',
      ]) {
        expect(
          await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [A]),
          table,
        ).toBe(0);
        expect(
          await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [B]),
          table,
        ).toBeGreaterThan(0);
      }
      expect(await count('select count(*)::int as n from rnd.app_users where id = $1', [A])).toBe(
        0,
      );
      expect(await count('select count(*)::int as n from rnd.app_users where id = $1', [B])).toBe(
        1,
      );
    });

    it('removes the rows of every table that has a user_id column, and keeps the other user’s', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      await seedPlan(A, PLAN_A, 'Plan of A');
      await seedPlan(B, PLAN_B, 'Plan of B');
      for (const who of [asA, asB]) {
        await call('POST', '/me/legal-acceptances', await who(), {
          document: 'terms',
          version: '0.1',
        });
      }
      const tables = await userTables();
      // Seeded for both users first, so a table that is not covered cannot pass by being empty.
      for (const table of tables) {
        expect(
          await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [A]),
          `${table} seeded for A`,
        ).toBeGreaterThan(0);
      }

      expect((await del(await asA(), 'delete my account')).statusCode).toBe(204);

      for (const table of tables) {
        expect(
          await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [A]),
          `${table} after delete (A)`,
        ).toBe(0);
        expect(
          await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [B]),
          `${table} after delete (B)`,
        ).toBeGreaterThan(0);
      }
    });

    it('cannot be undone by the same token: the email leaves the allowlist', async () => {
      await call('GET', '/me', await asA());
      await del(await asA(), 'delete my account');
      expect(
        await count(
          `select count(*)::int as n from rnd.allowed_emails where email = 'a@example.com'`,
        ),
      ).toBe(0);
      const again = await call('GET', '/me', await asA());
      expect(again.statusCode).toBe(403);
      expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
    });

    it('ignores a user id sent by the client and deletes only the token owner', async () => {
      await call('GET', '/me', await asA());
      await call('GET', '/me', await asB());
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/me?user_id=${B}`,
        headers: { ...(await asA()), 'x-user-id': B },
        payload: { confirmation: 'delete my account' },
      });
      expect(res.statusCode).toBe(204);
      const ids = await testDb.admin(
        async (c) => (await c.query('select id from rnd.app_users')).rows,
      );
      expect(ids).toEqual([{ id: B }]);
    });
    describe('Supabase Auth user', () => {
      it('is deleted exactly once, with the verified id and both key headers', async () => {
        await call('GET', '/me', await asA());
        await call('GET', '/me', await asB());
        const res = await del(await asA(), 'delete my account');
        expect(res.statusCode).toBe(204);
        expect(fake.requests).toHaveLength(1);
        const [req] = fake.requests;
        expect(req!.method).toBe('DELETE');
        expect(req!.url).toBe(`/auth/v1/admin/users/${A}`);
        expect(req!.headers.apikey).toBe(FAKE_SERVICE_KEY);
        expect(req!.headers.authorization).toBe(`Bearer ${FAKE_SERVICE_KEY}`);
      });

      it('never sends another id, whatever the client puts in the request', async () => {
        await call('GET', '/me', await asA());
        await call('GET', '/me', await asB());
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/me?user_id=${B}&id=${C}`,
          headers: { ...(await asA()), 'x-user-id': B },
          payload: { confirmation: 'delete my account' },
        });
        expect(fake.requests.map((r) => r.url)).toEqual([`/auth/v1/admin/users/${A}`]);
      });

      it('does not call Supabase without the typed confirmation', async () => {
        await call('GET', '/me', await asA());
        await del(await asA(), 'nope');
        expect(fake.requests).toHaveLength(0);
      });

      it('treats a Supabase 404 (already deleted) as success', async () => {
        await call('GET', '/me', await asA());
        fake.status = 404;
        const res = await del(await asA(), 'delete my account');
        expect(res.statusCode).toBe(204);
        expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
      });

      it('keeps all data when Supabase fails (502), and a retry then completes', async () => {
        await call('GET', '/me', await asA());
        await seedPlan(A, PLAN_A, 'Plan of A');
        fake.status = 500;
        const failed = await del(await asA(), 'delete my account');
        expect(failed.statusCode).toBe(502);
        expect(failed.json().error.code).toBe('auth_deletion_failed');
        // Rolled back: the account, its plan and its allowlist entry are all still there.
        expect(await count('select count(*)::int as n from rnd.app_users')).toBe(1);
        expect(await count('select count(*)::int as n from rnd.plans')).toBe(1);
        expect(
          await count(
            `select count(*)::int as n from rnd.allowed_emails where email = 'a@example.com'`,
          ),
        ).toBe(1);
        // The same token still works, so the user can retry.
        expect((await call('GET', '/me', await asA())).statusCode).toBe(200);

        fake.status = 200;
        const retry = await del(await asA(), 'delete my account');
        expect(retry.statusCode).toBe(204);
        expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
        expect(await count('select count(*)::int as n from rnd.plans')).toBe(0);
      });

      it('a deleted account cannot be re-provisioned with the still-valid token', async () => {
        await call('GET', '/me', await asA());
        await del(await asA(), 'delete my account');
        fake.requests.length = 0;
        expect((await call('GET', '/me', await asA())).statusCode).toBe(403);
        expect((await del(await asA(), 'delete my account')).statusCode).toBe(403);
        expect(await count('select count(*)::int as n from rnd.app_users')).toBe(0);
        expect(fake.requests).toHaveLength(0);
      });

      it('fails closed (502, data kept) when no service key is configured', async () => {
        const noKey = buildApp(testConfig({ appEnv: 'operational', rateLimitPerMinute: 10_000 }), {
          verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
          db,
        });
        const headers = await asA();
        await noKey.inject({ method: 'GET', url: '/api/v1/me', headers });
        const res = await noKey.inject({
          method: 'DELETE',
          url: '/api/v1/me',
          headers,
          payload: { confirmation: 'delete my account' },
        });
        expect(res.statusCode).toBe(502);
        expect(await count('select count(*)::int as n from rnd.app_users')).toBe(1);
        await noKey.close();
      });

      it('never puts the service key in a response or a log line', async () => {
        const responses: string[] = [];
        // Failures first (the account stays), then the successful delete.
        for (const status of [500, 401, 403, 404]) {
          await call('GET', '/me', await asA());
          fake.status = status;
          const res = await del(await asA(), 'delete my account');
          responses.push(res.body, JSON.stringify(res.headers));
        }
        // The fake echoes the key in its body; neither that body nor the key may leak.
        const everything = responses.join('\n') + logLines.join('\n');
        expect(everything).not.toContain(FAKE_SERVICE_KEY);
        expect(everything).not.toContain('fake response');
        expect(logLines.some((l) => l.includes('auth user deletion failed'))).toBe(true);
      });
    });

    describe('R&D API (shares the Auth project with Operational)', () => {
      it.each([
        ['with admin settings in the config (a mistake)', true],
        ['without any admin settings (the real R&D setup)', false],
      ])('deletes only R&D data, answers 204, no admin call: %s', async (_label, withAdmin) => {
        // Even a config that (wrongly) carries admin settings must not reach the admin API on R&D.
        const rnd = buildApp(
          testConfig({
            appEnv: 'rnd',
            rateLimitPerMinute: 10_000,
            supabaseAdmin: withAdmin
              ? { url: fake.baseUrl, serviceRoleKey: FAKE_SERVICE_KEY }
              : null,
          }),
          { verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }), db },
        );
        await rnd.ready();
        const headers = await asA();
        await rnd.inject({ method: 'GET', url: '/api/v1/me', headers });
        await rnd.inject({ method: 'GET', url: '/api/v1/me', headers: await asB() });
        await seedPlan(A, PLAN_A, 'Plan of A');
        await seedPlan(B, PLAN_B, 'Plan of B');

        const res = await rnd.inject({
          method: 'DELETE',
          url: '/api/v1/me',
          headers,
          payload: { confirmation: 'delete my account' },
        });
        expect(res.statusCode).toBe(204);
        expect(fake.requests).toHaveLength(0);
        for (const table of ['plans', 'tasks', 'logs', 'events']) {
          expect(
            await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [A]),
            table,
          ).toBe(0);
          expect(
            await count(`select count(*)::int as n from rnd.${table} where user_id = $1`, [B]),
            table,
          ).toBeGreaterThan(0);
        }
        expect(await count('select count(*)::int as n from rnd.app_users where id = $1', [A])).toBe(
          0,
        );
        await rnd.close();
      });
    });
  });

  describe('API surface', () => {
    it('lists the account routes in the OpenAPI document', async () => {
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
      expect(Object.keys(doc.paths['/api/v1/me']).sort()).toEqual(['delete', 'get', 'patch']);
      expect(doc.paths['/api/v1/me/export'].get).toBeDefined();
      expect(doc.paths['/api/v1/me/legal-acceptances'].post).toBeDefined();
      expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    });

    it('rate-limits the account routes like every other route', async () => {
      const limited = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 2 }), {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
      });
      const headers = await asA();
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push(
          (await limited.inject({ method: 'GET', url: '/api/v1/me', headers })).statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 429]);
      await limited.close();
    });
  });
});

describe('without a database', () => {
  it('answers 503 for a valid token and 401 for an invalid one', async () => {
    const keys = await makeTestKeys();
    const app = buildApp(testConfig({ appEnv: 'rnd' }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db: null,
    });
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${await keys.sign({ sub: A })}` },
    });
    expect(ok.statusCode).toBe(503);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('rejects every token when sign-in is not configured (fail closed)', async () => {
    const keys = await makeTestKeys();
    const app = buildApp(testConfig({ appEnv: 'rnd', supabase: null, databaseUrl: null }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${await keys.sign({ sub: A })}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
