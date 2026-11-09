import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { lengthProblems, tailorProblem } from './tailor-model';

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
  it('never claims nothing was sent for unknown failures', () => {
    for (const e of [ApiError.network(), ApiError.timeout(), http(500, 'internal')]) {
      expect(tailorProblem(e, ctx).message).not.toMatch(/nothing was sent/i);
      expect(tailorProblem(e, ctx).offer).toBe('retry');
    }
  });
  it('sends 422 and 400 back to the text', () => {
    expect(tailorProblem(http(422, 'pii_blocked'), ctx).offer).toBe('edit');
    expect(tailorProblem(http(400, 'validation_error'), ctx).offer).toBe('edit');
  });
});

describe('lengthProblems', () => {
  it('names each limit', () => {
    expect(lengthProblems('a'.repeat(300), 'b'.repeat(200))).toEqual([]);
    expect(lengthProblems('a'.repeat(6001), 'b'.repeat(3001))).toHaveLength(2);
    expect(lengthProblems('a', 'b')).toHaveLength(2);
  });
});
