import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/index';
import {
  ENVS,
  TEST_DATABASE_URL,
  TEST_SUPERUSER_URL,
  asUser,
  dbAvailable,
  prepareEnvironments,
  withClient,
  type TestEnvironments,
} from './helpers';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const PLAN_B = 'b0000000-0000-4000-8000-000000000002';
/** A second plan of user B that has no week pattern yet. */
const PLAN_B2 = 'b0000000-0000-4000-8000-000000000003';
const EVENT_A = 'a0000000-0000-4000-8000-0000000000e1';
const EVENT_B = 'b0000000-0000-4000-8000-0000000000e2';
const LOG_A = 'a0000000-0000-4000-8000-0000000000a1';
const LOG_B = 'b0000000-0000-4000-8000-0000000000b1';
const SESSION_A = 'a0000000-0000-4000-8000-0000000000c1';
const SESSION_B = 'b0000000-0000-4000-8000-0000000000c2';
/** A finished session of user B without feedback, so a feedback row can still be inserted. */
const SESSION_B2 = 'b0000000-0000-4000-8000-0000000000c3';
const HEX_KEY = (c: string) => c.repeat(64);

const RLS_ERROR = /row-level security policy/;
const NO_PRIVILEGE = /permission denied for table/;

/** One user-owned table: how to find the user's rows and how to write a valid row. */
interface UserTable {
  name: string;
  /** Column that holds the owner's user id (`id` for app_users). */
  ownerColumn: string;
  /** A harmless UPDATE assignment, or null when the app has no UPDATE right at all. */
  update: string | null;
  /** Whether the app may DELETE its own rows. */
  deletable: boolean;
  /** A valid INSERT for `user`, attached to user B's plan so only RLS can stop it; null if the app cannot insert. */
  insert: ((user: string) => string) | null;
}

const TABLES: UserTable[] = [
  {
    name: 'app_users',
    ownerColumn: 'id',
    update: `display_name = 'changed'`,
    deletable: false,
    insert: null,
  },
  {
    name: 'legal_acceptances',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.legal_acceptances (user_id, document, version) values ('${u}', 'privacy', 'v9')`,
  },
  {
    name: 'plans',
    ownerColumn: 'user_id',
    update: `name = 'changed'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.plans (user_id, id, created_from, name, start_date)
       values ('${u}', gen_random_uuid(), 'builder', 'p', '2026-01-01')`,
  },
  {
    name: 'week_patterns',
    ownerColumn: 'user_id',
    update: `default_hours = 1`,
    deletable: true,
    // Plan B2 has no pattern yet in the seed, so this is the one valid row to insert.
    insert: (u) =>
      `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
         window_start, window_end, timezone)
       values ('${u}', '${PLAN_B2}', '{1,2}', 2, '09:00', '17:00', 'Asia/Jerusalem')`,
  },
  {
    name: 'day_overrides',
    ownerColumn: 'user_id',
    update: `is_study_day = not is_study_day`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.day_overrides (user_id, plan_id, date, is_study_day)
       values ('${u}', '${PLAN_B}', '2026-02-02', true)`,
  },
  {
    name: 'tasks',
    ownerColumn: 'user_id',
    update: `title = 'changed'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
       values ('${u}', '${PLAN_B}', 't9', 'x', 'course', 1, 9)`,
  },
  {
    name: 'logs',
    ownerColumn: 'user_id',
    update: `note = 'changed'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.logs (user_id, id, plan_id, task_id, date, hours)
       values ('${u}', gen_random_uuid(), '${PLAN_B}', 't1', '2026-01-05', 1)`,
  },
  {
    name: 'day_sessions',
    ownerColumn: 'user_id',
    // The app may change only ended_at (column grant); no deletes.
    update: `ended_at = now()`,
    deletable: false,
    insert: (u) =>
      `insert into rnd.day_sessions (user_id, plan_id, date) values ('${u}', '${PLAN_B}', '2026-01-07')`,
  },
  {
    name: 'schedule_days',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
       values ('${u}', '${PLAN_B}', '2026-01-07', '[]', 'day_end')`,
  },
  {
    name: 'day_reviews',
    ownerColumn: 'user_id',
    // The app may re-save ratings, note and outcomes (column grant); no deletes.
    update: `note = 'changed'`,
    deletable: false,
    insert: (u) =>
      `insert into rnd.day_reviews (user_id, plan_id, date, difficulty, density, energy)
       values ('${u}', '${PLAN_B}', '2026-01-07', 3, 3, 3)`,
  },
  {
    name: 'adjustments',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status)
       values ('${u}', '${PLAN_B}', 'sg_new', 'density_too_low', '2026-01-07', '{}', 'rejected')`,
  },
  {
    name: 'events',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.events (user_id, plan_id, type) values ('${u}', '${PLAN_B}', 'task.started')`,
  },
  {
    name: 'practice_contexts',
    ownerColumn: 'user_id',
    update: `job_description = 'changed'`,
    deletable: false,
    // Plan B2 has no practice context in the seed.
    insert: (u) =>
      `insert into rnd.practice_contexts (user_id, plan_id, job_description)
       values ('${u}', '${PLAN_B2}', 'a job')`,
  },
  {
    name: 'practice_sessions',
    ownerColumn: 'user_id',
    update: `providers_used = '{x}'`,
    deletable: false,
    insert: (u) =>
      `insert into rnd.practice_sessions (user_id, id, plan_id, task_id, practice_kind, persona,
         channel, planned_minutes, prompt_used)
       values ('${u}', gen_random_uuid(), '${PLAN_B}', 't1', 'mock_interview', 'interviewer',
         'self', 30, 'p')`,
  },
  {
    name: 'practice_messages',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.practice_messages (user_id, session_id, id, seq, role, content)
       values ('${u}', '${SESSION_B}', gen_random_uuid(), 9, 'user', 'hi')`,
  },
  {
    name: 'practice_feedback',
    ownerColumn: 'user_id',
    update: null,
    deletable: false,
    insert: (u) =>
      `insert into rnd.practice_feedback (user_id, session_id, source, score)
       values ('${u}', '${SESSION_B2}', 'self_rubric', 5)`,
  },
  {
    name: 'ai_usage_daily',
    ownerColumn: 'user_id',
    update: `requests = requests + 1`,
    deletable: false,
    insert: (u) =>
      `insert into rnd.ai_usage_daily (user_id, day, purpose, requests)
       values ('${u}', '2026-01-09', 'day_overview', 1)`,
  },
  {
    name: 'ai_cache',
    ownerColumn: 'user_id',
    update: `text = 'changed'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.ai_cache (user_id, key, purpose, text, expires_at)
       values ('${u}', '${HEX_KEY('c')}', 'practice_feedback', 't', now() + interval '1 day')`,
  },
  {
    name: 'calendar_connections',
    ownerColumn: 'user_id',
    update: `status = 'needs_reconnect'`,
    deletable: true,
    // One connection per user and both seeded users have one: the upsert updates it, which only
    // works for the signed-in user's own row.
    insert: (u) =>
      `insert into rnd.calendar_connections (user_id, status) values ('${u}', 'connected')
       on conflict (user_id) do update set status = excluded.status`,
  },
  {
    name: 'calendar_oauth_states',
    ownerColumn: 'user_id',
    update: null,
    deletable: true,
    insert: (u) =>
      `insert into rnd.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, expires_at)
       values ('${u}', '${HEX_KEY('f')}', 'ct', now() + interval '10 minutes')`,
  },
  {
    name: 'calendar_event_links',
    ownerColumn: 'user_id',
    update: `generation = generation + 1`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
       values ('${u}', '${PLAN_B}', 'new-block', 't1', 'ev9', '2026-01-07 09:00+00', '2026-01-07 10:00+00')`,
  },
  {
    name: 'calendar_locked_blocks',
    ownerColumn: 'user_id',
    update: `reason = 'deleted'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
       values ('${u}', '${PLAN_B}', 'new-block', 't1', '2026-01-07 09:00+00', '2026-01-07 10:00+00', 'moved')`,
  },
  {
    name: 'calendar_busy',
    ownerColumn: 'user_id',
    update: `title = 'changed'`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, kind)
       values ('${u}', '2026-01-07', 'ext9', 'cal1', 540, 600, 'busy')`,
  },
  {
    name: 'calendar_sources',
    ownerColumn: 'user_id',
    update: `blocks_time = true`,
    deletable: true,
    insert: (u) =>
      `insert into rnd.calendar_sources (user_id, calendar_id, name) values ('${u}', 'cal9', 'Work')`,
  },
  {
    name: 'user_profiles',
    ownerColumn: 'user_id',
    update: `setup_status = 'dismissed'`,
    deletable: true,
    // One profile per user and both seeded users have one: the upsert updates it, which only
    // works for the signed-in user's own row.
    insert: (u) =>
      `insert into rnd.user_profiles (user_id, setup_status) values ('${u}', 'in_progress')
       on conflict (user_id) do update set setup_status = excluded.setup_status`,
  },
];

/** Tables with a user_id column the app writes; app_settings is global and tested on its own. */
const ALL_TABLE_NAMES = [...TABLES.map((t) => t.name), 'app_settings'];
/** Plus the environment-wide counter, which no user owns and the app cannot touch directly. */
const READABLE_BY_BACKUP = [...ALL_TABLE_NAMES, 'ai_provider_usage'];

async function seed(client: pg.Client): Promise<void> {
  await client.query('begin');
  try {
    // The owner role stands in for the admin path: RLS is enabled but not forced for it.
    await client.query('set local role owner_rnd');
    await client.query(`
      insert into rnd.app_users (id, email, display_name) values
        ('${USER_A}', 'a@example.test', 'Ann'), ('${USER_B}', 'b@example.test', 'Bob');
      insert into rnd.legal_acceptances (user_id, document, version) values
        ('${USER_A}', 'terms', 'v1'), ('${USER_B}', 'terms', 'v1');
      insert into rnd.plans (user_id, id, created_from, name, start_date) values
        ('${USER_A}', '${PLAN_A}', 'builder', 'Plan A', '2026-01-01'),
        ('${USER_B}', '${PLAN_B}', 'import', 'Plan B', '2026-01-01'),
        ('${USER_B}', '${PLAN_B2}', 'import', 'Plan B2', '2026-01-01');
      insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
        window_start, window_end, timezone) values
        ('${USER_A}', '${PLAN_A}', '{0,1,2}', 3, '09:00', '17:00', 'Asia/Jerusalem'),
        ('${USER_B}', '${PLAN_B}', '{3}', 2, '10:00', '16:00', 'UTC');
      insert into rnd.day_overrides (user_id, plan_id, date, is_study_day) values
        ('${USER_A}', '${PLAN_A}', '2026-01-02', true),
        ('${USER_B}', '${PLAN_B}', '2026-01-02', false);
      insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order) values
        ('${USER_A}', '${PLAN_A}', 't1', 'A task', 'course', 4, 0),
        ('${USER_B}', '${PLAN_B}', 't1', 'B task', 'course', 4, 0);
      insert into rnd.logs (user_id, id, plan_id, task_id, date, hours) values
        ('${USER_A}', '${LOG_A}', '${PLAN_A}', 't1', '2026-01-05', 1.5),
        ('${USER_B}', '${LOG_B}', '${PLAN_B}', 't1', '2026-01-05', 2);
      insert into rnd.events (user_id, id, plan_id, type) values
        ('${USER_A}', '${EVENT_A}', '${PLAN_A}', 'task.logged'),
        ('${USER_B}', '${EVENT_B}', '${PLAN_B}', 'task.logged');
      insert into rnd.day_sessions (user_id, plan_id, date, started_at) values
        ('${USER_A}', '${PLAN_A}', '2026-01-05', '2026-01-05 07:00+00'),
        ('${USER_B}', '${PLAN_B}', '2026-01-05', '2026-01-05 07:00+00');
      insert into rnd.schedule_days (user_id, plan_id, date, blocks, source) values
        ('${USER_A}', '${PLAN_A}', '2026-01-05', '[]', 'day_end'),
        ('${USER_B}', '${PLAN_B}', '2026-01-05', '[]', 'auto_rollover');
      insert into rnd.day_reviews (user_id, plan_id, date, difficulty, density, energy) values
        ('${USER_A}', '${PLAN_A}', '2026-01-05', 2, 4, 3),
        ('${USER_B}', '${PLAN_B}', '2026-01-05', 3, 3, 3);
      insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status) values
        ('${USER_A}', '${PLAN_A}', 'sg_a1', 'density_too_low', '2026-01-05', '{}', 'rejected'),
        ('${USER_B}', '${PLAN_B}', 'sg_b1', 'density_too_low', '2026-01-05', '{}', 'rejected');
      insert into rnd.practice_contexts (user_id, plan_id, job_description) values
        ('${USER_A}', '${PLAN_A}', 'job of A'), ('${USER_B}', '${PLAN_B}', 'job of B');
      insert into rnd.practice_sessions (user_id, id, plan_id, task_id, practice_kind, persona,
        channel, status, planned_minutes, ended_at, prompt_used) values
        ('${USER_A}', '${SESSION_A}', '${PLAN_A}', 't1', 'mock_interview', 'interviewer',
          'in_app', 'finished', 30, now(), 'prompt A'),
        ('${USER_B}', '${SESSION_B}', '${PLAN_B}', 't1', 'mock_interview', 'interviewer',
          'in_app', 'finished', 30, now(), 'prompt B'),
        ('${USER_B}', '${SESSION_B2}', '${PLAN_B}', 't1', 'mock_interview', 'interviewer',
          'self', 'finished', 30, now(), 'prompt B2');
      insert into rnd.practice_messages (user_id, session_id, id, seq, role, content) values
        ('${USER_A}', '${SESSION_A}', gen_random_uuid(), 0, 'user', 'hello A'),
        ('${USER_B}', '${SESSION_B}', gen_random_uuid(), 0, 'user', 'hello B');
      insert into rnd.practice_feedback (user_id, session_id, source, score) values
        ('${USER_A}', '${SESSION_A}', 'model_json', 7),
        ('${USER_B}', '${SESSION_B}', 'pasted_block', 6);
      insert into rnd.ai_usage_daily (user_id, day, purpose, requests, avoided) values
        ('${USER_A}', '2026-01-05', 'practice_message', 3, 1),
        ('${USER_B}', '2026-01-05', 'practice_message', 2, 0);
      insert into rnd.ai_cache (user_id, key, purpose, text, expires_at) values
        ('${USER_A}', '${HEX_KEY('a')}', 'day_overview', 'cached A', now() + interval '1 day'),
        ('${USER_B}', '${HEX_KEY('b')}', 'day_overview', 'cached B', now() + interval '1 day');
      insert into rnd.calendar_connections (user_id, status, granted_scopes, refresh_token_ciphertext) values
        ('${USER_A}', 'connected', '{calendar.app.created}', 'ctA'),
        ('${USER_B}', 'connected', '{calendar.app.created}', 'ctB');
      insert into rnd.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, expires_at) values
        ('${USER_A}', '${HEX_KEY('d')}', 'ct', now() + interval '10 minutes'),
        ('${USER_B}', '${HEX_KEY('e')}', 'ct', now() + interval '10 minutes');
      insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end) values
        ('${USER_A}', '${PLAN_A}', 'b1', 't1', 'evA', '2026-01-05 09:00+00', '2026-01-05 10:00+00'),
        ('${USER_B}', '${PLAN_B}', 'b1', 't1', 'evB', '2026-01-05 09:00+00', '2026-01-05 10:00+00');
      insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason) values
        ('${USER_A}', '${PLAN_A}', 'b2', 't1', '2026-01-05 11:00+00', '2026-01-05 12:00+00', 'moved'),
        ('${USER_B}', '${PLAN_B}', 'b2', 't1', '2026-01-05 11:00+00', '2026-01-05 12:00+00', 'deleted');
      insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, kind) values
        ('${USER_A}', '2026-01-05', 'extA', 'cal1', 600, 660, 'busy'),
        ('${USER_B}', '2026-01-05', 'extB', 'cal1', 600, 660, 'tentative');
      insert into rnd.calendar_sources (user_id, calendar_id, name) values
        ('${USER_A}', 'cal1', 'Primary A'), ('${USER_B}', 'cal1', 'Primary B');
      insert into rnd.user_profiles (user_id, setup_status) values
        ('${USER_A}', 'in_progress'), ('${USER_B}', 'completed');
      insert into rnd.ai_provider_usage (day, provider_id, requests) values ('2026-01-05', 'fake', 4);
      insert into rnd.app_settings (key, value, is_public) values ('secret.key', '"x"', false);
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function count(
  client: pg.Client,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await asUser(client, 'rnd', sub, () => client.query<{ n: number }>(sql, params));
  return result.rows[0]!.n;
}

describe.skipIf(!dbAvailable)('data model: row-level security (rnd)', () => {
  let env: TestEnvironments;

  beforeAll(async () => {
    env = await prepareEnvironments();
    await withClient(TEST_DATABASE_URL!, seed);
  });

  describe.each(TABLES)('$name', (table) => {
    const own = `select count(*)::int as n from rnd.${table.name} where ${table.ownerColumn} = $1`;

    it('shows a user their own rows and nobody else’s', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        expect(await count(client, USER_A, own, [USER_A])).toBeGreaterThan(0);
        expect(await count(client, USER_B, own, [USER_A])).toBe(0);
        // Without a filter each user still sees only their own rows.
        const all = await asUser(client, 'rnd', USER_B, () =>
          client.query(`select ${table.ownerColumn} as owner from rnd.${table.name}`),
        );
        expect(new Set(all.rows.map((r) => r.owner))).toEqual(new Set([USER_B]));
      });
    });

    it('returns zero rows without a user context', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        expect(await count(client, null, `select count(*)::int as n from rnd.${table.name}`)).toBe(
          0,
        );
      });
    });

    it('does not let another user update or delete the rows', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        if (table.update) {
          const update = await asUser(client, 'rnd', USER_B, () =>
            client.query(
              `update rnd.${table.name} set ${table.update} where ${table.ownerColumn} = $1`,
              [USER_A],
            ),
          );
          expect(update.rowCount).toBe(0);
        }
        if (table.deletable) {
          const del = await asUser(client, 'rnd', USER_B, () =>
            client.query(`delete from rnd.${table.name} where ${table.ownerColumn} = $1`, [USER_A]),
          );
          expect(del.rowCount).toBe(0);
        }
      });
      // Nothing changed for user A.
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query(
          `select count(*)::int as n from rnd.${table.name} where ${table.ownerColumn} = $1`,
          [USER_A],
        );
        expect(rows[0].n).toBeGreaterThan(0);
      });
    });

    it('lets a user update and delete their own rows where the app is allowed to', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        if (table.update) {
          const update = await asUser(client, 'rnd', USER_A, () =>
            client.query(
              `update rnd.${table.name} set ${table.update} where ${table.ownerColumn} = $1`,
              [USER_A],
            ),
          );
          expect(update.rowCount).toBeGreaterThan(0);
        }
        if (table.deletable) {
          const del = await asUser(client, 'rnd', USER_A, () =>
            client.query(`delete from rnd.${table.name} where ${table.ownerColumn} = $1`, [USER_A]),
          );
          expect(del.rowCount).toBeGreaterThan(0);
        }
      });
    });

    if (table.insert) {
      const insert = table.insert;
      it('rejects an INSERT that carries someone else’s user_id', async () => {
        await withClient(env.appUrl('rnd'), async (client) => {
          // The same statement works for user B on their own plan (so the test is not just
          // hitting a typo), and is refused for user A with B's id.
          const ok = await asUser(client, 'rnd', USER_B, () => client.query(insert(USER_B)));
          expect(ok.rowCount).toBe(1);
          await expect(
            asUser(client, 'rnd', USER_A, () => client.query(insert(USER_B))),
          ).rejects.toThrow(RLS_ERROR);
        });
      });
    }
  });

  it('covers every user-owned table in the parametrised tests', async () => {
    const { rows } = await withClient(TEST_SUPERUSER_URL!, (client) =>
      client.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'rnd' and c.relkind = 'r'
            and c.relname not in ('environment_info', 'schema_migrations', 'allowed_emails',
                                'ai_provider_usage')`,
      ),
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLE_NAMES].sort());
  });

  describe('schedule_days is append-only and day_sessions only ends', () => {
    it('denies UPDATE and DELETE on schedule_days, even on the user’s own rows', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        for (const sql of [
          `update rnd.schedule_days set blocks = '[1]' where user_id = '${USER_A}'`,
          `delete from rnd.schedule_days where user_id = '${USER_A}'`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(sql))).rejects.toThrow(
            NO_PRIVILEGE,
          );
        }
      });
    });

    it('has only INSERT and SELECT policies on schedule_days for the app role', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ polcmd: string }>(
          `select p.polcmd from pg_policy p
            where p.polrelid = 'rnd.schedule_days'::regclass
              and 'app_rnd_user'::regrole::oid = any (p.polroles)
            order by 1`,
        );
        expect(rows.map((r) => r.polcmd)).toEqual(['a', 'r']);
      });
    });

    it('lets the app change ended_at but no other column of day_sessions', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`update rnd.day_sessions set started_at = now() where user_id = $1`, [
              USER_A,
            ]),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`update rnd.day_sessions set date = '2026-02-02' where user_id = $1`, [
              USER_A,
            ]),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`delete from rnd.day_sessions where user_id = $1`, [USER_A]),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
      });
    });

    it('refuses a non-array blocks value, an unknown source and a second row for a date', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        for (const bad of [
          `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
           values ('${USER_A}', '${PLAN_A}', '2026-03-01', '{}', 'day_end')`,
          `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
           values ('${USER_A}', '${PLAN_A}', '2026-03-01', '[]', 'manual')`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(bad))).rejects.toThrow(
            /violates check constraint/,
          );
        }
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
               values ('${USER_A}', '${PLAN_A}', '2026-01-05', '[]', 'day_end')`,
            ),
          ),
        ).rejects.toThrow(/duplicate key/);
      });
    });

    it('refuses to attach a row to another user’s plan (composite foreign key)', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.schedule_days (user_id, plan_id, date, blocks, source)
               values ('${USER_A}', '${PLAN_B}', '2026-03-02', '[]', 'day_end')`,
            ),
          ),
        ).rejects.toThrow(/violates foreign key constraint/);
      });
    });
  });

  describe('day_reviews can be re-saved in part and adjustments are append-only', () => {
    it('lets the app change ratings, note and outcomes of a review but nothing else', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await asUser(client, 'rnd', USER_A, async () => {
          const ok = await client.query(
            `update rnd.day_reviews set difficulty = 5, density = 1, energy = 2, note = 'n',
               outcomes = '[]', updated_at = now() where user_id = $1`,
            [USER_A],
          );
          expect(ok.rowCount).toBe(1);
        });
        for (const sql of [
          `update rnd.day_reviews set date = '2026-02-02' where user_id = $1`,
          `update rnd.day_reviews set plan_id = '${PLAN_B}' where user_id = $1`,
          `update rnd.day_reviews set created_at = now() where user_id = $1`,
          `delete from rnd.day_reviews where user_id = $1`,
        ]) {
          await expect(
            asUser(client, 'rnd', USER_A, () => client.query(sql, [USER_A])),
          ).rejects.toThrow(NO_PRIVILEGE);
        }
      });
    });

    it('refuses out-of-range ratings, a long note, non-array outcomes and a second review for a date', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const row = (cols: string, vals: string) =>
          `insert into rnd.day_reviews (user_id, plan_id, date, ${cols})
           values ('${USER_A}', '${PLAN_A}', '2026-03-01', ${vals})`;
        for (const bad of [
          row('difficulty, density, energy', '0, 3, 3'),
          row('difficulty, density, energy', '3, 6, 3'),
          row('difficulty, density, energy', '3, 3, 0'),
          row('difficulty, density, energy, note', `3, 3, 3, '${'x'.repeat(2001)}'`),
          row('difficulty, density, energy, outcomes', `3, 3, 3, '{}'`),
          row('difficulty, density, energy, outcomes', `3, 3, 3, '"x"'`),
          row(
            'difficulty, density, energy, outcomes',
            `3, 3, 3, (select jsonb_agg(1) from generate_series(1, 201))`,
          ),
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(bad))).rejects.toThrow(
            /violates check constraint/,
          );
        }
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.day_reviews (user_id, plan_id, date, difficulty, density, energy)
               values ('${USER_A}', '${PLAN_A}', '2026-01-05', 3, 3, 3)`,
            ),
          ),
        ).rejects.toThrow(/duplicate key/);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.day_reviews (user_id, plan_id, date, difficulty, density, energy)
               values ('${USER_A}', '${PLAN_B}', '2026-03-02', 3, 3, 3)`,
            ),
          ),
        ).rejects.toThrow(/violates foreign key constraint/);
      });
    });

    it('denies UPDATE and DELETE on adjustments and has only INSERT and SELECT policies', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        for (const sql of [
          `update rnd.adjustments set status = 'accepted' where user_id = '${USER_A}'`,
          `delete from rnd.adjustments where user_id = '${USER_A}'`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(sql))).rejects.toThrow(
            NO_PRIVILEGE,
          );
        }
      });
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ polcmd: string }>(
          `select p.polcmd from pg_policy p
            where p.polrelid = 'rnd.adjustments'::regclass
              and 'app_rnd_user'::regrole::oid = any (p.polroles)
            order by 1`,
        );
        expect(rows.map((r) => r.polcmd)).toEqual(['a', 'r']);
      });
    });

    it('refuses bad adjustment rows: unknown rule or status, accepted without an option or change, a duplicate suggestion, a foreign plan', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const row = (suggestion: string, rule: string, status: string, extra = '') =>
          `insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status ${extra ? ', ' + extra.split('|')[0] : ''})
           values ('${USER_A}', '${PLAN_A}', '${suggestion}', '${rule}', 'k', '{}', '${status}' ${extra ? ', ' + extra.split('|')[1] : ''})`;
        for (const bad of [
          row('sg_x1', 'made_up', 'rejected'),
          row('sg_x2', 'density_too_low', 'maybe'),
          // accepted needs an option and the applied change
          row('sg_x3', 'density_too_low', 'accepted'),
          row('sg_x4', 'density_too_low', 'accepted', 'option_index|0'),
          // rejected must not carry an option or a change
          row('sg_x5', 'density_too_low', 'rejected', 'option_index|0'),
          row('sg_x6', 'density_too_low', 'rejected', `applied_change|'{}'`),
          // evidence must be an object
          `insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status)
           values ('${USER_A}', '${PLAN_A}', 'sg_x7', 'density_too_low', 'k', '[]', 'rejected')`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(bad))).rejects.toThrow(
            /violates check constraint/,
          );
        }
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(row('sg_a1', 'density_too_low', 'rejected')),
          ),
        ).rejects.toThrow(/duplicate key/);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.adjustments (user_id, plan_id, suggestion_id, rule, key, evidence, status)
               values ('${USER_A}', '${PLAN_B}', 'sg_y1', 'density_too_low', 'k', '{}', 'rejected')`,
            ),
          ),
        ).rejects.toThrow(/violates foreign key constraint/);
      });
    });
  });

  describe('events are append-only', () => {
    it('lets a user add and read their own events', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await asUser(client, 'rnd', USER_A, async () => {
          await client.query(
            `insert into rnd.events (user_id, plan_id, type, payload)
             values ($1, $2, 'certificate.earned', '{"name":"x"}')`,
            [USER_A, PLAN_A],
          );
          const { rows } = await client.query(`select count(*)::int as n from rnd.events`);
          expect(rows[0].n).toBe(2);
        });
      });
    });

    it('denies UPDATE and DELETE to the app, even on the user’s own events', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`update rnd.events set type = 'task.deleted' where user_id = $1`, [
              USER_A,
            ]),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`delete from rnd.events where user_id = $1`, [USER_A]),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
      });
    });

    it('has no UPDATE or DELETE policy for the app role (second layer)', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ polcmd: string }>(
          `select p.polcmd from pg_policy p
            where p.polrelid = 'rnd.events'::regclass
              and 'app_rnd_user'::regrole::oid = any (p.polroles)
            order by 1`,
        );
        // 'a' = INSERT, 'r' = SELECT.
        expect(rows.map((r) => r.polcmd)).toEqual(['a', 'r']);
      });
    });

    it('refuses a malformed event type and a non-object payload', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        for (const bad of [
          `insert into rnd.events (user_id, type) values ('${USER_A}', 'NoDot')`,
          `insert into rnd.events (user_id, type) values ('${USER_A}', 'task.started; drop')`,
          `insert into rnd.events (user_id, type, payload) values ('${USER_A}', 'task.started', '[1]')`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(bad))).rejects.toThrow(
            /violates check constraint/,
          );
        }
      });
    });
  });

  describe('app_users: role and status are not user-writable', () => {
    it.each([
      ['role', `role = 'admin'`],
      ['status', `status = 'active'`],
      ['email', `email = 'new@example.test'`],
      ['id', `id = gen_random_uuid()`],
      ['created_at', `created_at = now()`],
    ])('denies the user changing %s on their own row', async (_column, assignment) => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`update rnd.app_users set ${assignment} where id = $1`, [USER_A]),
          ),
        ).rejects.toThrow(/permission denied for table app_users/);
      });
    });

    it('lets the user change display_name, last_seen_at and support_access_until', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const result = await asUser(client, 'rnd', USER_A, () =>
          client.query(
            `update rnd.app_users
                set display_name = 'Anna', last_seen_at = now(),
                    support_access_until = now() + interval '1 day'
              where id = $1`,
            [USER_A],
          ),
        );
        expect(result.rowCount).toBe(1);
      });
    });

    it('cannot create or delete user rows, nor see another user', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.app_users (id, email, role) values (gen_random_uuid(), 'x@example.test', 'admin')`,
            ),
          ),
        ).rejects.toThrow(/permission denied for table app_users/);
        await expect(
          asUser(client, 'rnd', USER_A, () => client.query(`delete from rnd.app_users`)),
        ).rejects.toThrow(/permission denied for table app_users/);
        const rows = await asUser(client, 'rnd', USER_A, () =>
          client.query(`select id from rnd.app_users`),
        );
        expect(rows.rows).toEqual([{ id: USER_A }]);
      });
    });

    it('rejects invalid role, status and e-mail values (admin path)', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        for (const bad of [
          `insert into rnd.app_users (id, email, role) values (gen_random_uuid(), 'r@example.test', 'root')`,
          `insert into rnd.app_users (id, email, status) values (gen_random_uuid(), 's@example.test', 'gone')`,
          `insert into rnd.app_users (id, email) values (gen_random_uuid(), 'A@Example.test')`,
        ]) {
          await client.query('begin');
          try {
            await client.query('set local role owner_rnd');
            await expect(client.query(bad)).rejects.toThrow(
              /violates (check constraint|unique constraint)/,
            );
          } finally {
            await client.query('rollback');
          }
        }
      });
    });
  });

  describe('app_settings', () => {
    it('shows signed-in users the public keys only', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const { rows } = await asUser(client, 'rnd', USER_A, () =>
          client.query(`select key, value from rnd.app_settings order by key`),
        );
        expect(rows).toEqual([
          { key: 'features.notifications', value: false },
          { key: 'features.sharing', value: false },
          { key: 'user_cap', value: 25 },
        ]);
      });
    });

    it('shows nothing without a user context', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        expect(await count(client, null, `select count(*)::int as n from rnd.app_settings`)).toBe(
          0,
        );
      });
    });

    it('cannot be written through the app', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        for (const sql of [
          `update rnd.app_settings set value = '1000' where key = 'user_cap'`,
          `delete from rnd.app_settings`,
          `insert into rnd.app_settings (key, value) values ('x.y', '1')`,
        ]) {
          await expect(asUser(client, 'rnd', USER_A, () => client.query(sql))).rejects.toThrow(
            /permission denied for table app_settings/,
          );
        }
      });
    });
  });

  describe('legal_acceptances', () => {
    it('stamps accepted_at in the database and refuses a client-chosen time', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await asUser(client, 'rnd', USER_A, async () => {
          await client.query(
            `insert into rnd.legal_acceptances (user_id, document, version)
             values ($1, 'privacy', 'v2')`,
            [USER_A],
          );
          const { rows } = await client.query(
            `select accepted_at from rnd.legal_acceptances where version = 'v2'`,
          );
          expect(Math.abs(Date.now() - rows[0].accepted_at.getTime())).toBeLessThan(60_000);
        });
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.legal_acceptances (user_id, document, version, accepted_at)
               values ($1, 'privacy', 'v3', '2000-01-01')`,
              [USER_A],
            ),
          ),
        ).rejects.toThrow(/permission denied for table legal_acceptances/);
      });
    });

    it('accepts each document version once per user', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.legal_acceptances (user_id, document, version) values ($1, 'terms', 'v1')`,
              [USER_A],
            ),
          ),
        ).rejects.toThrow(/duplicate key/);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.legal_acceptances (user_id, document, version) values ($1, 'cookies', 'v1')`,
              [USER_A],
            ),
          ),
        ).rejects.toThrow(/violates check constraint/);
      });
    });

    it('cannot be changed or removed by the user', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(`update rnd.legal_acceptances set version = 'v0'`),
          ),
        ).rejects.toThrow(NO_PRIVILEGE);
        await expect(
          asUser(client, 'rnd', USER_A, () => client.query(`delete from rnd.legal_acceptances`)),
        ).rejects.toThrow(NO_PRIVILEGE);
      });
    });
  });

  describe('current_user_id()', () => {
    it('returns the user id from the claims, and null without claims', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const q = () => client.query<{ id: string | null }>('select rnd.current_user_id() as id');
        expect((await asUser(client, 'rnd', USER_A, q)).rows[0]!.id).toBe(USER_A);
        expect((await asUser(client, 'rnd', null, q)).rows[0]!.id).toBeNull();
      });
    });

    it('treats the stale empty setting left by an earlier request as no user (no error)', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        // set_config(..., true) leaves the setting defined as '' for the rest of the session.
        await asUser(client, 'rnd', USER_A, () => client.query('select 1'));
        const none = await asUser(client, 'rnd', null, () =>
          client.query<{ id: string | null; n: number }>(
            `select rnd.current_user_id() as id, (select count(*)::int from rnd.plans) as n`,
          ),
        );
        expect(none.rows[0]).toEqual({ id: null, n: 0 });
        // A claims object without a sub is no user either.
        const noSub = await asUser(client, 'rnd', null, async () => {
          await client.query(`select set_config('request.jwt.claims', '{"role":"x"}', true)`);
          return client.query<{ id: string | null }>('select rnd.current_user_id() as id');
        });
        expect(noSub.rows[0]!.id).toBeNull();
      });
    });

    it('is owned by the owner role, runs as the caller and is executable only by the env roles', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query(
          `select pg_get_userbyid(proowner) as owner, prosecdef,
                  has_function_privilege('app_rnd_user', oid, 'execute') as app_user,
                  has_function_privilege('backup_rnd', oid, 'execute') as backup,
                  has_function_privilege('app_rnd', oid, 'execute') as app_login,
                  has_function_privilege('app_prod_user', oid, 'execute') as other_env,
                  has_function_privilege('backup_prod', oid, 'execute') as other_backup,
                  has_function_privilege('public', oid, 'execute') as public
             from pg_proc where oid = 'rnd.current_user_id()'::regprocedure`,
        );
        expect(rows[0]).toEqual({
          owner: 'owner_rnd',
          prosecdef: false,
          app_user: true,
          backup: true,
          app_login: false,
          other_env: false,
          other_backup: false,
          public: false,
        });
      });
    });
  });

  describe('integrity rules', () => {
    const task = (extra: string, values: string) =>
      `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order${extra})
       values ('${USER_A}', '${PLAN_A}', 't2', 'x', 'course', 1, 1${values})`;

    it('accepts a valid minimal task and a valid anchor task', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        expect(
          (await asUser(client, 'rnd', USER_A, () => client.query(task('', '')))).rowCount,
        ).toBe(1);
        const anchor = task(
          ', is_anchor, anchor_date, anchor_start_time',
          `, true, '2026-03-01', '22:00'`,
        );
        expect((await asUser(client, 'rnd', USER_A, () => client.query(anchor))).rowCount).toBe(1);
      });
    });

    it.each([
      ['est_hours of 0', task('', '').replace("course', 1, 1", "course', 0, 1")],
      ['est_hours over 500', task('', '').replace("course', 1, 1", "course', 501, 1")],
      ['negative done_hours', task(', done_hours', ', -1')],
      ['unknown status', task(', status', ", 'half'")],
      ['unknown type', task('', '').replace("'course'", "'video'")],
      ['unknown source', task(', source', ", 'robot'")],
      ['negative sort_order', task('', '').replace("course', 1, 1", "course', 1, -1")],
      ['an anchor without date and time', task(', is_anchor', ', true')],
      ['an anchor without a start time', task(', is_anchor, anchor_date', ", true, '2026-03-01'")],
      [
        'an anchor that ends after 23:59',
        task(', is_anchor, anchor_date, anchor_start_time', ", true, '2026-03-01', '23:30'"),
      ],
      ['a task depending on itself', task(', depends_on', ", '{t2}'")],
      ['a pinned date without a time', task(', pinned_start_date', ", '2026-03-01'")],
      ['lessons that are not an array', task(', lessons', ", '{}'")],
    ])('rejects %s', async (_name, sql) => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(asUser(client, 'rnd', USER_A, () => client.query(sql))).rejects.toThrow(
          /violates check constraint/,
        );
      });
    });

    it('rejects a task in another user’s plan, even with the user’s own user_id', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
               values ($1, $2, 'sneak', 'x', 'course', 1, 1)`,
              [USER_A, PLAN_B],
            ),
          ),
        ).rejects.toThrow(/violates foreign key constraint/);
      });
    });

    it('rejects a log for a task that does not exist in the plan', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.logs (user_id, id, plan_id, task_id, date, hours)
               values ($1, gen_random_uuid(), $2, 'nope', '2026-01-01', 1)`,
              [USER_A, PLAN_A],
            ),
          ),
        ).rejects.toThrow(/violates foreign key constraint/);
        await expect(
          asUser(client, 'rnd', USER_A, () =>
            client.query(
              `insert into rnd.logs (user_id, id, plan_id, task_id, date, hours)
               values ($1, gen_random_uuid(), $2, 't1', '2026-01-01', -1)`,
              [USER_A, PLAN_A],
            ),
          ),
        ).rejects.toThrow(/violates check constraint/);
      });
    });

    it('lets two users use the same client-generated plan id without learning about each other', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        const insert = (u: string) =>
          client.query(
            `insert into rnd.plans (user_id, id, created_from, name, start_date)
             values ($1, $2, 'builder', 'same id', '2026-01-01')`,
            [u, PLAN_B],
          );
        expect((await asUser(client, 'rnd', USER_A, () => insert(USER_A))).rowCount).toBe(1);
        // The same user repeating the request gets a duplicate error (idempotent retry).
        await expect(
          asUser(client, 'rnd', USER_A, async () => {
            await insert(USER_A);
            await insert(USER_A);
          }),
        ).rejects.toThrow(/duplicate key/);
      });
    });

    const pattern = (values: string) =>
      `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
         window_start, window_end, timezone)
       values ('${USER_A}', '${PLAN_A}', ${values})`;

    it.each([
      ['duplicate weekdays', `'{1,1}', 2, '09:00', '17:00', 'UTC'`],
      ['an empty weekday list', `'{}', 2, '09:00', '17:00', 'UTC'`],
      ['weekday 7', `'{7}', 2, '09:00', '17:00', 'UTC'`],
      ['more than 24 default hours', `'{1}', 25, '09:00', '17:00', 'UTC'`],
      ['a window that ends before it starts', `'{1}', 2, '17:00', '09:00', 'UTC'`],
      ['a blank time zone', `'{1}', 2, '09:00', '17:00', ' '`],
    ])('rejects a week pattern with %s', async (_name, values) => {
      const sql = pattern(values);
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        try {
          await client.query('set local role owner_rnd');
          await client.query(`delete from rnd.week_patterns where plan_id = '${PLAN_A}'`);
          await expect(client.query(sql)).rejects.toThrow(/violates check constraint/);
        } finally {
          await client.query('rollback');
        }
      });
    });

    it('requires lunch start and end together, in order', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        for (const lunch of [`'12:00', null`, `null, '13:00'`, `'13:00', '12:00'`]) {
          await client.query('begin');
          try {
            await client.query('set local role owner_rnd');
            await client.query(`delete from rnd.week_patterns where plan_id = '${PLAN_A}'`);
            await expect(
              client.query(
                `insert into rnd.week_patterns (user_id, plan_id, study_weekdays, default_hours,
                   window_start, window_end, lunch_start, lunch_end, timezone)
                 values ('${USER_A}', '${PLAN_A}', '{1}', 2, '09:00', '17:00', ${lunch}, 'UTC')`,
              ),
            ).rejects.toThrow(/violates check constraint/);
          } finally {
            await client.query('rollback');
          }
        }
      });
    });

    it('lets a user delete a plan and removes its tasks, logs and events with it', async () => {
      await withClient(env.appUrl('rnd'), async (client) => {
        await asUser(client, 'rnd', USER_A, async () => {
          const del = await client.query(`delete from rnd.plans where id = $1`, [PLAN_A]);
          expect(del.rowCount).toBe(1);
          for (const table of [
            'tasks',
            'logs',
            'events',
            'week_patterns',
            'day_overrides',
            'day_sessions',
            'schedule_days',
            'day_reviews',
            'adjustments',
            'practice_contexts',
            'practice_sessions',
            'calendar_event_links',
            'calendar_locked_blocks',
          ]) {
            const { rows } = await client.query(
              `select count(*)::int as n from rnd.${table} where plan_id = $1`,
              [PLAN_A],
            );
            expect(rows[0].n, table).toBe(0);
          }
          // Messages and feedback have no plan_id: they go with their session.
          for (const table of ['practice_messages', 'practice_feedback']) {
            const { rows } = await client.query(
              `select count(*)::int as n from rnd.${table} where user_id = $1`,
              [USER_A],
            );
            expect(rows[0].n, table).toBe(0);
          }
        });
      });
    });
  });

  describe('backup role', () => {
    it('reads every row of every table and writes nothing', async () => {
      await withClient(env.backupUrl('rnd'), async (client) => {
        for (const name of READABLE_BY_BACKUP) {
          const { rows } = await client.query(`select count(*)::int as n from rnd.${name}`);
          expect(rows[0].n, name).toBeGreaterThan(0);
        }
        const users = await client.query(`select id from rnd.app_users order by id`);
        expect(users.rows.map((r) => r.id)).toEqual([USER_A, USER_B]);
        await expect(client.query(`update rnd.tasks set title = 'x'`)).rejects.toThrow(
          /permission denied/,
        );
        await expect(client.query(`delete from rnd.events`)).rejects.toThrow(/permission denied/);
      });
    });
  });

  describe('the wall between prod and rnd', () => {
    it.each(READABLE_BY_BACKUP)(
      'app_prod cannot touch rnd.%s, and app_rnd cannot touch prod',
      async (name) => {
        await withClient(env.appUrl('prod'), async (client) => {
          await expect(client.query(`select * from rnd.${name}`)).rejects.toThrow(
            /permission denied for schema rnd/,
          );
          await expect(
            asUser(client, 'prod', USER_A, () => client.query(`select * from rnd.${name}`)),
          ).rejects.toThrow(/permission denied for schema rnd/);
        });
        await withClient(env.appUrl('rnd'), async (client) => {
          await expect(
            asUser(client, 'rnd', USER_A, () => client.query(`select * from prod.${name}`)),
          ).rejects.toThrow(/permission denied for schema prod/);
        });
      },
    );

    it('keeps the data separate: a user with rows in rnd sees none in prod', async () => {
      await withClient(env.appUrl('prod'), async (client) => {
        const plans = await asUser(client, 'prod', USER_B, () =>
          client.query(`select count(*)::int as n from prod.plans`),
        );
        expect(plans.rows[0].n).toBe(0);
        const tasks = await asUser(client, 'prod', USER_B, () =>
          client.query(`select count(*)::int as n from prod.tasks`),
        );
        expect(tasks.rows[0].n).toBe(0);
      });
    });

    it('has the same tables, policies and functions in both environments', async () => {
      const shape = async (schema: string) =>
        withClient(TEST_SUPERUSER_URL!, async (client) => {
          const { rows } = await client.query<{ shape: string }>(
            `select c.relname || ':' || c.relrowsecurity::text || ':' ||
                    (select string_agg(p.polname, ',' order by p.polname)
                       from pg_policy p where p.polrelid = c.oid) as shape
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = $1 and c.relkind = 'r' order by 1`,
            [schema],
          );
          return rows.map((r) => r.shape);
        });
      expect(await shape('prod')).toEqual(await shape('rnd'));
    });

    it('applies the same migrations to both environments', async () => {
      for (const schema of ENVS) {
        const again = await migrate({ schema, connectionString: TEST_DATABASE_URL! });
        expect(again.applied).toEqual([]);
        expect(again.skipped.length).toBeGreaterThanOrEqual(5);
      }
    });
  });
});
