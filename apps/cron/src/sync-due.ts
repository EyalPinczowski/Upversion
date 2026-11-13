/**
 * Calls the API's scheduled-sync endpoint (docs/calendar-cron.md). Dependency-free on purpose.
 * Logs carry the HTTP status and the counts only: never the secret, the URL or the response body.
 */

export interface CronEnv {
  /** Origin of the API, no trailing slash needed. A plain variable, not a secret. */
  API_BASE_URL?: string;
  /** Worker secret; at least 32 characters. Never logged. */
  CALENDAR_CRON_SECRET?: string;
}

export interface SyncDueOptions {
  fetch?: typeof fetch;
  /** One attempt may take this long: the free API can need about a minute to wake up. */
  timeoutMs?: number;
  /** Pause before the single retry. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

export const ENDPOINT_PATH = '/api/v1/internal/calendar/sync-due';
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_RETRY_DELAY_MS = 5_000;
const COUNT_KEYS = ['due', 'synced', 'cached', 'failed', 'skipped'] as const;
const RETRY_STATUSES = new Set([429, 502, 503]);

/** Thrown for a run that did not work, so the cron event shows as failed. Carries no secret. */
export class SyncDueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncDueError';
  }
}

export function endpointUrl(base: string | undefined): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:') return null;
    return `${url.origin}${ENDPOINT_PATH}`;
  } catch {
    return null;
  }
}

/** Only the five integer counts, whatever else the body holds. */
function countsOf(text: string): Record<string, number> {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const key of COUNT_KEYS) {
      const value = body[key];
      if (typeof value === 'number' && Number.isInteger(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function runSyncDue(env: CronEnv, options: SyncDueOptions = {}): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));

  const url = endpointUrl(env.API_BASE_URL);
  const secret = env.CALENDAR_CRON_SECRET;
  if (!url || !secret) {
    log({ event: 'calendar_sync_due', outcome: 'misconfigured' });
    throw new SyncDueError('API_BASE_URL (https) and CALENDAR_CRON_SECRET must be set.');
  }

  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let status: number | null = null;
    let text = '';
    let errorName: string | null = null;
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // The name only: a network error message can contain the host.
      errorName = error instanceof Error ? error.name : 'Error';
    }
    lastStatus = status;
    log({
      event: 'calendar_sync_due',
      attempt,
      status,
      ...(errorName ? { error: errorName } : {}),
      ...(status === 200 ? countsOf(text) : {}),
    });
    // 409 already_running: the previous run is still going, nothing to do.
    if (status === 200 || status === 409) return;
    const retryable = status === null || RETRY_STATUSES.has(status);
    if (!retryable || attempt === 2) break;
    await sleep(retryDelayMs);
  }
  throw new SyncDueError(`Scheduled sync failed (status ${lastStatus ?? 'network error'}).`);
}
