import { QueryClientProvider, useMutation, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../api/ApiProvider';
import { createApiClient } from '../api/client';
import { useTaskAction } from '../api/hooks';
import { createQueryClient } from '../lib/query-client';
import { expectNoAxeViolations } from '../test/axe';
import { json } from '../test/helpers';
import {
  autoSyncStorageKey,
  CHANGES_PLANNED_BLOCKS,
  recordCalendarUpdate,
  writeAutoSyncEnabled,
} from './auto-sync-state';
import { CalendarUpdatedStatus } from './CalendarUpdatedStatus';
import {
  BUSY_RETRY_MS,
  DEBOUNCE_MS,
  INTERVAL_MS,
  MAX_TRIES,
  STALE_AFTER_MS,
  useAutoCalendarSync,
} from './useAutoCalendarSync';

const USER = 'user-1';
const CONNECTED = { status: 'connected', lastSyncedAt: null, lastErrorCode: null, sources: [] };
const SYNCED = {
  status: 'synced',
  syncedAt: '2026-11-12T10:32:00.000Z',
  movedTaskIds: [],
  finishChanged: false,
  text: 'ok',
};
const errorResponse = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Handler = (request: Request) => Response | Promise<Response>;

let routes: Record<string, Handler>;
let calls: { key: string; body: unknown }[];
let visibility: 'visible' | 'hidden';
let queryClient: QueryClient;
let touch: () => void;

const syncCalls = () => calls.filter((c) => c.key === 'POST /api/v1/calendar/sync');

function setVisibility(next: 'visible' | 'hidden') {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function Harness({ userId = USER }: { userId?: string }) {
  useAutoCalendarSync(userId);
  const change = useMutation({ mutationFn: async () => 1, meta: CHANGES_PLANNED_BLOCKS });
  const other = useMutation({ mutationFn: async () => 1 });
  const { mutate } = change;
  useEffect(() => {
    touch = () => mutate();
  }, [mutate]);
  return (
    <>
      <button onClick={() => other.mutate()}>other</button>
      <CalendarUpdatedStatus />
    </>
  );
}

function mount(userId = USER) {
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
  const ui = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={client}>
        <Harness userId={id} />
      </ApiProvider>
    </QueryClientProvider>
  );
  const view = render(ui(userId));
  return { ...view, rerenderAs: (id: string) => view.rerender(ui(id)) };
}

/** Lets the status query and the first sync settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
  window.localStorage.clear();
  recordCalendarUpdate(null);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  calls = [];
  queryClient = createQueryClient();
  routes = {
    'GET /api/v1/calendar': () => json(CONNECTED),
    'POST /api/v1/calendar/sync': () => json(SYNCED),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('automatic calendar sync triggers', () => {
  it('(a) syncs once when the app opens, without force', async () => {
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    expect(syncCalls()[0]!.body).toBe('null');
  });

  it('(b) syncs when the tab becomes visible again after more than 2 minutes, not before', async () => {
    mount();
    await settle();
    setVisibility('hidden');
    await advance(STALE_AFTER_MS - 1000);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(1);

    setVisibility('hidden');
    await advance(STALE_AFTER_MS);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(2);
  });

  it('(b) also syncs on window focus when the last sync is stale', async () => {
    mount();
    await settle();
    await advance(STALE_AFTER_MS + 1000);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(syncCalls()).toHaveLength(2);
  });

  it('(c) syncs every 5 minutes while visible', async () => {
    mount();
    await settle();
    await advance(INTERVAL_MS);
    expect(syncCalls()).toHaveLength(2);
    await advance(INTERVAL_MS);
    expect(syncCalls()).toHaveLength(3);
  });

  it('(d) a plan change syncs once after the debounce, and a plain mutation does not', async () => {
    mount();
    await settle();
    act(() => touch());
    await advance(DEBOUNCE_MS - 100);
    expect(syncCalls()).toHaveLength(1);
    await advance(200);
    expect(syncCalls()).toHaveLength(2);

    act(() => screen.getByText('other').click());
    await advance(DEBOUNCE_MS + 100);
    expect(syncCalls()).toHaveLength(2);
  });

  it('(d) several quick changes are coalesced into one call', async () => {
    mount();
    await settle();
    for (let i = 0; i < 4; i++) {
      act(() => touch());
      await advance(1000);
    }
    await advance(DEBOUNCE_MS);
    expect(syncCalls()).toHaveLength(2);
  });

  it('(d) the real task, time and import hooks carry the flag (marking a task done syncs)', async () => {
    routes['POST /api/v1/plans/p1/tasks/t1/complete'] = () => json({});
    function Done() {
      const complete = useTaskAction('p1', 'complete');
      return <button onClick={() => complete.mutate('t1')}>done</button>;
    }
    const client = createApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => null,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const key = `${request.method} ${new URL(request.url).pathname}`;
        calls.push({ key, body: null });
        const handler = routes[key];
        return handler ? handler(request) : errorResponse(404, 'not_found');
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={client}>
          <Harness />
          <Done />
        </ApiProvider>
      </QueryClientProvider>,
    );
    await settle();
    act(() => screen.getByText('done').click());
    await advance(DEBOUNCE_MS + 100);
    expect(syncCalls()).toHaveLength(2);
  });

  it('(d) a change made while hidden syncs when the tab is visible again, even if fresh', async () => {
    mount();
    await settle();
    setVisibility('hidden');
    act(() => touch());
    await advance(DEBOUNCE_MS + 100);
    expect(syncCalls()).toHaveLength(1);
    setVisibility('visible');
    await settle();
    expect(syncCalls()).toHaveLength(2);
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
        release = () => resolve(json(SYNCED));
      });
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    act(() => touch());
    await advance(DEBOUNCE_MS + 100);
    window.dispatchEvent(new Event('focus'));
    await advance(INTERVAL_MS);
    expect(syncCalls()).toHaveLength(1);
    release?.();
    await settle();
    await advance(INTERVAL_MS);
    expect(syncCalls().length).toBeGreaterThan(1);
  });
});

describe('failures stay quiet', () => {
  it('409 sync_in_progress retries later, at most a few tries', async () => {
    routes['POST /api/v1/calendar/sync'] = () => errorResponse(409, 'sync_in_progress');
    mount();
    await settle();
    expect(syncCalls()).toHaveLength(1);
    await advance(BUSY_RETRY_MS);
    expect(syncCalls()).toHaveLength(2);
    await advance(BUSY_RETRY_MS * 5);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('409 sync_in_progress then success stops retrying', async () => {
    let n = 0;
    routes['POST /api/v1/calendar/sync'] = () =>
      n++ === 0 ? errorResponse(409, 'sync_in_progress') : json(SYNCED);
    mount();
    await settle();
    await advance(BUSY_RETRY_MS);
    expect(syncCalls()).toHaveLength(2);
    await advance(BUSY_RETRY_MS * 3);
    expect(syncCalls()).toHaveLength(2);
  });

  it('503 honours Retry-After, gives up after a few tries and waits for the next trigger', async () => {
    routes['POST /api/v1/calendar/sync'] = () =>
      errorResponse(503, 'calendar_unavailable', { 'retry-after': '90' });
    mount();
    await settle();
    await advance(89_000);
    expect(syncCalls()).toHaveLength(1);
    await advance(1000);
    expect(syncCalls()).toHaveLength(2);
    await advance(90_000);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    // 270 s in: no more tries before the next trigger.
    await advance(5000);
    expect(syncCalls()).toHaveLength(MAX_TRIES);
    // The next trigger (the 5-minute tick) starts fresh.
    await advance(INTERVAL_MS);
    expect(syncCalls().length).toBeGreaterThan(MAX_TRIES);
  });

  it('calendar_reconnect_required stops auto-sync and refreshes the status for the reconnect prompt', async () => {
    routes['POST /api/v1/calendar/sync'] = () => errorResponse(409, 'calendar_reconnect_required');
    mount();
    await settle();
    const statusCalls = () => calls.filter((c) => c.key === 'GET /api/v1/calendar').length;
    // Status was loaded once, then refetched after the rejected sync.
    expect(statusCalls()).toBe(2);
    await advance(INTERVAL_MS * 2);
    act(() => touch());
    await advance(DEBOUNCE_MS + 100);
    expect(syncCalls()).toHaveLength(1);
  });

  it('a network failure is quiet and the next trigger tries again', async () => {
    let n = 0;
    routes['POST /api/v1/calendar/sync'] = () => {
      if (n++ === 0) throw new TypeError('offline');
      return json(SYNCED);
    };
    mount();
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await advance(INTERVAL_MS);
    expect(syncCalls()).toHaveLength(2);
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
    act(() => touch());
    await advance(DEBOUNCE_MS + 100);
    expect(syncCalls()).toHaveLength(0);
  });

  it('does nothing when the setting is off, and starts when it is switched on', async () => {
    writeAutoSyncEnabled(USER, false);
    expect(window.localStorage.getItem(autoSyncStorageKey(USER))).toBe('off');
    mount();
    await settle();
    await advance(INTERVAL_MS * 2);
    act(() => touch());
    await advance(DEBOUNCE_MS + 100);
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

describe('cleanup', () => {
  it('stops every timer and listener on unmount', async () => {
    const view = mount();
    await settle();
    act(() => touch());
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
    expect(screen.getByRole('status')).toHaveTextContent(/Calendar updated/);
    view.rerenderAs('user-2');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('Calendar updated status line', () => {
  it('is a polite live region with the time of the last sync, and passes axe', async () => {
    const view = mount();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
    await settle();
    expect(region).toHaveTextContent(/^Calendar updated .+/);
    vi.useRealTimers();
    await expectNoAxeViolations(view.container);
  });
});
