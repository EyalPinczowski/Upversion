import { createHash } from 'node:crypto';
import type { Database, UserContext } from '../db/database';
import type { AIPurpose } from './provider';
import type { SafeAIRequest } from './safe-request';

/** How long a stored answer is reused. Chat turns are unique and are never cached. */
export const CACHE_TTL_MS: Readonly<Partial<Record<AIPurpose, number>>> = {
  day_overview: 36 * 3600_000,
  practice_feedback: 7 * 24 * 3600_000,
  // Plan builder explanations (ADR 017): the same draft gives the same request, so it hits.
  plan_explain: 7 * 24 * 3600_000,
};

/** The database allows at most this many characters of cached text. */
export const MAX_CACHED_CHARS = 8000;

/**
 * sha256 (hex) over the purpose, the system text, the messages and the options that change the
 * answer, computed on the already-redacted request and independent of the provider. Fields are
 * JSON-encoded so no two different requests can produce the same input string.
 */
export function cacheKey(request: SafeAIRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.purpose,
        request.system,
        request.messages.map((m) => [m.role, m.content]),
        request.maxOutputTokens,
        request.json,
      ]),
    )
    .digest('hex');
}

/** One cache read on an open transaction (RLS applies). Null when missing or expired. */
export async function readCached(
  ctx: UserContext,
  userId: string,
  key: string,
  now: Date = new Date(),
): Promise<string | null> {
  const { rows } = await ctx.client.query<{ text: string }>(
    `select text from ${ctx.schema}.ai_cache
      where user_id = $1::uuid and key = $2::text and expires_at > $3::timestamptz`,
    [userId, key, now],
  );
  return rows[0]?.text ?? null;
}

export interface AICache {
  get(userId: string, key: string): Promise<string | null>;
  put(userId: string, key: string, purpose: AIPurpose, text: string, ttlMs: number): Promise<void>;
}

/** Per-user cache in `ai_cache` (RLS applies). Expired rows are ignored on read and pruned on write. */
export function createAICache(db: Database, now: () => Date = () => new Date()): AICache {
  return {
    async get(userId, key) {
      return db.withUser(userId, (ctx) => readCached(ctx, userId, key, now()));
    },

    async put(userId, key, purpose, text, ttlMs) {
      if (text.length > MAX_CACHED_CHARS || ttlMs <= 0) return;
      const created = now();
      const expires = new Date(created.getTime() + ttlMs);
      await db.withUser(userId, async (ctx) => {
        await ctx.client.query(
          `delete from ${ctx.schema}.ai_cache where user_id = $1::uuid and expires_at <= $2::timestamptz`,
          [userId, created],
        );
        await ctx.client.query(
          `insert into ${ctx.schema}.ai_cache as c (user_id, key, purpose, text, created_at, expires_at)
           values ($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz, $6::timestamptz)
           on conflict (user_id, key) do update
             set purpose = excluded.purpose, text = excluded.text,
                 created_at = excluded.created_at, expires_at = excluded.expires_at`,
          [userId, key, purpose, text, created, expires],
        );
      });
    },
  };
}
