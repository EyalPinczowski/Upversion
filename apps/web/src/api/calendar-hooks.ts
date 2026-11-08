import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { redirectTo } from '../lib/navigate';
import { unwrap } from './client';
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
export function useCalendarBusy(from: string, to: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...calendarKey, 'busy', from, to] as const,
    queryFn: async ({ signal }): Promise<CalendarBusyItem[]> => {
      try {
        const { items } = await unwrap(
          api.raw.GET('/api/v1/calendar/busy', { params: { query: { from, to } }, signal }),
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

export function useSyncCalendar() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: () => unwrap(api.raw.POST('/api/v1/calendar/sync', { body: null })),
    onSettled: (result) => {
      // A sync can move tasks, so what the plan shows may be stale.
      if (result && result.movedTaskIds.length > 0) void queryClient.invalidateQueries();
      else void queryClient.invalidateQueries({ queryKey: calendarKey });
    },
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
