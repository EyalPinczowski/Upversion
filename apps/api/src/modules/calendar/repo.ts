import type { UserContext } from '../../db/database';

/**
 * SQL for the calendar connection. Every function runs inside `db.withUser`, so row-level security
 * limits it to the signed-in user; the explicit `user_id = $1` is a second line of defence and the
 * id always comes from the verified token. Table names come from the fixed schema allowlist.
 */

export type ConnectionStatus = 'connected' | 'needs_reconnect' | 'disconnected';

export interface ConnectionRow {
  status: ConnectionStatus;
  app_calendar_id: string | null;
  refresh_token_ciphertext: string | null;
  granted_scopes: string[];
  last_synced_at: Date | null;
  last_error_code: string | null;
}

export interface BusyItemRow {
  date: string;
  start_minute: number;
  end_minute: number;
  all_day: boolean;
  title: string;
}

export interface SourceRow {
  calendar_id: string;
  name: string;
  blocks_time: boolean;
}

/** An unfinished connect attempt is valid this long. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** A user can have this many unexpired connect attempts; the oldest are dropped beyond it. */
const MAX_OPEN_STATES = 10;

export const calendarRepo = {
  /** Stores a new state and removes this user's expired (and surplus) ones in the same step. */
  async insertState(
    ctx: UserContext,
    userId: string,
    stateHash: string,
    verifierCiphertext: string,
    now: Date,
  ): Promise<void> {
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_oauth_states where user_id = $1 and expires_at <= $2`,
      [userId, now],
    );
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_oauth_states
       where user_id = $1 and id in (
         select id from ${ctx.schema}.calendar_oauth_states where user_id = $1
         order by created_at desc, id offset $2)`,
      [userId, MAX_OPEN_STATES - 1],
    );
    await ctx.client.query(
      `insert into ${ctx.schema}.calendar_oauth_states
         (user_id, state_hash, pkce_verifier_ciphertext, created_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [userId, stateHash, verifierCiphertext, now, new Date(now.getTime() + STATE_TTL_MS)],
    );
  },

  /** Single use: the row is deleted as it is read. Another user's state is invisible (RLS + id). */
  async consumeState(
    ctx: UserContext,
    userId: string,
    stateHash: string,
  ): Promise<{ verifierCiphertext: string; expiresAt: Date } | null> {
    const { rows } = await ctx.client.query<{ pkce_verifier_ciphertext: string; expires_at: Date }>(
      `delete from ${ctx.schema}.calendar_oauth_states where user_id = $1 and state_hash = $2
       returning pkce_verifier_ciphertext, expires_at`,
      [userId, stateHash],
    );
    const row = rows[0];
    return row
      ? { verifierCiphertext: row.pkce_verifier_ciphertext, expiresAt: row.expires_at }
      : null;
  },

  async getConnection(ctx: UserContext, userId: string): Promise<ConnectionRow | null> {
    const { rows } = await ctx.client.query<ConnectionRow>(
      `select status, app_calendar_id, refresh_token_ciphertext, granted_scopes, last_synced_at,
              last_error_code
       from ${ctx.schema}.calendar_connections where user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  },

  async upsertConnection(
    ctx: UserContext,
    userId: string,
    values: { appCalendarId: string; refreshTokenCiphertext: string; grantedScopes: string[] },
  ): Promise<void> {
    await ctx.client.query(
      `insert into ${ctx.schema}.calendar_connections
         (user_id, provider, app_calendar_id, status, granted_scopes, refresh_token_ciphertext)
       values ($1, 'google', $2, 'connected', $3, $4)
       on conflict (user_id) do update set
         app_calendar_id = excluded.app_calendar_id,
         status = 'connected',
         granted_scopes = excluded.granted_scopes,
         refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         last_error_code = null,
         updated_at = now()`,
      [userId, values.appCalendarId, values.grantedScopes, values.refreshTokenCiphertext],
    );
  },

  /** Keeps every other column. A missing connection is left missing. */
  async markNeedsReconnect(ctx: UserContext, userId: string, code: string): Promise<void> {
    await ctx.client.query(
      `update ${ctx.schema}.calendar_connections
       set status = 'needs_reconnect', last_error_code = $2, updated_at = now()
       where user_id = $1 and status <> 'disconnected'`,
      [userId, code],
    );
  },

  async listSources(ctx: UserContext, userId: string): Promise<SourceRow[]> {
    const { rows } = await ctx.client.query<SourceRow>(
      `select calendar_id, name, blocks_time from ${ctx.schema}.calendar_sources
       where user_id = $1 order by blocks_time desc, name, calendar_id`,
      [userId],
    );
    return rows;
  },

  /** New calendars get `blocksTime`; known ones keep the user's choice and only refresh the name. */
  async upsertSource(
    ctx: UserContext,
    userId: string,
    calendarId: string,
    name: string,
    blocksTime: boolean,
  ): Promise<void> {
    await ctx.client.query(
      `insert into ${ctx.schema}.calendar_sources (user_id, calendar_id, name, blocks_time)
       values ($1, $2, $3, $4)
       on conflict (user_id, calendar_id) do update set name = excluded.name`,
      [userId, calendarId, name, blocksTime],
    );
  },

  /** Returns how many of the ids exist (and were updated). */
  async setBlocksTime(
    ctx: UserContext,
    userId: string,
    calendarId: string,
    blocksTime: boolean,
  ): Promise<number> {
    const { rowCount } = await ctx.client.query(
      `update ${ctx.schema}.calendar_sources set blocks_time = $3
       where user_id = $1 and calendar_id = $2`,
      [userId, calendarId, blocksTime],
    );
    return rowCount ?? 0;
  },

  /**
   * Busy intervals for the time grid: only calendars the owner chose to block time, only events
   * that count as busy (not tentative ones, not all-day ones unless marked as blocking).
   */
  async listBusy(
    ctx: UserContext,
    userId: string,
    from: string,
    to: string,
  ): Promise<BusyItemRow[]> {
    const { rows } = await ctx.client.query<BusyItemRow>(
      `select b.date::text as date, b.start_minute, b.end_minute,
              (b.kind = 'all_day') as all_day, b.title
       from ${ctx.schema}.calendar_busy b
       join ${ctx.schema}.calendar_sources s
         on s.user_id = b.user_id and s.calendar_id = b.source_calendar_id and s.blocks_time
       where b.user_id = $1 and b.date between $2::date and $3::date
         and (b.kind = 'busy' or (b.kind = 'all_day' and b.blocks_day))
       order by b.date, b.start_minute, b.external_event_id`,
      [userId, from, to],
    );
    return rows;
  },

  /** Slots of blocks the user deleted in Google (they stay unavailable), with the sync's zone. */
  async listDeletedLocks(
    ctx: UserContext,
    userId: string,
    from: string,
    to: string,
  ): Promise<{ starts_at: Date; ends_at: Date; sync_timezone: string | null }[]> {
    const { rows } = await ctx.client.query<{
      starts_at: Date;
      ends_at: Date;
      sync_timezone: string | null;
    }>(
      `select l.starts_at, l.ends_at, c.sync_timezone
       from ${ctx.schema}.calendar_locked_blocks l
       left join ${ctx.schema}.calendar_connections c on c.user_id = l.user_id
       where l.user_id = $1 and l.reason = 'deleted'
         and l.ends_at > ($2::date - 1) and l.starts_at < ($3::date + 2)
       order by l.starts_at, l.block_key`,
      [userId, from, to],
    );
    return rows;
  },

  /** Removes everything the app stores about the connection. The account and plans stay. */
  async deleteAll(ctx: UserContext, userId: string): Promise<void> {
    for (const table of [
      'calendar_busy',
      'calendar_event_links',
      'calendar_locked_blocks',
      'calendar_sources',
      'calendar_oauth_states',
      'calendar_connections',
    ]) {
      await ctx.client.query(`delete from ${ctx.schema}.${table} where user_id = $1`, [userId]);
    }
  },
};
