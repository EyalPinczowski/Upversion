import { describe, expect, it } from 'vitest';
import { createApiClient, unwrap } from './client';
import { isApiError, retryAfterMs } from './errors';

describe('retryAfterMs', () => {
  it('reads whole seconds as milliseconds', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(' 5 ')).toBe(5000);
  });

  it.each([null, '', 'soon', '-3', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT'])(
    'gives null for %s',
    (value) => {
      expect(retryAfterMs(value)).toBeNull();
    },
  );

  it('is set on the error of a 503 answer', async () => {
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => null,
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'calendar_unavailable', message: 'x' } }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '45' },
        }),
    });
    const error = await unwrap(client.raw.POST('/api/v1/calendar/sync', { body: null })).catch(
      (e: unknown) => e,
    );
    expect(isApiError(error) && error.retryAfterMs).toBe(45_000);
  });
});
