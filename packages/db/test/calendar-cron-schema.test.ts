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

// Migration 0018 (scheduled calendar sync): calendar_connections.auto_sync and the narrow
// cross-user function calendar_users_due. Grants are also checked in convention.test.ts.

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const U = {
  due: id(1),
  recent: id(2),
  off: id(3),
  reconnect: id(4),
  gone: id(5),
  never: id(6),
  disabled: id(7),
};
const NO_PRIVILEGE = /permission denied/;

type Q = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

for (const schema of ENVS) {
  describe.skipIf(!dbAvailable)(`calendar auto_sync and calendar_users_due (${schema})`, () => {
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
        for (const [name, uid] of Object.entries(U)) {
          await client.query(`insert into ${s}.app_users (id, email, status) values ($1, $2, $3)`, [
            uid,
            `${name}@example.test`,
            name === 'disabled' ? 'disabled' : 'active',
          ]);
        }
        const conn = (
          user: string,
          status: string,
          synced: string | null,
          autoSync = true,
          token: string | null = 'cipher',
        ) =>
          client.query(
            `insert into ${s}.calendar_connections
               (user_id, status, app_calendar_id, refresh_token_ciphertext, last_synced_at, auto_sync)
             values ($1, $2, 'cal', $3, ${synced ? `now() - interval '${synced}'` : 'null'}, $4)`,
            [user, status, token, autoSync],
          );
        await conn(U.due, 'connected', '30 minutes');
        await conn(U.recent, 'connected', '2 minutes');
        await conn(U.off, 'connected', '2 hours', false);
        await conn(U.reconnect, 'needs_reconnect', '2 hours');
        await conn(U.gone, 'disconnected', '2 hours', true, null);
        await conn(U.never, 'connected', null);
        await conn(U.disabled, 'connected', '2 hours');
        await client.query('commit');
      });
    });

    const due = (q: Q, interval = '10 minutes', limit = 20) =>
      q(`select * from ${s}.calendar_users_due($1::interval, $2)`, [interval, limit]);

    it('defaults auto_sync to true', async () => {
      await as(U.due, async (q) => {
        const { rows } = await q(`select auto_sync from ${s}.calendar_connections`);
        expect(rows).toEqual([{ auto_sync: true }]);
      });
    });

    it('returns only due users, never-synced first then oldest first, as uuids only', async () => {
      await as(null, async (q) => {
        const { rows } = await due(q);
        expect(rows).toEqual([{ user_id: U.never }, { user_id: U.due }]);
      });
    });

    it('honours the interval and the limit, and clamps the limit to 1..100', async () => {
      await as(null, async (q) => {
        expect((await due(q, '1 minute')).rows).toHaveLength(3); // the recent one joins in
        expect((await due(q, '1 minute', 1)).rows).toEqual([{ user_id: U.never }]);
        expect((await due(q, '10 minutes', 0)).rows).toHaveLength(1);
        expect((await due(q, '10 minutes', -5)).rows).toHaveLength(1);
        expect((await due(q, '10 minutes', 100000)).rows).toHaveLength(2);
      });
    });

    /** Runs `work` as the superuser in a transaction that is always rolled back. */
    const scratch = <T>(work: (q: Q) => Promise<T>) =>
      withClient(TEST_SUPERUSER_URL!, async (client) => {
        await client.query('begin');
        try {
          return await work((sql, params) => client.query(sql, params));
        } finally {
          await client.query('rollback');
        }
      });

    it('skips a connection with no stored refresh token or no app calendar', async () => {
      await scratch(async (q) => {
        await q(
          `update ${s}.calendar_connections set refresh_token_ciphertext = null where user_id = $1`,
          [U.due],
        );
        expect((await due(q)).rows).toEqual([{ user_id: U.never }]);
      });
      await scratch(async (q) => {
        await q(`update ${s}.calendar_connections set app_calendar_id = null where user_id = $1`, [
          U.due,
        ]);
        expect((await due(q)).rows).toEqual([{ user_id: U.never }]);
      });
    });

    it('never returns more than 100 rows, however large the limit', async () => {
      await scratch(async (q) => {
        await q(
          `insert into ${s}.app_users (id, email)
           select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'bulk' || g || '@example.test'
             from generate_series(1, 130) g`,
        );
        await q(
          `insert into ${s}.calendar_connections (user_id, status, app_calendar_id, refresh_token_ciphertext)
           select id, 'connected', 'cal', 'cipher' from ${s}.app_users where email like 'bulk%'`,
        );
        expect((await due(q, '10 minutes', 100000)).rows).toHaveLength(100);
        expect((await due(q, '10 minutes', 100)).rows).toHaveLength(100);
        expect((await due(q, '10 minutes', 99)).rows).toHaveLength(99);
      });
    });

    it('revokes EXECUTE from PUBLIC and lists only the app role', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ public_execute: boolean; app: boolean }>(
          `select has_function_privilege('public', p.oid, 'execute') as public_execute,
                  has_function_privilege('app_${s}_user', p.oid, 'execute') as app
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = $1 and p.proname = 'calendar_users_due'`,
          [s],
        );
        expect(rows).toEqual([{ public_execute: false, app: true }]);
        // Nobody else: the backup role and the other environment's app role cannot execute it.
        const other = s === 'rnd' ? 'prod' : 'rnd';
        const { rows: others } = await client.query<{ role: string; can: boolean }>(
          `select r as role, has_function_privilege(r, p.oid, 'execute') as can
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                  unnest(array['backup_${s}', 'app_${other}_user', 'app_${other}']) r
            where n.nspname = $1 and p.proname = 'calendar_users_due'
            order by r`,
          [s],
        );
        expect(others.every((r) => r.can === false)).toBe(true);
        expect(others).toHaveLength(3);
      });
    });

    it('keeps the owner default ACL that takes EXECUTE on new functions away from PUBLIC', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        const { rows } = await client.query<{ acl: string }>(
          `select defaclacl::text as acl from pg_default_acl
            where defaclrole = 'owner_${s}'::regrole and defaclobjtype = 'f'
              and defaclnamespace = 0`,
        );
        expect(rows).toHaveLength(1);
        // A PUBLIC entry would read "=X/owner_<env>"; the owner's own entry is all that is left.
        expect(rows[0]!.acl).not.toMatch(/(^|[{,"])=X\//);
      });
    });

    it('lets a user update only their own auto_sync (RLS unchanged)', async () => {
      await as(U.due, async (q) => {
        await q(`update ${s}.calendar_connections set auto_sync = false`);
        const { rows } = await q(`select user_id, auto_sync from ${s}.calendar_connections`);
        expect(rows).toEqual([{ user_id: U.due, auto_sync: false }]);
        const other = await q(
          `update ${s}.calendar_connections set auto_sync = false where user_id = $1`,
          [U.recent],
        );
        expect(other.rowCount).toBe(0);
      });
    });

    it('is not callable by the backup role or by the other environment’s app role', async () => {
      await withClient(TEST_SUPERUSER_URL!, async (client) => {
        for (const role of [`backup_${s}`, `app_${s === 'rnd' ? 'prod' : 'rnd'}_user`]) {
          await client.query('begin');
          try {
            await client.query(`set local role ${role}`);
            await expect(
              client.query(`select * from ${s}.calendar_users_due('10 minutes', 5)`),
            ).rejects.toThrow(NO_PRIVILEGE);
          } finally {
            await client.query('rollback');
          }
        }
      });
    });
  });
}
