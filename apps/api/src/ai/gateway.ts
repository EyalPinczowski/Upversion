import { HttpError } from '../errors';
import { nextUtcMidnight, type AIUsageStore } from './budget';
import { cacheKey, CACHE_TTL_MS, type AICache } from './cache';
import {
  ProviderQuotaError,
  ProviderUnavailableError,
  type AIProvider,
  type AIPurpose,
  type AIResponse,
} from './provider';
import type { AIRegistry } from './registry';
import { isSafeAIRequest, type SafeAIRequest } from './safe-request';

/** 429: the user used today's calls for this purpose. Other users are unaffected. */
export class AIUserCapError extends HttpError {
  /** What the client can offer instead (spec 9). */
  get fallbacks(): readonly string[] {
    return ['copy_prompt', 'self_rubric'];
  }
  constructor(public readonly purpose: AIPurpose) {
    super(429, 'ai_user_cap', 'You have used today’s AI calls for this. Try again tomorrow.', {
      fallbacks: ['copy_prompt', 'self_rubric'],
    });
    this.name = 'AIUserCapError';
  }
}

/** Why the gateway could not answer. Never carries provider text. */
export type Unavailability = 'not_configured' | 'exhausted';
export type SwitchReason = 'quota' | 'error' | 'timeout';

/** 503: no provider is configured, or every one was skipped or failed this turn. */
export class AIUnavailableError extends HttpError {
  constructor(
    public readonly reason: Unavailability,
    /** Per provider outcome, ids and codes only. */
    public readonly attempts: readonly { providerId: string; outcome: string }[] = [],
  ) {
    super(503, 'ai_unavailable', 'AI is not available right now.');
    this.name = 'AIUnavailableError';
  }
}

/** The caller's own signal aborted (the client went away). Not a provider failure. */
export class AIAbortedError extends HttpError {
  constructor() {
    // 499 (client closed request): a quiet answer, not an unhandled 500.
    super(499, 'client_closed_request', 'The request was cancelled.');
    this.name = 'AIAbortedError';
  }
}

export interface GatewayConfig {
  /** Provider ids in the order they are tried (also the order of the usage meter). */
  providerOrder: readonly string[];
  /** Calls per UTC day per provider. A provider with no positive entry is never called. */
  budgets: Readonly<Record<string, number>>;
  userCaps: Readonly<Record<AIPurpose, number>>;
  /** One provider attempt. */
  timeoutMs: number;
  /** The whole turn, across fallbacks. */
  turnTimeoutMs: number;
  historyChars: number;
}

export interface GatewayLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GatewayDeps {
  registry: AIRegistry;
  config: GatewayConfig;
  usage: AIUsageStore;
  /** Null disables caching. */
  cache?: AICache | null;
  now?: () => Date;
  log?: GatewayLog;
}

export interface GenerateOptions {
  /** The verified user. Never taken from the client. */
  userId: string;
  request: SafeAIRequest;
  /** Aborts the whole turn, including the provider call in flight. */
  signal?: AbortSignal;
  /**
   * `reserve` (default): the gateway reserves one of the user's calls, in its own transaction.
   * `already_reserved`: the caller did it in an earlier transaction (practice chat, plan 2.2).
   */
  userCap?: 'reserve' | 'already_reserved';
  /**
   * Restricts this call to these provider ids, in this order. No other provider is ever
   * consulted (not for the usable check, a budget, a cooldown or an attempt). Used by purposes
   * whose text only certain providers may receive (CV tailoring, ADR 016). Default: all, in the
   * gateway's own order.
   */
  providers?: readonly string[];
}

export interface GatewayResult {
  text: string;
  /** Null when the answer came from the cache. */
  providerId: string | null;
  label: string | null;
  model: string | null;
  /** Set when an earlier provider was skipped or failed and another answered. */
  switched: { from: string; to: string; reason: SwitchReason } | null;
  cached: boolean;
  /**
   * Ids of every provider the request body was handed to, in order: the ones that failed after
   * the call started, then the one that answered. Empty for a cache hit.
   */
  sentTo: string[];
}

export interface ProviderStatus {
  id: string;
  label: string;
  /** Registered and allowed (its keys are present). */
  configured: boolean;
  /** The environment budget, or null when none is set (the provider is then not used). */
  budget: number | null;
  cooldownUntil: Date | null;
}

export interface AIGateway {
  generate(options: GenerateOptions): Promise<GatewayResult>;
  providers(): ProviderStatus[];
  /** The history size to build requests with: the smallest limit among the providers. */
  historyLimitChars(): number;
}

const UNAVAILABLE_COOLDOWN_MS = 60_000;
const MIN_RETRY_AFTER_MS = 5000;
const MAX_COOLDOWN_MS = 24 * 3600_000;
const MAX_REPLY_CHARS = 20_000;

class TimedOut extends Error {}

export function createAIGateway(deps: GatewayDeps): AIGateway {
  const { registry, config, usage } = deps;
  const now = deps.now ?? (() => new Date());
  const cooldowns = new Map<string, { until: number; reason: SwitchReason }>();

  const warn = (obj: Record<string, unknown>, msg: string) => {
    try {
      deps.log?.warn(obj, msg);
    } catch {
      // Logging must never break a call.
    }
  };
  const budgetOf = (id: string): number => {
    const b = config.budgets[id];
    return typeof b === 'number' && Number.isInteger(b) && b > 0 ? b : 0;
  };
  const coolingUntil = (id: string): { until: number; reason: SwitchReason } | null => {
    const c = cooldowns.get(id);
    if (!c) return null;
    if (c.until <= now().getTime()) {
      cooldowns.delete(id);
      return null;
    }
    return c;
  };

  /**
   * Runs one provider attempt. The signal is passed to the provider AND raced against it, so a
   * provider that ignores the signal still stops holding up the turn. The timer and listener
   * are always released.
   */
  async function attempt(
    provider: AIProvider,
    request: SafeAIRequest,
    timeoutMs: number,
    outer: AbortSignal | undefined,
  ): Promise<AIResponse> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new TimedOut()), timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout.signal]) : timeout.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('aborted'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([provider.generate(request, { signal }), aborted]);
    } catch (error) {
      // Our own deadline wins over whatever the provider threw when it was cut off.
      if (timeout.signal.aborted && !outer?.aborted) throw new TimedOut();
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    providers() {
      return config.providerOrder.map((id) => {
        const p = registry.get(id);
        const cd = p ? coolingUntil(id) : null;
        const budget = budgetOf(id);
        return {
          id,
          label: p?.label ?? id,
          configured: p !== undefined,
          budget: p && budget > 0 ? budget : null,
          cooldownUntil: cd ? new Date(cd.until) : null,
        };
      });
    },

    historyLimitChars() {
      const limits = registry.list().map((p) => p.maxContextChars);
      return Math.min(config.historyChars, ...limits.filter((n) => n > 0));
    },

    async generate({ userId, request, signal, userCap = 'reserve', providers: only }) {
      if (!isSafeAIRequest(request))
        throw new TypeError('generate needs a request from buildSafeRequest.');
      const purpose = request.purpose;
      const startedAt = now().getTime();

      // 1. The cache: a hit costs nothing and uses no provider or cap.
      const ttl = CACHE_TTL_MS[purpose];
      const cache = ttl ? (deps.cache ?? null) : null;
      const key = cache ? cacheKey(request) : null;
      if (cache && key) {
        try {
          const hit = await cache.get(userId, key);
          if (hit !== null) {
            await usage.noteAvoided(userId, purpose).catch(() => undefined);
            return {
              text: hit,
              providerId: null,
              label: null,
              model: null,
              switched: null,
              cached: true,
              sentTo: [],
            };
          }
        } catch {
          warn({ code: 'cache_read_failed' }, 'ai cache read failed');
        }
      }

      // 2. Is any provider usable at all? Checked BEFORE the user's cap is spent.
      const ordered = (only ?? config.providerOrder)
        .map((id) => registry.get(id))
        .filter((p): p is AIProvider => p !== undefined);
      if (!ordered.some((p) => budgetOf(p.id) > 0 && !coolingUntil(p.id))) {
        throw new AIUnavailableError(ordered.length === 0 ? 'not_configured' : 'exhausted');
      }
      // The budget that is LEFT is checked too, before the user's call is reserved, so a run that
      // no provider could take (every budget used up) costs the user nothing. A budget used up
      // between this read and the reservation below can still end in 'exhausted' after the user's
      // call was reserved (a race, accepted). When the read fails the check is skipped.
      if (userCap === 'reserve') {
        const used = await usage.providerUsage(userId).catch(() => {
          warn({ code: 'budget_read_failed' }, 'ai budget read failed');
          return null;
        });
        if (
          used &&
          !ordered.some((p) => !coolingUntil(p.id) && (used[p.id] ?? 0) < budgetOf(p.id))
        ) {
          throw new AIUnavailableError('exhausted');
        }
      }

      // 3. The user's cap, in its own committed transaction.
      if (userCap === 'reserve') {
        const { ok } = await usage.reserveUser(userId, purpose, config.userCaps[purpose]);
        if (!ok) throw new AIUserCapError(purpose);
      }

      // 4. The providers, one attempt each, in order.
      const deadline = startedAt + config.turnTimeoutMs;
      const attempts: { providerId: string; outcome: string }[] = [];
      const sentTo: string[] = [];
      let problem: { id: string; reason: SwitchReason } | null = null;
      for (const provider of ordered) {
        if (signal?.aborted) throw new AIAbortedError();
        const cd = coolingUntil(provider.id);
        if (cd) {
          attempts.push({ providerId: provider.id, outcome: 'cooldown' });
          problem = { id: provider.id, reason: cd.reason };
          continue;
        }
        const budget = budgetOf(provider.id);
        if (budget === 0) continue; // no budget set: this provider is off
        const remaining = deadline - now().getTime();
        if (remaining <= 0) {
          attempts.push({ providerId: provider.id, outcome: 'turn_timeout' });
          break;
        }

        // The budget is reserved and committed BEFORE the call. A failed call still counts.
        let reserved = false;
        try {
          reserved = await usage.reserveProvider(userId, provider.id, budget);
        } catch {
          warn(
            { providerId: provider.id, code: 'budget_reserve_failed' },
            'ai budget reserve failed',
          );
        }
        if (!reserved) {
          attempts.push({ providerId: provider.id, outcome: 'budget' });
          problem = { id: provider.id, reason: 'quota' };
          continue;
        }

        // When the turn deadline (not the provider's own timeout) is what limits this attempt,
        // its timeout ends the turn. Timers and the wall clock are separate clocks, so asking
        // the clock again could say a millisecond is left and start one more doomed attempt.
        const cappedByTurn = remaining <= config.timeoutMs;
        sentTo.push(provider.id);
        try {
          const response = await attempt(
            provider,
            request,
            Math.min(config.timeoutMs, remaining),
            signal,
          );
          const text = typeof response?.text === 'string' ? response.text.trim() : '';
          if (!text) throw new Error('empty');
          const reply = text.slice(0, MAX_REPLY_CHARS);
          if (cache && key && ttl) {
            await cache.put(userId, key, purpose, reply, ttl).catch(() => {
              warn({ code: 'cache_write_failed' }, 'ai cache write failed');
            });
          }
          return {
            text: reply,
            providerId: provider.id,
            label: provider.label,
            model: typeof response.model === 'string' ? response.model.slice(0, 100) : null,
            switched: problem
              ? { from: problem.id, to: provider.id, reason: problem.reason }
              : null,
            cached: false,
            sentTo,
          };
        } catch (error) {
          if (signal?.aborted) throw new AIAbortedError();
          const at = now();
          let reason: SwitchReason = 'error';
          let until = at.getTime() + UNAVAILABLE_COOLDOWN_MS;
          if (error instanceof ProviderQuotaError) {
            reason = 'quota';
            const retry = error.retryAfter?.getTime();
            // A stated retry-after is honoured, but never shorter than a few seconds (0 or 1
            // would make the cooldown pointless) and never longer than a day. Midnight UTC
            // only when the provider said nothing.
            until =
              retry !== undefined && Number.isFinite(retry)
                ? Math.min(
                    Math.max(retry, at.getTime() + MIN_RETRY_AFTER_MS),
                    at.getTime() + MAX_COOLDOWN_MS,
                  )
                : nextUtcMidnight(at).getTime();
          } else if (error instanceof TimedOut) {
            reason = 'timeout';
          }
          // A failure caused by this one request (a 400, say) says nothing about the provider,
          // and the cooldown is shared by every user: skip it and just try the next provider.
          const requestSpecific =
            error instanceof ProviderUnavailableError && error.requestSpecific;
          if (!requestSpecific) cooldowns.set(provider.id, { until, reason });
          // Ids and a code only: the error's own text can echo the request or a key.
          warn({ providerId: provider.id, reason }, 'ai provider failed');
          attempts.push({ providerId: provider.id, outcome: reason });
          problem = { id: provider.id, reason };
          if (cappedByTurn && error instanceof TimedOut) break;
        }
      }
      throw new AIUnavailableError('exhausted', attempts);
    },
  };
}
