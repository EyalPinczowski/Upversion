import { beforeAll, describe, expect, it } from 'vitest';
import {
  ENVS,
  TEST_DATABASE_URL,
  asUser,
  dbAvailable,
  prepareEnvironments,
  withClient,
  type TestEnvironments,
} from './helpers';

// Migration 0016 (user profiles, ADR 015): constraints, column grants, size caps, cascade and the
// cross-user wall. Runs on both schemas.

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const CHECK = /violates check constraint/;
const NO_PRIVILEGE = /permission denied for table/;

type Q = (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`user_profiles (${schema})`, () => {
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
            ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test'),
            ('${USER_C}', 'c@example.test');
          insert into ${s}.user_profiles (user_id, answers, setup_status) values
            ('${USER_A}', '{"days_per_week":[1,2]}', 'in_progress'),
            ('${USER_B}', '{}', 'completed');
        `);
        await client.query('commit');
      });
    });

    it('fills the documented defaults', async () => {
      await as(USER_C, async (q) => {
        await q(`insert into ${s}.user_profiles (user_id) values ('${USER_C}')`);
        const { rows } = await q(
          `select answers, skills, roles_held, years_experience, cv_imported_at, setup_status, setup_step
             from ${s}.user_profiles`,
        );
        expect(rows).toEqual([
          {
            answers: {},
            skills: [],
            roles_held: [],
            years_experience: null,
            cv_imported_at: null,
            setup_status: 'not_started',
            setup_step: null,
          },
        ]);
      });
    });

    it.each([
      ['unknown status', `setup_status = 'bogus'`],
      ['answers not an object', `answers = '[]'`],
      ['skills not an array', `skills = '{}'`],
      ['skills over 60 items', `skills = (select jsonb_agg(0) from generate_series(1, 61))`],
      [
        'roles_held over 15 items',
        `roles_held = (select jsonb_agg(0) from generate_series(1, 16))`,
      ],
      ['negative years', `years_experience = -1`],
      ['years over 50', `years_experience = 51`],
      ['step over 40 chars', `setup_step = repeat('x', 41)`],
      ['answers over 8192 bytes', `answers = jsonb_build_object('k', repeat('x', 9000))`],
      ['skills over 16384 bytes', `skills = jsonb_build_array(repeat('x', 17000))`],
      ['roles_held over 8192 bytes', `roles_held = jsonb_build_array(repeat('x', 9000))`],
    ])('rejects bad values: %s', async (_name, set) => {
      await expect(
        as(USER_A, (q) => q(`update ${s}.user_profiles set ${set} where user_id = '${USER_A}'`)),
      ).rejects.toThrow(CHECK);
    });

    it('lets the owner of a row change every working column', async () => {
      await as(USER_A, async (q) => {
        const res = await q(
          `update ${s}.user_profiles set answers = '{"a":1}', skills = '[]', roles_held = '[]',
             years_experience = 3.5, cv_imported_at = now(), setup_status = 'completed',
             setup_step = 'done', setup_completed_at = now(), updated_at = now()
           where user_id = '${USER_A}'`,
        );
        expect(res.rowCount).toBe(1);
      });
    });

    it('never lets the app change user_id or created_at', async () => {
      for (const sql of [
        `update ${s}.user_profiles set user_id = '${USER_C}' where user_id = '${USER_A}'`,
        `update ${s}.user_profiles set created_at = now() where user_id = '${USER_A}'`,
      ]) {
        await expect(
          as(USER_A, (q) => q(sql)),
          sql,
        ).rejects.toThrow(NO_PRIVILEGE);
      }
    });

    it('keeps users apart: no select, update, delete or insert for another user', async () => {
      await as(USER_A, async (q) => {
        expect(
          (await q(`select 1 from ${s}.user_profiles where user_id = '${USER_B}'`)).rows,
        ).toEqual([]);
        const upd = await q(
          `update ${s}.user_profiles set setup_status = 'dismissed' where user_id = '${USER_B}'`,
        );
        expect(upd.rowCount).toBe(0);
        const del = await q(`delete from ${s}.user_profiles where user_id = '${USER_B}'`);
        expect(del.rowCount).toBe(0);
      });
      await expect(
        as(USER_A, (q) => q(`insert into ${s}.user_profiles (user_id) values ('${USER_C}')`)),
      ).rejects.toThrow(/row-level security/);
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        try {
          await client.query(`set local role owner_${s}`);
          const { rows } = await client.query(
            `select setup_status from ${s}.user_profiles where user_id = '${USER_B}'`,
          );
          expect(rows).toEqual([{ setup_status: 'completed' }]);
        } finally {
          await client.query('rollback');
        }
      });
    });

    it('lets a user delete their own row', async () => {
      await as(USER_B, async (q) => {
        const del = await q(`delete from ${s}.user_profiles where user_id = '${USER_B}'`);
        expect(del.rowCount).toBe(1);
      });
    });

    it('has no column that could hold raw CV text, a file or evidence', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = $1 and table_name = 'user_profiles'
            order by ordinal_position`,
          [s],
        );
        expect(rows.map((r) => r.column_name)).toEqual([
          'user_id',
          'answers',
          'skills',
          'roles_held',
          'years_experience',
          'cv_imported_at',
          'setup_status',
          'setup_step',
          'setup_completed_at',
          'created_at',
          'updated_at',
        ]);
      });
    });

    it('is removed with the account', async () => {
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        try {
          await client.query(`set local role owner_${s}`);
          await client.query(`delete from ${s}.app_users where id = '${USER_A}'`);
          const { rows } = await client.query(
            `select count(*)::int as n from ${s}.user_profiles where user_id = '${USER_A}'`,
          );
          expect(rows[0]!.n).toBe(0);
        } finally {
          await client.query('rollback');
        }
      });
    });

    it('returns nothing without a user context', async () => {
      await as(null, async (q) => {
        expect((await q(`select 1 from ${s}.user_profiles`)).rows).toEqual([]);
      });
    });
  });
}
