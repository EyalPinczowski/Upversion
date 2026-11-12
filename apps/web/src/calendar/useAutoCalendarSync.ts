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
import { recordCalendarUpdate, useAutoSyncEnabled } from './auto-sync-state';

/** Coming back to the tab syncs when the last sync is older than this. */
export const STALE_AFTER_MS = 2 * 60 * 1000;
/** Matches the server's five-minute cache, so a non-forced call then really reaches Google. */
export const INTERVAL_MS = 5 * 60 * 1000;
export const DEBOUNCE_MS = 3000;
/** Waits when a sync is already running (409) or Google cannot be reached without a Retry-After. */
export const BUSY_RETRY_MS = 30_000;
export const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;
export const MAX_TRIES = 3;

/**
 * Keeps the calendar up to date while Upversion is open (there is no server scheduler on the free
 * plan). Runs a plain, non-forced sync: when the app opens, when the tab comes back after the last
 * sync is over two minutes old, every five minutes while visible, and about three seconds after a
 * change that moves planned blocks. Never while the tab is hidden, never two at once. Failures
 * are quiet, except that a rejected connection stops it and shows the reconnect prompt (the
 * status refetch does that). Mount it once for the signed-in app.
 */
export function useAutoCalendarSync(userId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const status = useCalendarStatus();
  const [enabled] = useAutoSyncEnabled(userId);
  const active = status.data?.status === 'connected' && enabled;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let lastSuccess: number | null = null;
    // A plan change arrived while the tab was hidden: look again as soon as it is visible.
    let dirty = false;
    let tries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const visible = () => document.visibilityState === 'visible';

    const schedule = (waitMs: number) => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void run(false), waitMs);
    };

    /** `fresh`: started by a trigger, so earlier failed tries no longer count. */
    async function run(fresh: boolean) {
      if (cancelled || stopped || inFlight) return;
      if (!visible()) return;
      // A manual "Sync now" is running: it covers this one.
      if (queryClient.isMutating({ mutationKey: calendarSyncKey }) > 0) return;
      if (fresh) {
        tries = 0;
        clearTimeout(retryTimer);
      }
      inFlight = true;
      dirty = false;
      tries += 1;
      try {
        const result = await requestCalendarSync(api, false);
        if (cancelled) return;
        lastSuccess = Date.now();
        tries = 0;
        applyCalendarSync(queryClient, result);
      } catch (error) {
        if (cancelled) return;
        if (isApiError(error) && error.kind === 'http') {
          if (error.status === 409 && error.code === 'sync_in_progress') {
            if (tries < MAX_TRIES) schedule(BUSY_RETRY_MS);
          } else if (error.status === 503) {
            if (tries < MAX_TRIES) {
              schedule(Math.min(MAX_RETRY_WAIT_MS, error.retryAfterMs ?? BUSY_RETRY_MS));
            }
          } else if (
            error.status === 409 &&
            (error.code === 'calendar_reconnect_required' ||
              error.code === 'calendar_not_connected')
          ) {
            // Stop for good; the refreshed status shows the reconnect prompt.
            stopped = true;
            void queryClient.invalidateQueries({ queryKey: calendarKey });
          }
        }
        // Anything else: stay quiet and wait for the next trigger.
      } finally {
        inFlight = false;
      }
    }

    const staleOrDirty = () =>
      dirty || lastSuccess === null || Date.now() - lastSuccess > STALE_AFTER_MS;

    const onVisible = () => {
      if (visible() && staleOrDirty()) void run(true);
    };

    // (a) when the app opens (or the setting is switched on / the calendar gets connected).
    void run(true);
    // (b) back to the tab.
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // (c) every five minutes while it is visible.
    const interval = setInterval(() => void run(true), INTERVAL_MS);
    // (d) a change that moves planned blocks, after a short quiet period.
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (event.mutation.options.meta?.changesPlannedBlocks !== true) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (visible()) void run(true);
        else dirty = true;
      }, DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(retryTimer);
      clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      unsubscribe();
    };
  }, [active, userId, queryClient, api]);

  // Nothing carries over to the next person.
  useEffect(() => () => recordCalendarUpdate(null), [userId]);
}
