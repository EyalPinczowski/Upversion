import { assertNoPii, findCvPii, PiiLeakError, redactCvPii, redactPii } from '@upversion/shared';
import { z } from 'zod';
import { AI_PURPOSES } from './provider';

declare const safeBrand: unique symbol;

export interface SafeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * A request that may be sent to a model. The brand means it can only come from
 * `buildSafeRequest`: every string was redacted and then checked, so a caller cannot hand the
 * gateway raw text (the type stops it, and the gateway checks again at run time).
 */
export interface SafeAIRequest {
  readonly [safeBrand]: true;
  readonly purpose: (typeof AI_PURPOSES)[number];
  readonly system: string;
  readonly messages: readonly SafeMessage[];
  readonly maxOutputTokens: number;
  readonly json: boolean;
}

const MAX_TEXT = 20_000;
const partsSchema = z.strictObject({
  purpose: z.enum(AI_PURPOSES),
  system: z.string().max(MAX_TEXT),
  messages: z
    .array(
      z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_TEXT) }),
    )
    .min(1)
    .max(60),
  maxOutputTokens: z.number().int().min(1).max(2000),
  json: z.boolean(),
});

export type SafeAIRequestParts = z.input<typeof partsSchema>;

const issued = new WeakSet<object>();

/** True only for objects made by `buildSafeRequest` in this process. */
export function isSafeAIRequest(value: unknown): value is SafeAIRequest {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/**
 * Redacts every string with the user's known identifiers, then runs the final check on the
 * result. Throws `PiiLeakError` (from `@upversion/shared`) when anything personal survives;
 * callers answer 422 `pii_blocked` and make no model call. Fails closed.
 */
export function buildSafeRequest(
  parts: SafeAIRequestParts,
  knownIdentifiers: readonly string[],
  settings: {
    /**
     * Treat catalog tool names that look like hosts (`ASP.NET`, `monday.com`) as plain text, the
     * same allowance `findCvPii` gives CV text before it reaches this function (ADR 016). Without
     * it the redaction would silently change text the user was told is sent as written.
     */
    allowToolNames?: boolean;
  } = {},
): SafeAIRequest {
  const parsed = partsSchema.parse(parts);
  const options = { knownIdentifiers };
  const clean = (text: string): string => {
    if (settings.allowToolNames === true) {
      const redacted = redactCvPii(text, options).text;
      const kinds = findCvPii(redacted, options);
      if (kinds.length > 0) throw new PiiLeakError(kinds);
      return redacted;
    }
    const redacted = redactPii(text, options).text;
    assertNoPii(redacted, options);
    return redacted;
  };
  const request = Object.freeze({
    purpose: parsed.purpose,
    system: clean(parsed.system),
    messages: Object.freeze(
      parsed.messages.map((m) => Object.freeze({ role: m.role, content: clean(m.content) })),
    ),
    maxOutputTokens: parsed.maxOutputTokens,
    json: parsed.json,
  }) as unknown as SafeAIRequest;
  issued.add(request);
  return request;
}

export const HISTORY_OMITTED_NOTE = '[Earlier turns omitted.]';

/**
 * Keeps the newest turns that fit in `maxChars` (always at least the last one) and puts a
 * one-line note in front of the oldest kept turn when older turns were dropped. Pure.
 */
export function truncateHistory(messages: readonly SafeMessage[], maxChars: number): SafeMessage[] {
  const kept: SafeMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (kept.length > 0 && used + m.content.length > maxChars) break;
    kept.unshift(m);
    used += m.content.length;
  }
  if (kept.length === messages.length) return kept;
  const first = kept[0]!;
  return [
    { role: first.role, content: `${HISTORY_OMITTED_NOTE}\n${first.content}` },
    ...kept.slice(1),
  ];
}
