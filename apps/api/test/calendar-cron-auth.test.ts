import type * as NodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// The secret check must use crypto.timingSafeEqual on equal-length digests, never `===`.
const compared: [number, number][] = [];
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>();
  return {
    ...original,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.push([a.byteLength, b.byteLength]);
      return original.timingSafeEqual(a, b);
    },
  };
});

const { bearerToken, secretsMatch } = await import('../src/modules/calendar/cron');

describe('secretsMatch', () => {
  const secret = 'a-very-long-cron-secret-0123456789-abcdef';

  it('compares with timingSafeEqual on equal-length digests, whatever the input lengths', () => {
    compared.length = 0;
    expect(secretsMatch(secret, secret)).toBe(true);
    expect(secretsMatch('x', secret)).toBe(false);
    expect(secretsMatch(`${secret}${secret}`, secret)).toBe(false);
    expect(secretsMatch('', secret)).toBe(false);
    expect(compared).toHaveLength(4);
    for (const [a, b] of compared) {
      expect(a).toBe(32);
      expect(b).toBe(32);
    }
  });
});

describe('bearerToken', () => {
  it('reads a Bearer header and nothing else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
