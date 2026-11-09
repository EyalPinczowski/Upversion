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

// Migration 0017 (ADR 016, WP-F): ai_usage_daily accepts the cv_tailor purpose, ai_cache does not,
// and the cross-user sum for the app-wide cap is readable without exposing rows.

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const hex = (c: string) => c.repeat(64);

type Q = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`cv_tailor purpose (${schema})`, () => {
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

    it('names the widened constraint ai_usage_daily_purpose_check (verified, not assumed)', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ conname: string; def: string }>(
          `select c.conname, pg_get_constraintdef(c.oid) as def
             from pg_constraint c
            where c.conrelid = '${s}.ai_usage_daily'::regclass and c.contype = 'c'
            order by c.conname`,
        );
        const purpose = rows.filter((r) => r.def.includes('purpose'));
        expect(purpose.map((r) => r.conname)).toEqual(['ai_usage_daily_purpose_check']);
        expect(purpose[0]!.def).toContain('cv_tailor');
        // The other two checks on the table stay.
        const all = rows.map((r) => r.def).join('\n');
        expect(all).toContain('requests >= 0');
        expect(all).toContain('avoided >= 0');
      });
    });

    it('still inserts the old purposes and inserts cv_tailor', async () => {
      await as(USER_A, async (q) => {
        for (const purpose of [
          'practice_message',
          'practice_feedback',
          'day_overview',
          'cv_tailor',
        ]) {
          await q(
            `insert into ${s}.ai_usage_daily (user_id, day, purpose, requests)
             values ('${USER_A}', '2026-02-02', '${purpose}', 1)`,
          );
        }
      });
    });

    it('rejects an unknown purpose', async () => {
      for (const purpose of ['chit_chat', 'CV_TAILOR', 'cv_tailor ', '']) {
        await expect(
          as(USER_A, (q) =>
            q(
              `insert into ${s}.ai_usage_daily (user_id, day, purpose) values ('${USER_A}', '2026-02-03', '${purpose}')`,
            ),
          ),
          JSON.stringify(purpose),
        ).rejects.toThrow(/ai_usage_daily_purpose_check/);
      }
    });

    it('keeps cv_tailor out of ai_cache', async () => {
      await expect(
        as(USER_A, (q) =>
          q(
            `insert into ${s}.ai_cache (user_id, key, purpose, text, expires_at)
             values ('${USER_A}', '${hex('a')}', 'cv_tailor', 't', now() + interval '1 day')`,
          ),
        ),
      ).rejects.toThrow(/ai_cache_purpose_check/);
      // The old purposes are still accepted there.
      await as(USER_A, (q) =>
        q(
          `insert into ${s}.ai_cache (user_id, key, purpose, text, expires_at)
           values ('${USER_A}', '${hex('b')}', 'day_overview', 't', now() + interval '1 day')`,
        ),
      );
    });

    it('ai_cv_tailor_usage_today sums today over all users and nothing else', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        await client.query(`set local role owner_${s}`);
        await client.query(`
          delete from ${s}.ai_usage_daily;
          insert into ${s}.ai_usage_daily (user_id, day, purpose, requests) values
            ('${USER_A}', (now() at time zone 'utc')::date, 'cv_tailor', 2),
            ('${USER_B}', (now() at time zone 'utc')::date, 'cv_tailor', 3),
            ('${USER_B}', (now() at time zone 'utc')::date, 'day_overview', 1),
            ('${USER_B}', (now() at time zone 'utc')::date - 1, 'cv_tailor', 9);
        `);
        await client.query('commit');
      });
      const sum = (sub: string | null) =>
        as(sub, async (q) => {
          const r = await q(`select ${s}.ai_cv_tailor_usage_today() as n`);
          return Number(r.rows[0]!.n);
        });
      expect(await sum(USER_A)).toBe(5);
      expect(await sum(USER_B)).toBe(5);
      // Without a signed-in user the function reveals nothing.
      expect(await sum(null)).toBe(0);
      // The function is fixed to cv_tailor: no argument form exists, so no other purpose is readable.
      await expect(
        as(USER_A, (q) => q(`select ${s}.ai_cv_tailor_usage_today('day_overview')`)),
      ).rejects.toThrow(/does not exist/);
      // A user still cannot read another user's rows directly.
      await as(USER_A, async (q) => {
        const r = await q(`select user_id from ${s}.ai_usage_daily`);
        expect(new Set(r.rows.map((x) => x.user_id))).toEqual(new Set([USER_A]));
      });
    });
  });
}
