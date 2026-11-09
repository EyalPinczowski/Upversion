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

export function aiAvailable(usage: AiUsage): boolean {
  return usage.configured && tailorProviders(usage).some((p) => p.available);
}

export type ErrorOffer = 'retry' | 'list' | 'edit';
export interface TailorProblem {
  message: string;
  offer: ErrorOffer;
}

/**
 * Plain-text message for a failed tailoring call (ADR 016 section 6). `countRose` says whether
 * today's run count went up during the request: it does only when a provider was attempted.
 */
export function tailorProblem(
  error: unknown,
  ctx: { countRose: boolean; cap: number; resetsAt?: string },
): TailorProblem {
  if (isApiError(error) && error.kind === 'http') {
    const { status, code } = error;
    if (status === 422 && code === 'pii_blocked')
      return {
        message: 'The server found personal details in the text. Remove them and send again.',
        offer: 'edit',
      };
    if (status === 422 && code === 'too_long')
      return { message: 'The text is too long.', offer: 'edit' };
    if (status === 400)
      return { message: 'Something in the request was not accepted.', offer: 'edit' };
    if (status === 429 && code === 'ai_user_cap') {
      const d = ctx.resetsAt ? new Date(ctx.resetsAt) : null;
      const time =
        d && !Number.isNaN(d.getTime())
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'midnight UTC';
      return {
        message: `You used today’s ${ctx.cap} tailoring runs. They reset at ${time}. Your keyword list and Copy prompt still work.`,
        offer: 'list',
      };
    }
    if (status === 429)
      return { message: 'Too many requests right now. Try again in a minute.', offer: 'retry' };
    if (status === 503 && code === 'ai_unavailable') {
      return ctx.countRose
        ? {
            message:
              'The AI did not answer. Your text may have reached Cloudflare, and Groq if Cloudflare failed, and this run counted. Your keyword list still works.',
            offer: 'list',
          }
        : {
            message: 'AI is not available right now. Your keyword list still works.',
            offer: 'list',
          };
    }
  }
  return {
    message:
      'We did not get an answer, so we can’t tell whether your text reached an AI provider. Check today’s count before trying again.',
    offer: 'retry',
  };
}
