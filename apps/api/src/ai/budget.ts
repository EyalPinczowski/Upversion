import type { Database, UserContext } from '../db/database';
import type { AIPurpose } from './provider';

/**
 * AI usage accounting (plan 3.2). Two kinds of counter:
 * - per user, UTC day and purpose (`ai_usage_daily`), checked against the user caps;
 * - per provider and UTC day for the whole environment (`ai_provider_usage`), checked against
 *   the provider's budget. The app role has no access to that table; it only calls the two
 *   definer functions, through the helpers below.
 *
 * Every method here runs in its OWN short transaction that commits before it returns. The
 * gateway calls them before a network call and never inside a transaction that spans one.
 */

/** The UTC day as `YYYY-MM-DD`. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/** 00:00 UTC of the next day. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface PurposeUsage {
  used: number;
  avoided: number;
}

export interface UsageSnapshot {
  day: string;
  resetsAt: Date;
  user: Record<AIPurpose, PurposeUsage>;
  /** Today's reserved calls per provider id, environment-wide. */
  providers: Record<string, number>;
}

export interface AIUsageStore {
  /** Reserves one call against the user's cap. `ok` is false (and nothing changes) at the cap. */
  reserveUser(userId: string, purpose: AIPurpose, cap: number): Promise<{ ok: boolean }>;
  /** Counts a call that was not needed (cache hit, template, local repair). */
  noteAvoided(userId: string, purpose: AIPurpose): Promise<void>;
  /** Reserves one call against the provider's environment budget. False when it is used up. */
  reserveProvider(userId: string, providerId: string, budget: number): Promise<boolean>;
  snapshot(userId: string): Promise<UsageSnapshot>;
  /** Today's reserved calls per provider id, environment-wide (no user data). */
  providerUsage(userId: string): Promise<Record<string, number>>;
  /**
   * Today's (UTC) reserved calls for one purpose summed over ALL users: the one number an
   * app-wide cap needs. Read through a SECURITY DEFINER function (migration 0017) because RLS
   * gives the app role only its own rows.
   */
  featureTotalToday(userId: string, purpose: AIPurpose): Promise<number>;
}

/**
 * Calls the SQL function `ai_reserve_provider` on the given transaction. This is the only code
 * that does; the store and the tests use it, so the budget rule lives in one place (the
 * database). The function picks the UTC day itself and returns false at or over the budget.
 */
export async function reserveProviderBudget(
  ctx: UserContext,
  providerId: string,
  budget: number,
): Promise<boolean> {
  const { rows } = await ctx.client.query<{ ok: boolean }>(
    `select ${ctx.schema}.ai_reserve_provider($1::text, $2::integer) as ok`,
    [providerId, budget],
  );
  return rows[0]?.ok === true;
}

/** Reserves one call against the user's cap on the given transaction (atomic upsert). */
export async function reserveUserCap(
  ctx: UserContext,
  userId: string,
  day: string,
  purpose: AIPurpose,
  cap: number,
): Promise<boolean> {
  // A cap below 1 means "none allowed". Checked here because the insert branch of the upsert
  // would otherwise create the row with one request.
  if (!Number.isInteger(cap) || cap < 1) return false;
  const { rows } = await ctx.client.query<{ requests: number }>(
    `insert into ${ctx.schema}.ai_usage_daily as u (user_id, day, purpose, requests)
     values ($1::uuid, $2::date, $3::text, 1)
     on conflict (user_id, day, purpose) do update set requests = u.requests + 1
       where u.requests < $4::integer
     returning requests`,
    [userId, day, purpose, cap],
  );
  return rows.length === 1;
}

export function createAIUsageStore(db: Database, now: () => Date = () => new Date()): AIUsageStore {
  return {
    async reserveUser(userId, purpose, cap) {
      const day = utcDay(now());
      const ok = await db.withUser(userId, (ctx) => reserveUserCap(ctx, userId, day, purpose, cap));
      return { ok };
    },

    async noteAvoided(userId, purpose) {
      const day = utcDay(now());
      await db.withUser(userId, async (ctx) => {
        await ctx.client.query(
          `insert into ${ctx.schema}.ai_usage_daily as u (user_id, day, purpose, avoided)
           values ($1::uuid, $2::date, $3::text, 1)
           on conflict (user_id, day, purpose) do update set avoided = u.avoided + 1`,
          [userId, day, purpose],
        );
      });
    },

    reserveProvider(userId, providerId, budget) {
      return db.withUser(userId, (ctx) => reserveProviderBudget(ctx, providerId, budget));
    },

    providerUsage(userId) {
      return db.withUser(userId, async (ctx) => {
        const env = await ctx.client.query<{ provider_id: string; requests: number }>(
          `select provider_id, requests from ${ctx.schema}.ai_provider_usage_today()`,
        );
        return Object.fromEntries(env.rows.map((r) => [r.provider_id, r.requests]));
      });
    },

    featureTotalToday(userId, purpose) {
      return db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<{ n: string }>(
          `select ${ctx.schema}.ai_feature_usage_today($1::text) as n`,
          [purpose],
        );
        return Number(rows[0]?.n ?? 0);
      });
    },

    async snapshot(userId) {
      const at = now();
      const day = utcDay(at);
      return db.withUser(userId, async (ctx) => {
        const own = await ctx.client.query<{
          purpose: AIPurpose;
          requests: number;
          avoided: number;
        }>(
          `select purpose, requests, avoided from ${ctx.schema}.ai_usage_daily
            where user_id = $1::uuid and day = $2::date`,
          [userId, day],
        );
        const env = await ctx.client.query<{ provider_id: string; requests: number }>(
          `select provider_id, requests from ${ctx.schema}.ai_provider_usage_today()`,
        );
        const user: Record<AIPurpose, PurposeUsage> = {
          practice_message: { used: 0, avoided: 0 },
          practice_feedback: { used: 0, avoided: 0 },
          day_overview: { used: 0, avoided: 0 },
          cv_tailor: { used: 0, avoided: 0 },
        };
        for (const row of own.rows) {
          user[row.purpose] = { used: row.requests, avoided: row.avoided };
        }
        return {
          day,
          resetsAt: nextUtcMidnight(at),
          user,
          providers: Object.fromEntries(env.rows.map((r) => [r.provider_id, r.requests])),
        };
      });
    },
  };
}
