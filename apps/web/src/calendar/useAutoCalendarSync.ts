import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  applyCalendarSync,
  calendarKey,
  calendarSyncKey,
  requestCalendarSync,
  useCalendarStatus,
} from '../api/calendar-hooks';
import { useApi } from '../api/context';
import { isApiError } from '../api/errors';
import { currentSyncEpoch, resetCalendarSyncState, useAutoSyncEnabled } from './auto-sync-state';

/** Coming back to the tab syncs when the last attempt is older than this. */
export const STALE_AFTER_MS = 2 * 60 * 1000;
/** The server answers `cached` for 5 minutes after a sync ENDED, so the next call is due later. */
export const INTERVAL_MS = 5 * 60 * 1000;
/** Added on top of the interval so the server's cache has surely expired. */
export const MARGIN_MS = 20_000;
/** Waits when a sync is already running (409) or Google cannot be reached without a Retry-After. */
export const BUSY_RETRY_MS = 30_000;
export const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;
/** Failed tries in a row that are retried by timer; later ones wait for the next trigger. */
export const MAX_TRIES = 3;
/** A hard ceiling on automatic calls per tab, whatever the triggers do. */
export const MAX_CALLS_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;
const MIN_TICK_MS = 30_000;

type Reason = 'open' | 'visible' | 'tick' | 'retry';

/**
 * Keeps the calendar up to date while Upversion is open (there is no server scheduler on the free
 * plan). Runs a plain, non-forced sync: when the app opens, when the tab comes back and the last
 * attempt is over two minutes old, and then about 5 minutes after the last sync ended (plus a
 * small margin, so the server's cache has expired). Never while the tab is hidden, never two at
 * once, never before `notBefore` (set by backoff and Retry-After, respected by every trigger) and
 * at most 12 calls an hour. Failures are quiet, except that a rejected connection stops it and
 * shows the reconnect prompt (the status refetch does that). Mount it once for the signed-in app.
 *
 * Known limits: each browser tab runs its own copy (no cross-tab coordination), and a setting
 * changed in another tab is not picked up until that tab reloads.
 */
export function useAutoCalendarSync(userId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const status = useCalendarStatus();
  const [enabled] = useAutoSyncEnabled(userId);
  const active = status.data?.status === 'connected' && enabled;

  useEffect(() => {
    if (!active) return;

    const epoch = currentSyncEpoch();
    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let lastAttempt: number | null = null;
    // Failed tries in a row; only a success resets it.
    let tries = 0;
    // No trigger of any kind may call before this time.
    let notBefore = 0;
    let calls: number[] = [];
    // A scheduled run came due while the tab was hidden: run it as soon as the tab is visible.
    let due = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const visible = () => document.visibilityState === 'visible';

    /** The one scheduled next run (replaces any earlier one). */
    const arm = (delayMs: number, reason: Reason) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(reason), Math.max(0, delayMs));
    };
    const armNormal = (from: number) => arm(Math.max(MIN_TICK_MS, from), 'tick');

    async function run(reason: Reason) {
      if (cancelled || stopped || inFlight) return;
      if (!visible()) {
        if (reason === 'tick' || reason === 'retry') due = true;
        return;
      }
      const now = Date.now();
      // A manual "Sync now" is running: it covers this one.
      if (queryClient.isMutating({ mutationKey: calendarSyncKey }) > 0) {
        if (reason === 'tick' || reason === 'retry' || due) arm(BUSY_RETRY_MS, 'tick');
        return;
      }
      calls = calls.filter((at) => now - at < HOUR_MS);
      const capWait = calls.length >= MAX_CALLS_PER_HOUR ? calls[0]! + HOUR_MS - now : 0;
      const wait = Math.max(notBefore - now, capWait);
      if (wait > 0) {
        // Not yet: make sure a scheduled run exists for when it is allowed.
        if (reason === 'tick' || reason === 'retry' || due) arm(wait, 'tick');
        return;
      }
      inFlight = true;
      due = false;
      lastAttempt = now;
      calls.push(now);
      try {
        const result = await requestCalendarSync(api, false);
        if (cancelled) return;
        tries = 0;
        notBefore = 0;
        applyCalendarSync(queryClient, result, epoch);
        // The server stamps the sync when it ENDS: ask again 5 minutes (+ margin) after that.
        const syncedAt = result.syncedAt ? Date.parse(result.syncedAt) : NaN;
        const base = Number.isNaN(syncedAt) ? Date.now() : Math.min(syncedAt, Date.now());
        armNormal(base + INTERVAL_MS + MARGIN_MS - Date.now());
      } catch (error) {
        if (cancelled) return;
        tries += 1;
        const failedAt = Date.now();
        if (isApiError(error) && error.kind === 'http') {
          if (error.status === 409 && error.code === 'sync_in_progress') {
            notBefore = failedAt + BUSY_RETRY_MS;
          } else if (error.status === 503) {
            notBefore = failedAt + Math.min(MAX_RETRY_WAIT_MS, error.retryAfterMs ?? BUSY_RETRY_MS);
          } else if (
            error.status === 409 &&
            (error.code === 'calendar_reconnect_required' ||
              error.code === 'calendar_not_connected')
          ) {
            // Stop for good; the refreshed status shows the reconnect prompt.
            stopped = true;
            clearTimeout(timer);
            void queryClient.invalidateQueries({ queryKey: calendarKey });
            return;
          }
        }
        if (notBefore > failedAt && tries < MAX_TRIES) arm(notBefore - failedAt, 'retry');
        else armNormal(Math.max(INTERVAL_MS + MARGIN_MS, notBefore - failedAt));
      } finally {
        inFlight = false;
      }
    }

    const onVisible = () => {
      if (!visible()) return;
      if (due || lastAttempt === null || Date.now() - lastAttempt > STALE_AFTER_MS) {
        void run('visible');
      }
    };

    // When the app opens (or the setting is switched on / the calendar gets connected).
    void run('open');
    // Back to the tab.
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [active, userId, queryClient, api]);

  // Nothing carries over to the next person: forget the update time and drop answers in flight.
  useEffect(() => () => resetCalendarSyncState(), [userId]);
}
