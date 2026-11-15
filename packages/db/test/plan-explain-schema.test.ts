import { beforeAll, describe, expect, it } from 'vitest';
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

// Migration 0019 (ADR 017, WP-4): ai_usage_daily and ai_cache accept the plan_explain purpose,
// cv_tailor stays out of ai_cache, and the cross-user sum for the app-wide cap is readable
// without exposing rows.

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const hex = (c: string) => c.repeat(64);

type Q = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`plan_explain purpose (${schema})`, () => {
    const s = schema;
    let env: TestEnvironments;

    const as = <T>(sub: string | null, work: (q: Q) => Promise<T>) =>
      withClient(env.appUrl(s), (client) =>
        asUser(client, s, sub, () => work((sql) => client.query(sql))),
      );

    beforeAll(async () => {
      env = await prepareEnvironments();
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        await client.query(`set local role owner_${s}`);
        await client.query(`
          insert into ${s}.app_users (id, email) values
            ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
        `);
        await client.query('commit');
      });
    });

    it('names both widened constraints (verified, not assumed)', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        for (const [table, name] of [
          ['ai_usage_daily', 'ai_usage_daily_purpose_check'],
          ['ai_cache', 'ai_cache_purpose_check'],
        ] as const) {
          const { rows } = await client.query<{ conname: string; def: string }>(
            `select c.conname, pg_get_constraintdef(c.oid) as def
               from pg_constraint c
              where c.conrelid = '${s}.${table}'::regclass and c.contype = 'c'
              order by c.conname`,
          );
          const purpose = rows.filter((r) => r.def.includes('purpose'));
          expect(purpose.map((r) => r.conname)).toEqual([name]);
          expect(purpose[0]!.def).toContain('plan_explain');
        }
      });
    });

    it('ai_usage_daily still inserts the old purposes and inserts plan_explain', async () => {
      await as(USER_A, async (q) => {
        for (const purpose of [
          'practice_message',
          'practice_feedback',
          'day_overview',
          'cv_tailor',
          'plan_explain',
        ]) {
          await q(
            `insert into ${s}.ai_usage_daily (user_id, day, purpose, requests)
             values ('${USER_A}', '2026-02-02', '${purpose}', 1)`,
          );
        }
      });
    });

    it('ai_cache still inserts the old purposes and inserts plan_explain', async () => {
      await as(USER_A, async (q) => {
        let n = 0;
        for (const purpose of [
          'practice_message',
          'practice_feedback',
          'day_overview',
          'plan_explain',
        ]) {
          n += 1;
          await q(
            `insert into ${s}.ai_cache (user_id, key, purpose, text, expires_at)
             values ('${USER_A}', '${hex(String(n))}', '${purpose}', 't', now() + interval '1 day')`,
          );
        }
      });
    });

    it('rejects an unknown purpose in both tables', async () => {
      for (const purpose of ['chit_chat', 'PLAN_EXPLAIN', 'plan_explain ', '']) {
        await expect(
          as(USER_A, (q) =>
            q(
              `insert into ${s}.ai_usage_daily (user_id, day, purpose) values ('${USER_A}', '2026-02-03', '${purpose}')`,
            ),
          ),
          `usage ${JSON.stringify(purpose)}`,
        ).rejects.toThrow(/ai_usage_daily_purpose_check/);
        await expect(
          as(USER_A, (q) =>
            q(
              `insert into ${s}.ai_cache (user_id, key, purpose, text, expires_at)
               values ('${USER_A}', '${hex('f')}', '${purpose}', 't', now() + interval '1 day')`,
            ),
          ),
          `cache ${JSON.stringify(purpose)}`,
        ).rejects.toThrow(/ai_cache_purpose_check/);
      }
    });

    it('keeps cv_tailor out of ai_cache', async () => {
      await expect(
        as(USER_A, (q) =>
          q(
            `insert into ${s}.ai_cache (user_id, key, purpose, text, expires_at)
             values ('${USER_A}', '${hex('e')}', 'cv_tailor', 't', now() + interval '1 day')`,
          ),
        ),
      ).rejects.toThrow(/ai_cache_purpose_check/);
    });

    it('ai_plan_explain_usage_today sums today over all users and nothing else', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        await client.query(`set local role owner_${s}`);
        await client.query(`
          delete from ${s}.ai_usage_daily;
          insert into ${s}.ai_usage_daily (user_id, day, purpose, requests) values
            ('${USER_A}', (now() at time zone 'utc')::date, 'plan_explain', 2),
            ('${USER_B}', (now() at time zone 'utc')::date, 'plan_explain', 3),
            ('${USER_B}', (now() at time zone 'utc')::date, 'cv_tailor', 4),
            ('${USER_B}', (now() at time zone 'utc')::date - 1, 'plan_explain', 9);
        `);
        await client.query('commit');
      });
      const sum = (sub: string | null) =>
        as(sub, async (q) => {
          const r = await q(`select ${s}.ai_plan_explain_usage_today() as n`);
          return Number(r.rows[0]!.n);
        });
      expect(await sum(USER_A)).toBe(5);
      expect(await sum(USER_B)).toBe(5);
      // Without a signed-in user the function reveals nothing.
      expect(await sum(null)).toBe(0);
      // Fixed to plan_explain: no argument form exists, so no other purpose is readable.
      await expect(
        as(USER_A, (q) => q(`select ${s}.ai_plan_explain_usage_today('cv_tailor')`)),
      ).rejects.toThrow(/does not exist/);
      await as(USER_A, async (q) => {
        const r = await q(`select user_id from ${s}.ai_usage_daily`);
        expect(new Set(r.rows.map((x) => x.user_id))).toEqual(new Set([USER_A]));
      });
    });
  });
}
