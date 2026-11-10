import {
  MAX_CV_TAILOR_CV,
  MAX_CV_TAILOR_JOB,
  MIN_CV_TAILOR_CV,
  MIN_CV_TAILOR_JOB,
  type PiiKind,
} from '@upversion/shared';
import type { AiUsage } from '../../api/ai-hooks';
import { isApiError } from '../../api/errors';

export const CHECK_LINE =
  'Check every line. Only keep what is true. You may be asked about any of it in an interview.';
export const PLACEHOLDER = '[number?]';
export const CONFIRM_LABEL = 'I checked the text and removed my name and address';

export function countPlaceholders(text: string): number {
  return text.split(PLACEHOLDER).length - 1;
}

export const NAME_WARNING =
  'Remove your name, home address and anyone else’s name before sending. The app removes emails, phone numbers and links, but it cannot recognise names or addresses.';

const PII_TEXT: Record<PiiKind, string> = {
  email: 'An email address is still in the text.',
  url: 'A link or web address is still in the text.',
  handle: 'A social media handle is still in the text.',
  phone: 'A phone number or long number is still in the text.',
  identifier: 'Your name or email from your account is still in the text.',
};

export function piiMessages(kinds: readonly PiiKind[]): string[] {
  return kinds.map((k) => PII_TEXT[k]);
}

/** Why the text cannot be sent yet, in words. Empty when the lengths are fine. */
export function lengthProblems(cv: string, job: string): string[] {
  const out: string[] = [];
  const c = cv.trim().length;
  const j = job.trim().length;
  if (c < MIN_CV_TAILOR_CV) out.push(`The CV text needs at least ${MIN_CV_TAILOR_CV} characters.`);
  if (c > MAX_CV_TAILOR_CV)
    out.push(`The CV text is over the ${MAX_CV_TAILOR_CV.toLocaleString('en')} character limit.`);
  if (j < MIN_CV_TAILOR_JOB)
    out.push(`The job post needs at least ${MIN_CV_TAILOR_JOB} characters.`);
  if (j > MAX_CV_TAILOR_JOB)
    out.push(`The job post is over the ${MAX_CV_TAILOR_JOB.toLocaleString('en')} character limit.`);
  return out;
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
}

const WANTED = [
  { id: 'cloudflare-ai', fallback: 'Cloudflare Workers AI' },
  { id: 'groq', fallback: 'Groq' },
] as const;

/** The two providers that may receive the text, in gateway order, with the server's labels. */
export function tailorProviders(usage: AiUsage): ProviderInfo[] {
  return WANTED.map((w) => {
    const p = usage.providers.find((x) => x.id === w.id);
    return { id: w.id, label: p?.label ?? w.fallback, available: p?.available === true };
  });
}

/** Providers that may receive the text right now, in the order the gateway tries them. */
export function recipients(usage: AiUsage): ProviderInfo[] {
  return usage.configured ? tailorProviders(usage).filter((p) => p.available) : [];
}

export function aiAvailable(usage: AiUsage): boolean {
  return recipients(usage).length > 0;
}

/** Each provider's own page on how it handles the data (docs/setup/ai-providers.md, verified). */
export const PROVIDER_DATA_PAGE: Record<string, string> = {
  'cloudflare-ai': 'https://developers.cloudflare.com/workers-ai/platform/data-usage/',
  groq: 'https://console.groq.com/docs/your-data',
};

/** What the person can do next after a failure (ADR 016 section 6). */
export type Offer = 'list' | 'retry';
export interface TailorProblem {
  message: string;
  /**
   * `list`: back to the keyword list and copy it; `retry`: send again (or check the count first).
   * Copy prompt is a button the preview always has, so it is named in messages, not offered here.
   */
  offers: readonly Offer[];
}

/** "Your text may have reached A, and B if A failed", from the providers that can receive it. */
function mayHaveReached(receivers: readonly string[] = []): string {
  const [first, second] = receivers;
  if (!first) return 'Your text may have reached an AI provider';
  return `Your text may have reached ${first}${second ? `, and ${second} if ${first} failed` : ''}`;
}

const CANT_TELL =
  'We did not get an answer, so we can’t tell whether your text reached an AI provider. Check today’s count before trying again.';

/**
 * Plain-text message for a failed tailoring call (ADR 016 section 6). `countRose` says whether
 * today's run count went up during the request (it does only when a provider was attempted), or
 * `null` when the count could not be read afterwards: then nothing is claimed about what was sent.
 */
export function tailorProblem(
  error: unknown,
  ctx: {
    countRose: boolean | null;
    cap: number;
    used?: number;
    resetsAt?: string;
    /** Labels of the providers that may have received the text, in gateway order. */
    receivers?: readonly string[];
  },
): TailorProblem {
  if (isApiError(error) && error.kind === 'http') {
    const { status, code } = error;
    if (status === 404)
      return {
        message:
          'Tailoring is switched off on the server right now. Your keyword list still works.',
        offers: ['list'],
      };
    if (status === 422 && code === 'pii_blocked')
      return {
        message: 'The server found personal details in the text. Remove them and send again.',
        offers: [],
      };
    if (status === 422 && code === 'too_long')
      return { message: 'The text is too long.', offers: [] };
    if (status === 422)
      return {
        message:
          'The text has a character the server cannot accept. Remove unusual characters and send again.',
        offers: [],
      };
    if (status === 400)
      return { message: 'Something in the request was not accepted.', offers: [] };
    const d = ctx.resetsAt ? new Date(ctx.resetsAt) : null;
    const time =
      d && !Number.isNaN(d.getTime())
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'midnight UTC';
    const capProblem = (): TailorProblem => {
      return {
        message: `You used today’s ${ctx.cap} tailoring runs. They reset at ${time}. Your keyword list and Copy prompt still work.`,
        offers: ['list'],
      };
    };
    if (status === 429 && code === 'ai_user_cap') return capProblem();
    if (status === 429 && code === 'ai_feature_cap')
      return {
        message: `Tailoring has reached its daily limit for everyone using the app. It resets at ${time}, so try again after that. Your keyword list and Copy prompt still work.`,
        offers: ['list'],
      };
    if (status === 429)
      return { message: 'Too many requests right now. Try again in a minute.', offers: ['retry'] };
    if (status === 503 && code === 'ai_unavailable') {
      // The count can only have risen if a provider was attempted: that always wins.
      if (ctx.countRose === null) return { message: CANT_TELL, offers: ['retry', 'list'] };
      if (ctx.countRose)
        return {
          message: `The AI did not answer. ${mayHaveReached(ctx.receivers)}, and this run counted. Your keyword list still works.`,
          offers: ['list'],
        };
      // The server answers 503 (not 429) to a user at the cap whose turn deadline has passed.
      if (ctx.used !== undefined && ctx.used >= ctx.cap) return capProblem();
      return {
        message: 'AI is not available right now. Your keyword list still works.',
        offers: ['list'],
      };
    }
  }
  return { message: CANT_TELL, offers: ['retry', 'list'] };
}
