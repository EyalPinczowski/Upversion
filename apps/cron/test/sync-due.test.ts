import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { endpointUrl, runSyncDue, SyncDueError } from '../src/sync-due';

const SECRET = 'cron-secret-0123456789-abcdefghijklmnop-XYZ';
const BASE = 'https://rnd-api.example.test';
const env = { API_BASE_URL: BASE, CALENDAR_CRON_SECRET: SECRET };
const ok = (body: object = { due: 3, synced: 2, cached: 0, failed: 1, skipped: 0 }) =>
  new Response(JSON.stringify(body), { status: 200 });

function setup(responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const logs: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    logs,
    sleeps,
    options: {
      fetch: fetchMock as unknown as typeof fetch,
      log: (entry: Record<string, unknown>) => logs.push(entry),
      sleep: async (ms: number) => void sleeps.push(ms),
      retryDelayMs: 7,
    },
  };
}

describe('runSyncDue', () => {
  it('POSTs to the endpoint with the bearer secret, and logs the status and counts only', async () => {
    const s = setup([ok()]);
    await runSyncDue(env, s.options);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}/api/v1/internal/calendar/sync-due`);
    expect(s.calls[0]!.init.method).toBe('POST');
    expect(s.calls[0]!.init.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    expect(s.calls[0]!.init.body).toBeUndefined();
    expect(s.logs).toEqual([
      {
        event: 'calendar_sync_due',
        attempt: 1,
        status: 200,
        due: 3,
        synced: 2,
        cached: 0,
        failed: 1,
        skipped: 0,
      },
    ]);
  });

  it('keeps only the five counts from the response, never other fields', async () => {
    const s = setup([
      ok({ due: 1, synced: 1, cached: 0, failed: 0, skipped: 0, userId: 'u-1', x: 'secret' }),
    ]);
    await runSyncDue(env, s.options);
    expect(JSON.stringify(s.logs)).not.toContain('u-1');
    expect(JSON.stringify(s.logs)).not.toContain('secret');
  });

  it('normalises a trailing slash and a path in the base URL', async () => {
    const s = setup([ok()]);
    await runSyncDue({ ...env, API_BASE_URL: `${BASE}/` }, s.options);
    expect(s.calls[0]!.url).toBe(`${BASE}/api/v1/internal/calendar/sync-due`);
  });

  it.each([502, 503])('retries once after a %i, then succeeds', async (status) => {
    const s = setup([new Response('bad gateway', { status }), ok()]);
    await runSyncDue(env, s.options);
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps).toEqual([7]);
  });

  it('retries once after a network failure', async () => {
    const s = setup([new TypeError('fetch failed: rnd-api.example.test'), ok()]);
    await runSyncDue(env, s.options);
    expect(s.calls).toHaveLength(2);
    // The error name is logged, not its message (which can contain the host).
    expect(s.logs[0]).toMatchObject({ attempt: 1, status: null, error: 'TypeError' });
    expect(JSON.stringify(s.logs)).not.toContain('example.test');
  });

  it('gives up after one retry and fails the run', async () => {
    const s = setup([new Response('', { status: 503 }), new Response('', { status: 503 })]);
    await expect(runSyncDue(env, s.options)).rejects.toBeInstanceOf(SyncDueError);
    expect(s.calls).toHaveLength(2);
  });

  it.each([401, 400, 404, 429, 500])('does not retry a %i, and fails the run', async (status) => {
    const s = setup([new Response('nope', { status })]);
    await expect(runSyncDue(env, s.options)).rejects.toBeInstanceOf(SyncDueError);
    expect(s.calls).toHaveLength(1);
  });

  it('treats 409 already_running as fine', async () => {
    const s = setup([new Response('{"error":{"code":"already_running"}}', { status: 409 })]);
    await expect(runSyncDue(env, s.options)).resolves.toBeUndefined();
    expect(s.calls).toHaveLength(1);
  });

  it('never puts the secret or the URL in logs or errors', async () => {
    const s = setup([new Response(`echo ${SECRET}`, { status: 401 })]);
    const error = await runSyncDue(env, s.options).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SyncDueError);
    const everything = `${JSON.stringify(s.logs)} ${(error as Error).message}`;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(BASE);
  });

  it('passes a generous timeout signal to fetch', async () => {
    const s = setup([ok()]);
    await runSyncDue(env, s.options);
    expect(s.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [{ CALENDAR_CRON_SECRET: SECRET }],
    [{ API_BASE_URL: BASE }],
    [{ API_BASE_URL: 'http://insecure.example.test', CALENDAR_CRON_SECRET: SECRET }],
    [{ API_BASE_URL: 'not a url', CALENDAR_CRON_SECRET: SECRET }],
  ])('refuses to call anything when misconfigured: %j', async (bad) => {
    const s = setup([]);
    await expect(runSyncDue(bad, s.options)).rejects.toBeInstanceOf(SyncDueError);
    expect(s.calls).toHaveLength(0);
    expect(JSON.stringify(s.logs)).not.toContain(SECRET);
  });
});

describe('endpointUrl', () => {
  it('needs an https origin', () => {
    expect(endpointUrl(undefined)).toBeNull();
    expect(endpointUrl('http://a.test')).toBeNull();
    expect(endpointUrl('https://a.test/x')).toBe(
      'https://a.test/api/v1/internal/calendar/sync-due',
    );
  });
});

describe('scheduled handler', () => {
  it('hands the run to ctx.waitUntil', async () => {
    const waited: Promise<unknown>[] = [];
    const original = globalThis.fetch;
    const fetchMock = vi.fn(async () => ok());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: 0 }, env, {
        waitUntil: (p) => void waited.push(p),
      });
      expect(waited).toHaveLength(1);
      await Promise.all(waited);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.join()).not.toContain(SECRET);
    } finally {
      globalThis.fetch = original;
      log.mockRestore();
    }
  });
});
