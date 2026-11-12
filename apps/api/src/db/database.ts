import pg from 'pg';

/** App environment (APP_ENV) to the database schema it uses (ADR 003). The only two schemas. */
const SCHEMA_BY_APP_ENV = { operational: 'prod', rnd: 'rnd' } as const;

export type Schema = (typeof SCHEMA_BY_APP_ENV)[keyof typeof SCHEMA_BY_APP_ENV];

/** Role names per allowlisted schema. Nothing here is built from request or env text. */
const USER_ROLE: Record<Schema, string> = { prod: 'app_prod_user', rnd: 'app_rnd_user' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function schemaForAppEnv(appEnv: string): Schema {
  if (appEnv === 'operational' || appEnv === 'rnd') return SCHEMA_BY_APP_ENV[appEnv];
  throw new Error('Unknown APP_ENV: no database schema.');
}

/** Why provision_user refused. The API shows the same generic answer for every reason. */
export class ProvisionDeniedError extends Error {
  constructor(public readonly reason: 'not_allowed' | 'cap_reached') {
    super(`account not provisioned: ${reason}`);
    this.name = 'ProvisionDeniedError';
  }
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'disabled' | 'deleted';
  created_at: Date;
  last_seen_at: Date | null;
}

/** What a request handler gets inside withUser: a client bound to the user's transaction. */
export interface UserContext {
  client: Pick<pg.PoolClient, 'query'>;
  /** The environment's schema name, from the allowlist, safe to put in SQL text. */
  schema: Schema;
}

export interface Database {
  readonly schema: Schema;
  /**
   * Runs `fn` in one transaction as `app_<schema>_user` with the verified user's claims, so
   * row-level security shows only that user's rows. Everything is inside the transaction, which
   * also makes it safe behind a transaction-mode pooler. Commits on success, rolls back on error.
   */
  withUser<T>(userId: string, fn: (ctx: UserContext) => Promise<T>): Promise<T>;
  /**
   * The user ids whose calendar is due for the scheduled sync (migration 0018): connected, auto
   * sync on, last sync missing or older than `olderThanMs`; never-synced first, then oldest.
   * Runs as the app role with NO user claims; the function is SECURITY DEFINER and returns ids
   * only. Each user's own sync then runs through `withUser`.
   */
  dueCalendarUsers(olderThanMs: number, limit: number): Promise<string[]>;
  /** Creates (or returns) the profile row via provision_user, as the app login. */
  provision(userId: string, email: string): Promise<UserRow>;
  /**
   * A cheap `select 1` over a fresh connection as the app login, for the health check. Never
   * throws and never returns error text: a connection error can contain the host or the user.
   */
  ping(timeoutMs?: number): Promise<PingResult>;
  close(): Promise<void>;
}

export type PingResult = { ok: true } | { ok: false; reason: 'timeout' | 'error' };

export const DEFAULT_PING_TIMEOUT_MS = 1500;

/** `date` columns stay plain 'YYYY-MM-DD' strings instead of being shifted by the server's zone. */
const DATE_OID = 1082;
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
};

export function createDatabase(options: {
  connectionString: string;
  appEnv: string;
  max?: number;
}): Database {
  const schema = schemaForAppEnv(options.appEnv);
  const role = USER_ROLE[schema];
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    types,
  });
  // An idle connection can fail (database restart, paused project, network). Without a listener
  // that is an uncaught exception and the process dies; the pool drops the client by itself.
  pool.on('error', () => undefined);

  return {
    schema,

    async withUser(userId, fn) {
      if (!UUID.test(userId)) throw new Error('withUser needs a verified user id (UUID).');
      const client = await pool.connect();
      try {
        await client.query('begin');
        try {
          await client.query(`set local role ${role}`);
          await client.query(`select set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: userId }),
          ]);
          const result = await fn({ client, schema });
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        }
      } finally {
        client.release();
      }
    },

    async dueCalendarUsers(olderThanMs, limit) {
      const seconds = Math.max(0, Math.floor(olderThanMs / 1000));
      const client = await pool.connect();
      try {
        await client.query('begin');
        try {
          await client.query(`set local role ${role}`);
          const { rows } = await client.query<{ user_id: string }>(
            `select user_id from ${schema}.calendar_users_due(make_interval(secs => $1::double precision), $2::int)`,
            [seconds, limit],
          );
          await client.query('commit');
          return rows.map((r) => r.user_id);
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        }
      } finally {
        client.release();
      }
    },

    async provision(userId, email) {
      try {
        const { rows } = await pool.query<UserRow>(
          `select * from ${schema}.provision_user($1::uuid, $2::text)`,
          [userId, email],
        );
        return rows[0]!;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'not_allowed' || message === 'cap_reached') {
          throw new ProvisionDeniedError(message);
        }
        throw error;
      }
    },

    async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS) {
      // Not the pool: a busy pool must not read as a dead database, and a hung connect must not
      // hold a pool slot. pg gives up on its own a little after our own deadline.
      const client = new pg.Client({
        connectionString: options.connectionString,
        connectionTimeoutMillis: timeoutMs + 500,
        query_timeout: timeoutMs + 500,
      });
      client.on('error', () => undefined);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<PingResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
      });
      const attempt = (async (): Promise<PingResult> => {
        try {
          await client.connect();
          await client.query('select 1');
          return { ok: true };
        } catch {
          return { ok: false, reason: 'error' };
        }
      })();
      try {
        return await Promise.race([attempt, deadline]);
      } finally {
        clearTimeout(timer);
        client.end().catch(() => undefined);
      }
    },

    async close() {
      await pool.end();
    },
  };
}

/**
 * Key text for a transaction-level advisory lock. Advisory locks are database-wide and both
 * environments live in one database (ADR 003), so the schema is always part of the key.
 * Pass the result to `hashtextextended($1::text, 0)`.
 */
export function advisoryKey(ctx: UserContext, scope: string, ...ids: string[]): string {
  return [scope, ctx.schema, ...ids].join(':');
}
