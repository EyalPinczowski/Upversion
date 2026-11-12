import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../api/ApiProvider';
import { applyCalendarSync, type CalendarSyncResult } from '../api/calendar-hooks';
import { createApiClient } from '../api/client';
import { createQueryClient } from '../lib/query-client';
import { expectNoAxeViolations } from '../test/axe';
import { json } from '../test/helpers';
import {
  autoSyncStorageKey,
  currentSyncEpoch,
  recordCalendarUpdate,
  resetCalendarSyncState,
  writeAutoSyncEnabled,
} from './auto-sync-state';
import { CalendarUpdatedStatus } from './CalendarUpdatedStatus';
import {
  BUSY_RETRY_MS,
  INTERVAL_MS,
  MARGIN_MS,
  MAX_CALLS_PER_HOUR,
  MAX_RETRY_WAIT_MS,
  MAX_TRIES,
  STALE_AFTER_MS,
  useAutoCalendarSync,
} from './useAutoCalendarSync';

const USER = 'user-1';
const CONNECTED = { status: 'connected', lastSyncedAt: null, lastErrorCode: null, sources: [] };
/** The server stamps the sync when it ends, so the answer carries the moment of the call. */
const synced = (extra: Partial<CalendarSyncResult> = {}): Response =>
  json({
    status: 'synced',
    syncedAt: new Date().toISOString(),
    movedTaskIds: [],
    finishChanged: false,
    text: 'ok',
    ...extra,
  });
const errorResponse = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const timeText = (iso: string) =>
  `Calendar updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso))}`;

type Handler = (request: Request) => Response | Promise<Response>;

let routes: Record<string, Handler>;
let calls: { key: string; body: string | null }[];
let visibility: 'visible' | 'hidden';
let queryClient: QueryClient;

const syncCalls = () => calls.filter((c) => c.key === 'POST /api/v1/calendar/sync');

function setVisibility(next: 'visible' | 'hidden') {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function Harness() {
  useAutoCalendarSync(currentUser);
  return <CalendarUpdatedStatus />;
}
let currentUser = USER;

function mount(userId = USER) {
  currentUser = userId;
  const client = createApiClient({
    baseUrl: 'http://api.test',
    getAccessToken: async () => null,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const key = `${request.method} ${new URL(request.url).pathname}`;
      calls.push({ key, body: request.method === 'POST' ? await request.clone().text() : null });
      const handler = routes[key];
      return handler ? handler(request) : errorResponse(404, 'not_found');
    },
  });
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={client}>
        <Harness />
      </ApiProvider>
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    ...view,
    rerenderAs: (id: string) => {
      currentUser = id;
      view.rerender(ui());
    },
  };
}

/** Lets the status query and the first sync settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
  window.localStorage.clear();
  resetCalendarSyncState();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  calls = [];
  queryClient = createQueryClient();
  routes = {
    'GET /api/v1/calendar': () => json(CONNECTED),
    'POST /api/v1/calendar/sync': () => synced(),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic calendar sync triggers', () => {
  it('syncs once when the app opens, without force', async () => {
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    expect(syncCalls()[0]!.body).toBe('null');
  });

  it('syncs when the tab becomes visible again after more than 2 minutes, not before', async () => {
    mount();
    await settle();
    setVisibility('hidden');
    await advance(STALE_AFTER_MS - 1000);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(1);

    setVisibility('hidden');
    await advance(2000);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(2);
  });

  it('also syncs on window focus when the last attempt is stale', async () => {
    mount();
    await settle();
    await advance(STALE_AFTER_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(syncCalls()).toHaveLength(2);
  });

  it('asks again 5 minutes plus a margin after the last sync ENDED, so the server cache is over', async () => {
    mount();
    await settle();
    await advance(INTERVAL_MS);
    // A plain 300 s timer would fire here and get `cached` from the server.
    expect(syncCalls()).toHaveLength(1);
    await advance(MARGIN_MS + 1000);
    expect(syncCalls()).toHaveLength(2);
    await advance(INTERVAL_MS + MARGIN_MS + 1000);
    expect(syncCalls()).toHaveLength(3);
  });

  it('bases the next run on the server time of the last sync', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      synced({ syncedAt: new Date(Date.now() - 100_000).toISOString() });
    mount();
    await settle();
    await advance(INTERVAL_MS + MARGIN_MS - 100_000 - 1000);
    expect(syncCalls()).toHaveLength(1);
    await advance(2000);
    expect(syncCalls()).toHaveLength(2);
  });

  it('a result that moves tasks does not trigger another sync', async () => {
    routes['POST /api/v1/calendar/sync'] = () => synced({ movedTaskIds: ['t1'] });
    mount();
    await settle();
    await advance(INTERVAL_MS);
    expect(syncCalls()).toHaveLength(1);
  });
});

describe('what a finished sync reloads', () => {
  const seed = () => {
    queryClient.setQueryData(['me'], { id: 1 });
    queryClient.setQueryData(['schedule', 'p1'], { blocks: [] });
    queryClient.setQueryData(['tasks', 'p1'], { tasks: [] });
  };
  const stale = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
  const result = (extra: Partial<CalendarSyncResult>): CalendarSyncResult => ({
    status: 'synced',
    syncedAt: '2026-11-12T10:00:00.000Z',
    movedTaskIds: [],
    finishChanged: false,
    text: '',
    ...extra,
  });

  it('reloads nothing for a cached answer, even one that lists moved tasks', () => {
    seed();
    applyCalendarSync(queryClient, result({ status: 'cached', movedTaskIds: ['t1'] }));
    expect(stale(['schedule', 'p1'])).toBe(false);
    expect(stale(['tasks', 'p1'])).toBe(false);
  });

  it('reloads nothing when a sync moved nothing', () => {
    seed();
    applyCalendarSync(queryClient, result({}));
    expect(stale(['schedule', 'p1'])).toBe(false);
  });

  it('reloads only the plan queries when tasks moved, and not for the same answer again', () => {
    seed();
    applyCalendarSync(queryClient, result({ movedTaskIds: ['t2', 't1'] }));
    expect(stale(['schedule', 'p1'])).toBe(true);
    expect(stale(['tasks', 'p1'])).toBe(true);
    expect(stale(['me'])).toBe(false);

    seed();
    queryClient.setQueryData(['schedule', 'p1'], { blocks: [] });
    applyCalendarSync(queryClient, result({ movedTaskIds: ['t1', 't2'] }));
    expect(stale(['schedule', 'p1'])).toBe(false);

    applyCalendarSync(queryClient, result({ movedTaskIds: ['t1'] }));
    expect(stale(['schedule', 'p1'])).toBe(true);
  });

  it('reloads when the finish date changed', () => {
    seed();
    applyCalendarSync(queryClient, result({ finishChanged: true }));
    expect(stale(['schedule', 'p1'])).toBe(true);
  });

  it('drops the answer of a sync that started for an earlier account', () => {
    seed();
    const started = currentSyncEpoch();
    resetCalendarSyncState();
    applyCalendarSync(queryClient, result({ movedTaskIds: ['t1'] }), started);
    expect(stale(['schedule', 'p1'])).toBe(false);
    function Probe() {
      return <CalendarUpdatedStatus />;
    }
    render(<Probe />);
    expect(screen.queryByText(/Calendar updated/)).not.toBeInTheDocument();
  });
});

describe('hidden tab and single flight', () => {
  it('never syncs while the tab is hidden, and syncs on return', async () => {
    visibility = 'hidden';
    mount();
    await settle();
    await advance(INTERVAL_MS * 2);
    expect(syncCalls()).toHaveLength(0);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(1);
  });

  it('never has more than one sync in flight', async () => {
    let release: (() => void) | undefined;
    routes['POST /api/v1/calendar/sync'] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(synced());
      });
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    window.dispatchEvent(new Event('focus'));
    await advance(STALE_AFTER_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(syncCalls()).toHaveLength(1);
    release?.();
    await settle();
  });
});

describe('failures stay quiet and respect one shared not-before time', () => {
  it('409 sync_in_progress retries later, at most a few tries', async () => {
    routes['POST /api/v1/calendar/sync'] = () => errorResponse(409, 'sync_in_progress');
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    await advance(BUSY_RETRY_MS - 1000);
    expect(syncCalls()).toHaveLength(1);
    await advance(2000);
    expect(syncCalls()).toHaveLength(2);
    await advance(BUSY_RETRY_MS * 2);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    await advance(BUSY_RETRY_MS * 3);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('409 sync_in_progress then success stops retrying', async () => {
    let n = 0;
    routes['POST /api/v1/calendar/sync'] = () =>
      n++ === 0 ? errorResponse(409, 'sync_in_progress') : synced();
    mount();
    await settle();
    await advance(BUSY_RETRY_MS + 1000);
    expect(syncCalls()).toHaveLength(2);
    await advance(BUSY_RETRY_MS * 3);
    expect(syncCalls()).toHaveLength(2);
  });

  it('503 honours Retry-After', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      errorResponse(503, 'calendar_unavailable', { 'retry-after': '90' });
    mount();
    await settle();
    await advance(89_000);
    expect(syncCalls()).toHaveLength(1);
    await advance(2000);
    expect(syncCalls()).toHaveLength(2);
  });

  it('caps a Retry-After above 5 minutes', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      errorResponse(503, 'calendar_unavailable', { 'retry-after': '3600' });
    mount();
    await settle();
    await advance(MAX_RETRY_WAIT_MS - 1000);
    expect(syncCalls()).toHaveLength(1);
    await advance(2000);
    expect(syncCalls()).toHaveLength(2);
  });

  it('a focus or visibility change during backoff does not call', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      errorResponse(503, 'calendar_unavailable', { 'retry-after': '240' });
    mount();
    await settle();
    // Older than the 2-minute stale limit, but still inside the server's Retry-After.
    await advance(STALE_AFTER_MS + 10_000);
    window.dispatchEvent(new Event('focus'));
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(1);
    await advance(240_000 - STALE_AFTER_MS);
    expect(syncCalls()).toHaveLength(2);
  });

  it('after the tries are used up, triggers do not restart a retry chain', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      errorResponse(503, 'calendar_unavailable', { 'retry-after': '40' });
    mount();
    await settle();
    await advance(40_000);
    await advance(40_000);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    await advance(STALE_AFTER_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(syncCalls()).toHaveLength(MAX_TRIES + 1);
    // That try failed too: no timer chain follows it, only the normal tick.
    await advance(60_000);
    expect(syncCalls()).toHaveLength(MAX_TRIES + 1);
  });

  it.each(['calendar_reconnect_required', 'calendar_not_connected'])(
    '409 %s stops auto-sync and refreshes the status',
    async (code) => {
      routes['POST /api/v1/calendar/sync'] = () => errorResponse(409, code);
      mount();
      await settle();
      const statusCalls = () => calls.filter((c) => c.key === 'GET /api/v1/calendar').length;
      expect(statusCalls()).toBe(2);
      await advance(INTERVAL_MS * 2);
      window.dispatchEvent(new Event('focus'));
      await settle();
      expect(syncCalls()).toHaveLength(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('a network failure is quiet and the next tick tries again', async () => {
    let n = 0;
    routes['POST /api/v1/calendar/sync'] = () => {
      if (n++ === 0) throw new TypeError('offline');
      return synced();
    };
    mount();
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await advance(INTERVAL_MS + MARGIN_MS + 1000);
    expect(syncCalls()).toHaveLength(2);
  });

  it('makes at most 12 calls an hour, whatever the triggers do', async () => {
    mount();
    await settle();
    for (let i = 0; i < 20; i++) {
      await advance(STALE_AFTER_MS + 1000);
      window.dispatchEvent(new Event('focus'));
      await settle();
    }
    // 20 triggers in about 40 minutes: capped, and allowed again when the hour moves on.
    expect(syncCalls().length).toBeLessThanOrEqual(MAX_CALLS_PER_HOUR);
    expect(syncCalls().length).toBe(MAX_CALLS_PER_HOUR);
    await advance(60 * 60 * 1000);
    expect(syncCalls().length).toBeGreaterThan(MAX_CALLS_PER_HOUR);
  });
});

describe('when auto-sync must not run', () => {
  it('does nothing when the calendar is switched off on the server (404)', async () => {
    routes['GET /api/v1/calendar'] = () => errorResponse(404, 'not_found');
    mount();
    await settle();
    await advance(INTERVAL_MS * 2);
    expect(syncCalls()).toHaveLength(0);
  });

  it.each(['disconnected', 'needs_reconnect'])('does nothing when %s', async (status) => {
    routes['GET /api/v1/calendar'] = () => json({ ...CONNECTED, status });
    mount();
    await settle();
    await advance(INTERVAL_MS * 2);
    window.dispatchEvent(new Event('focus'));
    expect(syncCalls()).toHaveLength(0);
  });

  it('does nothing when the setting is off, and starts when it is switched on', async () => {
    writeAutoSyncEnabled(USER, false);
    expect(window.localStorage.getItem(autoSyncStorageKey(USER))).toBe('off');
    mount();
    await settle();
    await advance(INTERVAL_MS * 2);
    window.dispatchEvent(new Event('focus'));
    expect(syncCalls()).toHaveLength(0);

    act(() => writeAutoSyncEnabled(USER, true));
    await settle();
    expect(syncCalls()).toHaveLength(1);
  });

  it('the setting is per user', async () => {
    writeAutoSyncEnabled('someone-else', false);
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
  });

  it('still works when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
  });
});

describe('cleanup and account switch', () => {
  it('stops every timer and listener on unmount', async () => {
    const view = mount();
    await settle();
    view.unmount();
    await advance(INTERVAL_MS * 3);
    window.dispatchEvent(new Event('focus'));
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a pending retry on unmount', async () => {
    routes['POST /api/v1/calendar/sync'] = () => errorResponse(409, 'sync_in_progress');
    const view = mount();
    await settle();
    view.unmount();
    await advance(BUSY_RETRY_MS * 3);
    expect(syncCalls()).toHaveLength(1);
  });

  it('forgets the last update time when the account switches', async () => {
    const view = mount();
    await settle();
    expect(screen.getByText(/Calendar updated/)).toBeInTheDocument();
    routes['POST /api/v1/calendar/sync'] = () => new Promise<Response>(() => {});
    view.rerenderAs('user-2');
    expect(screen.queryByText(/Calendar updated/)).not.toBeInTheDocument();
  });

  it('ignores an in-flight answer for the old user after an account switch', async () => {
    const OLD = '2026-11-12T03:11:00.000Z';
    let releaseOld: (() => void) | undefined;
    let n = 0;
    routes['POST /api/v1/calendar/sync'] = () => {
      if (n++ === 0) {
        return new Promise<Response>((resolve) => {
          releaseOld = () => resolve(synced({ syncedAt: OLD, movedTaskIds: ['old'] }));
        });
      }
      return synced();
    };
    const view = mount();
    await settle();
    view.rerenderAs('user-2');
    await settle();
    expect(syncCalls()).toHaveLength(2);
    const fresh = screen.getByText(/Calendar updated/).textContent;
    releaseOld?.();
    await settle();
    expect(screen.getByText(/Calendar updated/).textContent).toBe(fresh);
    expect(fresh).not.toBe(timeText(OLD));
  });
});

describe('Calendar updated status line', () => {
  it('is plain visible text (no live region) and passes axe', async () => {
    const view = mount();
    expect(screen.queryByText(/Calendar updated/)).not.toBeInTheDocument();
    await settle();
    const line = screen.getByText(/^Calendar updated .+/);
    expect(line).not.toHaveAttribute('role');
    expect(line).not.toHaveAttribute('aria-live');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    vi.useRealTimers();
    await expectNoAxeViolations(view.container);
  });

  it('keeps no text before the first sync', () => {
    recordCalendarUpdate(null);
    mount();
    expect(screen.queryByText(/Calendar updated/)).not.toBeInTheDocument();
  });
});
