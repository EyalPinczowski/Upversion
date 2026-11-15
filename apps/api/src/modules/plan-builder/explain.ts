import {
  explainedLines,
  knownIdentifiersFor,
  PiiLeakError,
  planExplainInput,
  PLAN_EXPLAIN_SYSTEM,
  planExplainUserMessage,
  type BuildCatalog,
  type BuildDraft,
  type BuildRequest,
  type ExplainedLine,
  type PlanExplainInput,
} from '@upversion/shared';
import type { AIUsageStore } from '../../ai/budget';
import { cacheKey, readCached } from '../../ai/cache';
import { AIUnavailableError, AIUserCapError, type AIGateway } from '../../ai/gateway';
import type { AIPurpose } from '../../ai/provider';
import type { AIRegistry } from '../../ai/registry';
import { buildSafeRequest, type SafeAIRequest } from '../../ai/safe-request';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { getIdentity } from '../practice/repository';

/** The providers that may receive the (catalog-only) input, in the order they are tried. */
export const PLAN_EXPLAIN_PROVIDERS = ['cloudflare-ai', 'groq'] as const;

const PURPOSE: AIPurpose = 'plan_explain';
const MAX_OUTPUT_TOKENS = 1600;
const FALLBACKS = ['template'];

export interface PlanExplainDeps {
  db: Database;
  gateway: AIGateway;
  registry: AIRegistry;
  usage: AIUsageStore;
  userCap: number;
  dailyTotal: number;
  catalog: BuildCatalog;
  now: () => Date;
}

export interface PlanExplainResult {
  lines: ExplainedLine[];
  providers: { id: string; label: string }[];
  usage: { used: number; cap: number };
}

const unavailable = () =>
  new HttpError(503, 'ai_unavailable', 'AI explanations are not available right now.', {
    fallbacks: FALLBACKS,
  });

/**
 * Optional AI explanations (ADR 017 section 3). The input is the allowlist `planExplainInput`
 * builds from a draft the server rebuilt itself; nothing the client typed and nothing from the
 * profile or the CV is read. The answer is checked line by line; a refused line is the template
 * line. The only things stored are the gateway's per-user counter and its cache entry.
 */
export function createPlanExplainService(deps: PlanExplainDeps) {
  const { db, gateway, registry, usage, catalog } = deps;

  /** The request for a draft: same draft, same identifiers, same text (so the same cache key). */
  function prepare(
    known: readonly string[],
    draft: BuildDraft,
    request: BuildRequest,
  ): { input: PlanExplainInput; safe: SafeAIRequest } | null {
    const windows = PLAN_EXPLAIN_PROVIDERS.flatMap((id) => {
      const p = registry.get(id);
      return p ? [p.maxContextChars] : [];
    });
    const limit = windows.length > 0 ? Math.min(...windows) : Infinity;
    for (let max = 30; max >= 1; max = max > 2 ? max - 2 : max - 1) {
      const input = planExplainInput(draft, request, catalog, max);
      const user = planExplainUserMessage(input);
      if (PLAN_EXPLAIN_SYSTEM.length + user.length > limit) continue;
      try {
        const safe = buildSafeRequest(
          {
            purpose: PURPOSE,
            system: PLAN_EXPLAIN_SYSTEM,
            messages: [{ role: 'user', content: user }],
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            json: false,
          },
          known,
          { allowToolNames: true },
        );
        return { input, safe };
      } catch (error) {
        if (error instanceof PiiLeakError) return null;
        throw error;
      }
    }
    return null;
  }

  const identifiers = (ctx: UserContext, userId: string) =>
    getIdentity(ctx, userId).then((i) =>
      knownIdentifiersFor({ email: i.email, displayName: i.displayName }),
    );

  const usedToday = (userId: string) =>
    usage
      .snapshot(userId)
      .then((s) => s.user[PURPOSE].used)
      .catch(() => 0);

  return {
    async explain(
      userId: string,
      draft: BuildDraft,
      request: BuildRequest,
    ): Promise<PlanExplainResult> {
      const known = await db.withUser(userId, (ctx) => identifiers(ctx, userId));
      const prepared = prepare(known, draft, request);
      // Nothing could be sent safely: no provider is called and no run is spent.
      if (!prepared) throw unavailable();
      const { input, safe } = prepared;
      const labelOf = (id: string) => gateway.providers().find((p) => p.id === id)?.label ?? id;

      // A cached answer costs nothing, so it is served even when the app-wide cap is reached.
      const hit = await db
        .withUser(userId, (ctx) => readCached(ctx, userId, cacheKey(safe), deps.now()))
        .catch(() => null);
      let raw: string;
      let sentTo: string[] = [];
      if (hit !== null) {
        await usage.noteAvoided(userId, PURPOSE).catch(() => undefined);
        raw = hit;
      } else {
        // When the total cannot be read, nothing is sent and no run is spent (503, templates stay).
        const total = await usage.planExplainTotalToday(userId).catch(() => null);
        if (total === null) throw unavailable();
        if (total >= deps.dailyTotal) {
          throw new HttpError(
            429,
            'ai_feature_cap',
            'AI explanations have reached their daily limit for everyone. Try again tomorrow.',
            { fallbacks: FALLBACKS },
          );
        }
        try {
          const answer = await gateway.generate({
            userId,
            request: safe,
            userCap: 'reserve',
            providers: PLAN_EXPLAIN_PROVIDERS,
          });
          raw = answer.text;
          sentTo =
            answer.sentTo.length > 0 ? answer.sentTo : answer.providerId ? [answer.providerId] : [];
        } catch (error) {
          if (error instanceof AIUnavailableError) throw unavailable();
          if (error instanceof AIUserCapError) {
            throw new HttpError(
              429,
              'ai_user_cap',
              'You have used today’s AI explanations. Try again tomorrow.',
              { fallbacks: FALLBACKS },
            );
          }
          throw error;
        }
      }
      const { lines } = explainedLines(raw, draft, input, catalog, { knownIdentifiers: known });
      return {
        lines,
        providers: sentTo.map((id) => ({ id, label: labelOf(id) })),
        usage: { used: await usedToday(userId), cap: deps.userCap },
      };
    },

    /**
     * For a build with `useAiExplanations`: the lines of the CACHED answer for this draft, read
     * on the build's own transaction, never a provider call. No entry (or an expired one) gives
     * null and the caller saves the templates.
     */
    async cachedLines(
      ctx: UserContext,
      userId: string,
      draft: BuildDraft,
      request: BuildRequest,
    ): Promise<ExplainedLine[] | null> {
      const known = await identifiers(ctx, userId);
      const prepared = prepare(known, draft, request);
      if (!prepared) return null;
      // A failed read must not fail the build: a savepoint keeps the build's transaction usable
      // and the templates are saved instead.
      let raw: string | null;
      try {
        await ctx.client.query('savepoint plan_explain_cache');
        raw = await readCached(ctx, userId, cacheKey(prepared.safe), deps.now());
        await ctx.client.query('release savepoint plan_explain_cache');
      } catch {
        await ctx.client.query('rollback to savepoint plan_explain_cache').catch(() => undefined);
        return null;
      }
      if (raw === null) return null;
      return explainedLines(raw, draft, prepared.input, catalog, { knownIdentifiers: known }).lines;
    },
  };
}

export type PlanExplainService = ReturnType<typeof createPlanExplainService>;
