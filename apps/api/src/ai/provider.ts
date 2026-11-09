/**
 * The AIProvider seam (spec 12.3, ADR 004 and 012) and the shared AI types.
 *
 * A provider is one file that turns a `SafeAIRequest` (already redacted, see `safe-request.ts`)
 * into text. It never decides budgets, fallbacks or caching; the gateway does (`gateway.ts`).
 *
 * Rules for every provider implementation:
 * - plain `fetch` with the `signal` it is given, no SDK;
 * - the key goes in a header, never in a URL, a log line or an error message;
 * - on failure throw `ProviderQuotaError` (the provider's limit was reached) or
 *   `ProviderUnavailableError` (anything else). Never put the provider's own error text in
 *   either: it can echo the request, the key or the account.
 */
import type { SafeAIRequest } from './safe-request';

/** `paid` providers are refused unless the owner enables them explicitly (spec 12.2). */
export type CostTier = 'free' | 'paid';

/** What a model call is for. The same values are allowed by `ai_usage_daily` (migration 0017). */
export const AI_PURPOSES = [
  'practice_message',
  'practice_feedback',
  'day_overview',
  'cv_tailor',
] as const;
export type AIPurpose = (typeof AI_PURPOSES)[number];

export interface AIResponse {
  text: string;
  /** The model that answered, as the provider reports it. */
  model?: string;
  /** What the provider said about its own limits, when it said anything. */
  rateLimit?: { remainingRequests?: number; resetAt?: Date };
}

export interface AIProvider {
  /** A stable lower-case slug such as `groq`. */
  readonly id: string;
  /** Shown on the switch notice and the usage meter. */
  readonly label: string;
  readonly costTier: CostTier;
  /** Used to truncate the conversation history before a request is built. */
  readonly maxContextChars: number;
  /** Must honour `opts.signal`. The gateway also stops waiting when it fires. */
  generate(request: SafeAIRequest, opts: { signal: AbortSignal }): Promise<AIResponse>;
}

/** The provider's quota is used up (HTTP 429 or its own quota signal). */
export class ProviderQuotaError extends Error {
  constructor(public readonly retryAfter?: Date) {
    super('AI provider quota reached.');
    this.name = 'ProviderQuotaError';
  }
}

/** The provider failed in any other way: 5xx, network, timeout, malformed body. */
export class ProviderUnavailableError extends Error {
  /**
   * `requestSpecific` is true when this one request caused the failure (a 400 or other 4xx except
   * 429, 401, 403 and 404, which are provider-wide), so the provider itself is fine. The gateway then tries the next provider but sets no
   * cooldown, because a cooldown is shared by every user. Leave false for 5xx and network errors.
   */
  constructor(public readonly requestSpecific = false) {
    super('AI provider unavailable.');
    this.name = 'ProviderUnavailableError';
  }
}

/** The settings the guard reads. Everything is off unless switched on. */
export interface AISettings {
  /** Lets `paid` providers register and run. Default false. */
  allowPaid: boolean;
}

export const DEFAULT_AI_SETTINGS: AISettings = { allowPaid: false };

export class PaidProviderRefusedError extends Error {
  constructor(public readonly providerId: string) {
    super(
      `AI provider "${providerId}" is not free (or does not declare a cost tier) and paid providers are disabled.`,
    );
    this.name = 'PaidProviderRefusedError';
  }
}

/**
 * Throws unless the provider may be used under `settings`. Fails closed: anything that is not
 * exactly `free` counts as paid, so a provider that forgets to declare its tier is refused.
 */
export function assertProviderAllowed(
  provider: Pick<AIProvider, 'id' | 'costTier'>,
  settings: AISettings,
): void {
  if (provider.costTier === 'free') return;
  if (provider.costTier === 'paid' && settings.allowPaid === true) return;
  throw new PaidProviderRefusedError(provider.id);
}
