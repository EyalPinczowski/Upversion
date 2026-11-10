import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { AiUsage } from '../../api/ai-hooks';
import { aiAvailable, lengthProblems, recipients, tailorProblem } from './tailor-model';

const http = (status: number, code: string) =>
  ApiError.fromBody(status, { error: { code, message: 'm' } });
const ctx = { countRose: false, cap: 3 };

describe('tailorProblem', () => {
  it('tells a counted 503 from an uncounted one', () => {
    expect(tailorProblem(http(503, 'ai_unavailable'), ctx).message).toMatch(
      /not available right now/,
    );
    expect(tailorProblem(http(503, 'ai_unavailable'), { ...ctx, countRose: true }).message).toMatch(
      /may have reached Cloudflare/,
    );
  });
  it('a counted 503 is never the cap message, even when used has reached the cap', () => {
    const e = http(503, 'ai_unavailable');
    const m = tailorProblem(e, { ...ctx, countRose: true, used: 3 }).message;
    expect(m).toMatch(/may have reached Cloudflare/);
    expect(m).not.toMatch(/You used today/);
  });
  it('an unreadable count claims nothing: not "nothing sent", not "not available"', () => {
    const p = tailorProblem(http(503, 'ai_unavailable'), { ...ctx, countRose: null, used: 3 });
    expect(p.message).toMatch(/can’t tell whether your text reached an AI provider/);
    expect(p.message).not.toMatch(/not available right now|nothing was sent|You used today/i);
    expect(p.offers).toContain('retry');
  });
  it('has specific messages for a flag-off 404 and an unprocessable 422', () => {
    expect(tailorProblem(http(404, 'not_found'), ctx).message).toMatch(/switched off/);
    expect(tailorProblem(http(422, 'unprocessable'), ctx).message).toMatch(/character/);
  });
  it('offers the keyword list and Copy prompt when AI cannot help', () => {
    expect(tailorProblem(http(503, 'ai_unavailable'), ctx).offers).toEqual(['list', 'prompt']);
    expect(tailorProblem(http(429, 'ai_user_cap'), ctx).offers).toEqual(['list', 'prompt']);
    expect(tailorProblem(http(429, 'rate_limited'), ctx).offers).toEqual(['retry']);
  });
  it('treats a 503 for a user already at the cap as the cap message', () => {
    expect(tailorProblem(http(503, 'ai_unavailable'), { ...ctx, used: 3 }).message).toMatch(
      /You used today’s 3 tailoring runs/,
    );
    expect(tailorProblem(http(503, 'ai_unavailable'), { ...ctx, used: 2 }).message).toMatch(
      /not available right now/,
    );
  });
  it('never claims nothing was sent for unknown failures', () => {
    for (const e of [ApiError.network(), ApiError.timeout(), http(500, 'internal')]) {
      expect(tailorProblem(e, ctx).message).not.toMatch(/nothing was sent/i);
      expect(tailorProblem(e, ctx).offers).toContain('retry');
    }
  });
  it('sends 422 and 400 back to the text', () => {
    expect(tailorProblem(http(422, 'pii_blocked'), ctx).offers).toEqual([]);
    expect(tailorProblem(http(400, 'validation_error'), ctx).offers).toEqual([]);
  });
});

describe('lengthProblems', () => {
  it('names each limit', () => {
    expect(lengthProblems('a'.repeat(300), 'b'.repeat(200))).toEqual([]);
    expect(lengthProblems('a'.repeat(6001), 'b'.repeat(3001))).toHaveLength(2);
    expect(lengthProblems('a', 'b')).toHaveLength(2);
  });
});

describe('recipients', () => {
  const usage = (cf: boolean, groq: boolean, configured = true) =>
    ({
      configured,
      providers: [
        { id: 'groq', label: 'Groq', available: groq },
        { id: 'cloudflare-ai', label: 'Cloudflare Workers AI', available: cf },
      ],
    }) as unknown as AiUsage;
  it('lists only available providers, in gateway order', () => {
    expect(recipients(usage(true, true)).map((p) => p.id)).toEqual(['cloudflare-ai', 'groq']);
    expect(recipients(usage(false, true)).map((p) => p.id)).toEqual(['groq']);
    expect(recipients(usage(false, false))).toEqual([]);
    expect(aiAvailable(usage(true, true, false))).toBe(false);
  });
});
