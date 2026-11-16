import { cp, mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/index';
import {
  ENVS,
  TEST_DATABASE_URL,
  asUser,
  dbAvailable,
  prepareEnvironments,
  resetEnvironments,
  withClient,
  type TestEnvironments,
} from './helpers';

// Migration 0020 (ADR 018, B2): tasks.skill_ids text[], nullable. NULL = unknown (old rows, fall
// back to the catalog), empty array = builds no skill. RLS is unchanged.

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'aaaaaaaa-1111-4111-8111-111111111111';

type Q = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

const insertTask = (s: string, id: string, extra = '', value = '') =>
  `insert into ${s}.tasks (user_id, plan_id, id, title, type, est_hours, sort_order${extra})
   values ('${USER_A}', '${PLAN_A}', '${id}', 'Task', 'course', 1, 0${value})`;

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`tasks.skill_ids (${schema})`, () => {
    const s = schema;
    let env: TestEnvironments;

    const as = <T>(sub: string | null, work: (q: Q) => Promise<T>) =>
      withClient(env.appUrl(s), (client) =>
        asUser(client, s, sub, () => work((sql, params) => client.query(sql, params))),
      );

    beforeAll(async () => {
      env = await prepareEnvironments();
      await withClient(TEST_DATABASE_URL!, async (client) => {
        await client.query('begin');
        await client.query(`set local role owner_${s}`);
        await client.query(`
          insert into ${s}.app_users (id, email) values
            ('${USER_A}', 'a@example.test'), ('${USER_B}', 'b@example.test');
          insert into ${s}.plans (user_id, id, status, created_from, name, start_date)
            values ('${USER_A}', '${PLAN_A}', 'active', 'import', 'Plan', '2026-01-05');
          insert into ${s}.tasks (user_id, plan_id, id, title, type, est_hours, sort_order, skill_ids)
            values ('${USER_A}', '${PLAN_A}', 'with', 'T', 'course', 1, 0, '{sql,python}');
        `);
        await client.query('commit');
      });
    });

    it('is a nullable text[] with no default', async () => {
      const { rows } = await withClient(TEST_DATABASE_URL!, (client) =>
        client.query(
          `select data_type, udt_name, is_nullable, column_default
             from information_schema.columns
            where table_schema = $1 and table_name = 'tasks' and column_name = 'skill_ids'`,
          [s],
        ),
      );
      expect(rows).toEqual([
        { data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES', column_default: null },
      ]);
    });

    it('an insert without the column leaves NULL (unknown); an empty array stays empty', async () => {
      await as(USER_A, async (q) => {
        await q(insertTask(s, 'old-style'));
        await q(insertTask(s, 'booking', ', skill_ids', ", '{}'"));
        const { rows } = await q(
          `select id, skill_ids from ${s}.tasks where plan_id = '${PLAN_A}' order by id`,
        );
        expect(rows).toEqual([
          { id: 'booking', skill_ids: [] },
          { id: 'old-style', skill_ids: null },
          { id: 'with', skill_ids: ['sql', 'python'] },
        ]);
      });
    });

    it('rejects more than 10 ids', async () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `s${i}`).join(',');
      await expect(
        as(USER_A, (q) => q(insertTask(s, 'many', ', skill_ids', `, '{${eleven}}'`))),
      ).rejects.toThrow(/tasks_skill_ids_check/);
    });

    it('RLS still isolates the column: another user sees no row and cannot update it', async () => {
      await as(USER_B, async (q) => {
        expect((await q(`select skill_ids from ${s}.tasks`)).rows).toEqual([]);
        const upd = await q(`update ${s}.tasks set skill_ids = '{x}' where id = 'with'`);
        expect(upd.rowCount).toBe(0);
        await expect(q(insertTask(s, 'stolen', ', skill_ids', ", '{sql}'"))).rejects.toThrow(
          /row-level security/,
        );
      });
      await as(USER_A, async (q) => {
        const { rows } = await q(`select skill_ids from ${s}.tasks where id = 'with'`);
        expect(rows).toEqual([{ skill_ids: ['sql', 'python'] }]);
      });
    });
  });
}

describe.skipIf(!dbAvailable)('migration 0020 on top of data written before it', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    await resetEnvironments();
  });

  it('keeps old rows readable: skill_ids is NULL for tasks that existed before', async () => {
    await resetEnvironments();
    const dir = await mkdtemp(join(tmpdir(), 'upversion-migrations-'));
    dirs.push(dir);
    await cp(MIGRATIONS, dir, { recursive: true });
    const all = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const target = all.find((f) => f.startsWith('0020_'))!;
    // Hold 0020 back: the database is at the previous release's level.
    await unlink(join(dir, target));
    const opts = {
      schema: 'rnd',
      connectionString: TEST_DATABASE_URL!,
      migrationsDir: dir,
    } as const;
    await migrate(opts);
    await withClient(TEST_DATABASE_URL!, async (client) => {
      await client.query('begin');
      await client.query(`set local role owner_rnd`);
      await client.query(`
        insert into rnd.app_users (id, email) values ('${USER_A}', 'a@example.test');
        insert into rnd.plans (user_id, id, status, created_from, name, start_date)
          values ('${USER_A}', '${PLAN_A}', 'active', 'import', 'Plan', '2026-01-05');
        insert into rnd.tasks (user_id, plan_id, id, title, type, est_hours, sort_order)
          values ('${USER_A}', '${PLAN_A}', 'old', 'T', 'course', 1, 0);
      `);
      await client.query('commit');
    });
    // Now the real directory, with 0020 included.
    const result = await migrate({ ...opts, migrationsDir: MIGRATIONS });
    expect(result.applied).toEqual([expect.stringContaining('0020')]);
    await withClient(TEST_DATABASE_URL!, async (client) => {
      const { rows } = await client.query(
        `select id, skill_ids from rnd.tasks where plan_id = '${PLAN_A}'`,
      );
      expect(rows).toEqual([{ id: 'old', skill_ids: null }]);
    });
  });
});
