import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { redirectTo } from '../lib/navigate';
import {
  currentSyncEpoch,
  recordCalendarUpdate,
  syncResultChanged,
} from '../calendar/auto-sync-state';
import { unwrap, type ApiClient } from './client';
import { useApi } from './context';
import { isApiError } from './errors';
import type { paths } from './schema';

/**
 * Data hooks of the optional Google Calendar link (spec 3.8). The whole feature sits behind a flag
 * on the server: when it is off every route answers 404, and the status query then yields `null`,
 * which the UI treats as "show nothing, ask nothing".
 */
type JsonOf<T> = T extends { responses: { 200: { content: { 'application/json': infer B } } } }
  ? B
  : never;

export type CalendarStatus = JsonOf<paths['/api/v1/calendar']['get']>;
export type CalendarSource = CalendarStatus['sources'][number];
export type CalendarSyncResult = JsonOf<paths['/api/v1/calendar/sync']['post']>;

export type CalendarBusyItem = JsonOf<paths['/api/v1/calendar/busy']['get']>['items'][number];

export const calendarKey = ['calendar'] as const;

const mutationDefaults = { networkMode: 'always' } as const;

/** The connection status, or null when the feature is switched off on the server (404). */
export function useCalendarStatus() {
  const api = useApi();
  return useQuery({
    queryKey: calendarKey,
    queryFn: async ({ signal }): Promise<CalendarStatus | null> => {
      try {
        return await unwrap(api.raw.GET('/api/v1/calendar', { signal }));
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Busy time between two local dates (inclusive, at most 14 days apart) for the Week time grid.
 * It is the owner's own calendar data and is only ever shown to the owner. `enabled` stays false
 * until the calendar is connected, so nothing is requested otherwise.
 */
export function useCalendarBusy(from: string, to: string, planId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...calendarKey, 'busy', planId, from, to] as const,
    queryFn: async ({ signal }): Promise<CalendarBusyItem[]> => {
      try {
        const { items } = await unwrap(
          api.raw.GET('/api/v1/calendar/busy', { params: { query: { from, to, planId } }, signal }),
        );
        return items;
      } catch (error) {
        if (isApiError(error) && error.status === 404) return [];
        throw error;
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Asks the server for Google's consent URL and sends the browser there. */
export function useConnectCalendar() {
  const api = useApi();
  return useMutation({
    ...mutationDefaults,
    mutationFn: async () => {
      const { authorizationUrl } = await unwrap(api.raw.POST('/api/v1/calendar/connect'));
      // Only ever leave for Google's HTTPS consent page.
      const target = new URL(authorizationUrl);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') {
        throw new Error('Unexpected URL.');
      }
      redirectTo(authorizationUrl);
    },
  });
}

/** Sends the code and state Google returned. Both are single use. */
export function useFinishCalendarConnect() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: { code: string; state: string }) =>
      unwrap(api.raw.POST('/api/v1/calendar/callback', { body })),
    onSuccess: (status) => queryClient.setQueryData(calendarKey, status),
  });
}

export const calendarSyncKey = [...calendarKey, 'sync'] as const;

/** One sync call. Only the manual "Sync now" asks for `force`; automatic runs never do. */
export const requestCalendarSync = (api: ApiClient, force: boolean): Promise<CalendarSyncResult> =>
  unwrap(api.raw.POST('/api/v1/calendar/sync', { body: force ? { force: true } : null }));

/** Cached query roots that show the plan, so a calendar-driven change refreshes them (and no others). */
const PLAN_QUERY_ROOTS = new Set([
  'plans',
  'plan',
  'tasks',
  'schedule',
  'progress',
  'open-tasks',
  'day',
  'briefing',
]);

/**
 * `movedTaskIds` is the CURRENT set of tasks the calendar displaced, not a list of new moves. So an
 * already-displaced task that moves to another day leaves the signature unchanged and this dedupe
 * can skip that reload; the plan queries refresh on their own staleness or the next change.
 */
const signatureOf = (result: CalendarSyncResult) =>
  `${[...result.movedTaskIds].sort().join(',')}|${result.finishChanged}`;

/**
 * What a finished sync means for the screen. A `cached` answer changes nothing. A `synced` one
 * refreshes the calendar status, and the plan queries only when the calendar moved tasks or the
 * finish date and that answer differs from the previous one (never on every tick).
 * `epoch` is the account epoch when the call started: an answer for an earlier account is dropped.
 */
export function applyCalendarSync(
  queryClient: QueryClient,
  result: CalendarSyncResult | undefined,
  epoch: number = currentSyncEpoch(),
) {
  if (epoch !== currentSyncEpoch()) return;
  if (!result) {
    void queryClient.invalidateQueries({ queryKey: calendarKey });
    return;
  }
  if (result.status === 'cached') {
    recordCalendarUpdate(result.syncedAt ?? new Date().toISOString());
    return;
  }
  void queryClient.invalidateQueries({ queryKey: calendarKey });
  const moved = result.movedTaskIds.length > 0 || result.finishChanged;
  if (syncResultChanged(signatureOf(result)) && moved) {
    void queryClient.invalidateQueries({
      predicate: (query) => PLAN_QUERY_ROOTS.has(String(query.queryKey[0])),
    });
  }
  recordCalendarUpdate(result.syncedAt ?? new Date().toISOString());
}

export function useSyncCalendar() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationKey: calendarSyncKey,
    onMutate: () => ({ epoch: currentSyncEpoch() }),
    mutationFn: (options?: { force?: boolean }) =>
      requestCalendarSync(api, options?.force === true),
    onSettled: (result, _error, _vars, context) =>
      applyCalendarSync(queryClient, result, context?.epoch),
  });
}

export function useSetCalendarSources() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (sources: { calendarId: string; blocksTime: boolean }[]) =>
      unwrap(api.raw.PUT('/api/v1/calendar/sources', { body: { sources } })),
    onSuccess: (status) => queryClient.setQueryData(calendarKey, status),
  });
}

export function useDisconnectCalendar() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: () => unwrap(api.raw.DELETE('/api/v1/calendar')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calendarKey });
    },
  });
}
