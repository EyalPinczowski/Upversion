import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarStatus } from '../../api/calendar-hooks';
import * as navigate from '../../lib/navigate';
import { expectNoAxeViolations } from '../../test/axe';
import {
  apiError,
  fakeAuth,
  installApi,
  json,
  meBody,
  renderApp,
  SESSION,
} from '../../test/helpers';

const redirect = vi.spyOn(navigate, 'redirectTo').mockImplementation(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
  redirect.mockClear();
});
beforeEach(() => window.localStorage.clear());

const CONNECTED: CalendarStatus = {
  status: 'connected',
  lastSyncedAt: '2026-11-02T08:30:00.000Z',
  lastErrorCode: null,
  autoSync: true,
  sources: [
    { calendarId: 'work', name: 'Work', blocksTime: true },
    { calendarId: 'birthdays', name: 'Birthdays', blocksTime: false },
  ],
};
const DISCONNECTED: CalendarStatus = {
  status: 'disconnected',
  lastSyncedAt: null,
  lastErrorCode: null,
  autoSync: true,
  sources: [],
};

function open(status: CalendarStatus | 404, extra: Parameters<typeof installApi>[0] = {}) {
  const api = installApi({
    'GET /api/v1/me': () => json(meBody()),
    'GET /api/v1/calendar': () =>
      status === 404 ? apiError(404, 'not_found', 'Resource not found.') : json(status),
    // The app-open sync, answered quietly so tests only look at what they care about.
    'POST /api/v1/calendar/sync': () =>
      json({ status: 'cached', syncedAt: null, movedTaskIds: [], finishChanged: false, text: '' }),
    ...extra,
  });
  renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
  return api;
}

const region = () => screen.findByRole('region', { name: 'Calendar' });
const bodyOf = (call: Request | undefined) => call?.clone().json();

describe('calendar settings', () => {
  it('shows a disconnected account with a Connect button and the read-only promise', async () => {
    open(DISCONNECTED);
    const section = within(await region());
    expect(section.getByText(/Not connected/)).toBeInTheDocument();
    expect(section.getByText(/only changes events it created itself/)).toBeInTheDocument();
    expect(section.getByText(/read-only/)).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Connect Google Calendar' })).toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows a connected account: last synced time, calendars and buttons', async () => {
    open(CONNECTED);
    const section = within(await region());
    expect(section.getByText(/Connected\./)).toBeInTheDocument();
    expect(section.getByText(/Last synced/)).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(section.getByRole('checkbox', { name: /Work/ })).toBeChecked();
    expect(section.getByRole('checkbox', { name: /Birthdays/ })).not.toBeChecked();
  });

  it('explains a failed connection in words and offers Reconnect', async () => {
    open({ ...CONNECTED, status: 'needs_reconnect', lastErrorCode: 'invalid_grant' });
    const section = within(await region());
    expect(section.getByText(/Needs to be reconnected/)).toBeInTheDocument();
    expect(section.getByText(/Google no longer accepts the connection/)).toBeInTheDocument();
    expect(section.queryByText('invalid_grant')).not.toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Reconnect Google Calendar' })).toBeInTheDocument();
    expect(section.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows nothing at all when the feature is off (404)', async () => {
    const api = open(404);
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await waitFor(() => expect(api.count('GET /api/v1/calendar')).toBe(1));
    await screen.findByRole('region', { name: 'Profile' });
    expect(screen.queryByRole('region', { name: 'Calendar' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Google Calendar/)).not.toBeInTheDocument();
    expect(api.count('POST /api/v1/calendar/sync')).toBe(0);
  });

  it('Connect asks for the consent URL and sends the browser there', async () => {
    const api = open(DISCONNECTED, {
      'POST /api/v1/calendar/connect': () =>
        json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s'),
    );
    expect(api.count('POST /api/v1/calendar/connect')).toBe(1);
  });

  it('does not follow a consent URL that is not https', async () => {
    open(DISCONNECTED, {
      'POST /api/v1/calendar/connect': () => json({ authorizationUrl: 'http://evil.example/x' }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(await section.findByRole('alert')).toHaveTextContent('couldn’t start the connection');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not follow an https URL that is not Google', async () => {
    open(DISCONNECTED, {
      'POST /api/v1/calendar/connect': () => json({ authorizationUrl: 'https://evil.example/x' }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(await section.findByRole('alert')).toHaveTextContent('couldn’t start the connection');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('makes Connect usable again when the page is restored from the back/forward cache', async () => {
    open(DISCONNECTED, {
      'POST /api/v1/calendar/connect': () =>
        json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Connect Google Calendar' }));
    expect(await section.findByRole('button', { name: 'Opening Google…' })).toBeDisabled();
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });
    expect(await section.findByRole('button', { name: 'Connect Google Calendar' })).toBeEnabled();
  });

  it('Sync now shows the returned text and the moved-task count', async () => {
    let calls = 0;
    open(CONNECTED, {
      'POST /api/v1/calendar/sync': () => {
        calls += 1;
        return json({
          status: 'synced',
          syncedAt: '2026-11-02T09:00:00.000Z',
          movedTaskIds: calls === 1 ? [] : ['t1', 't2'],
          finishChanged: false,
          text: calls === 1 ? 'Nothing changed.' : 'Two tasks moved around your interview.',
        });
      },
    });
    const user = userEvent.setup();
    const section = within(await region());
    await waitFor(() => expect(calls).toBe(1)); // the app-open sync
    await user.click(section.getByRole('button', { name: 'Sync now' }));
    expect(await section.findByText(/Two tasks moved around your interview\./)).toHaveTextContent(
      '2 tasks moved.',
    );
  });

  it('saving a calendar choice sends the whole list with PUT', async () => {
    let body: unknown;
    const api = open(CONNECTED, {
      'PUT /api/v1/calendar/sources': async (request) => {
        body = await request.json();
        return json({
          ...CONNECTED,
          sources: [
            { calendarId: 'work', name: 'Work', blocksTime: true },
            { calendarId: 'birthdays', name: 'Birthdays', blocksTime: true },
          ],
        });
      },
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('checkbox', { name: /Birthdays/ }));
    await waitFor(() => expect(api.count('PUT /api/v1/calendar/sources')).toBe(1));
    expect(body).toEqual({
      sources: [
        { calendarId: 'work', blocksTime: true },
        { calendarId: 'birthdays', blocksTime: true },
      ],
    });
    await waitFor(() => expect(section.getByRole('checkbox', { name: /Birthdays/ })).toBeChecked());
  });

  it('Disconnect asks first, and Cancel sends nothing', async () => {
    const api = open(CONNECTED, {
      'DELETE /api/v1/calendar': () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Disconnect Google Calendar?' });
    expect(api.count('DELETE /api/v1/calendar')).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Keep it connected' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.count('DELETE /api/v1/calendar')).toBe(0);
  });

  it('Disconnect deletes after confirmation and then shows the disconnected state', async () => {
    let connected = true;
    const api = open(CONNECTED, {
      'GET /api/v1/calendar': () => json(connected ? CONNECTED : DISCONNECTED),
      'DELETE /api/v1/calendar': () => {
        connected = false;
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    const section = within(await region());
    await user.click(section.getByRole('button', { name: 'Disconnect' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() => expect(api.count('DELETE /api/v1/calendar')).toBe(1));
    expect(
      await within(await region()).findByRole('button', { name: 'Connect Google Calendar' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('has no accessibility violations when connected', async () => {
    open(CONNECTED);
    await region();
    await expectNoAxeViolations();
  });
});

describe('calendar on app open', () => {
  it('syncs once when connected and keeps quiet when that fails', async () => {
    const api = open(CONNECTED, {
      'POST /api/v1/calendar/sync': () => apiError(503, 'calendar_unavailable', 'Try later.'),
    });
    await region();
    await waitFor(() => expect(api.count('POST /api/v1/calendar/sync')).toBe(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('syncs only once per session even when the status changes and comes back', async () => {
    const answers = [CONNECTED, { ...CONNECTED, status: 'needs_reconnect' as const }, CONNECTED];
    let n = 0;
    const api = open(CONNECTED, {
      'GET /api/v1/calendar': () => json(answers[Math.min(n++, answers.length - 1)]),
      'DELETE /api/v1/calendar': () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    const section = within(await region());
    // The app-open sync refetches the status, which now says needs_reconnect.
    await section.findByText(/Needs to be reconnected/);
    await user.click(section.getByRole('button', { name: 'Disconnect' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
    );
    // Disconnect refetches the status: connected again.
    await section.findByText(/Connected\./);
    expect(api.count('GET /api/v1/calendar')).toBe(3);
    expect(api.count('POST /api/v1/calendar/sync')).toBe(1);
  });

  it('does not sync when disconnected', async () => {
    const api = open(DISCONNECTED);
    await region();
    expect(api.count('POST /api/v1/calendar/sync')).toBe(0);
  });
});

describe('reconnect banner', () => {
  const NEEDS: CalendarStatus = { ...CONNECTED, status: 'needs_reconnect' };

  it('shows on every page when a reconnect is needed, and its button starts the connect flow', async () => {
    const api = installApi({
      'GET /api/v1/me': () => json(meBody()),
      'GET /api/v1/calendar': () => json(NEEDS),
      'POST /api/v1/calendar/connect': () =>
        json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
    });
    renderApp({ auth: fakeAuth(SESSION), path: '/week' });
    const banner = await screen.findByRole('region', { name: 'Calendar connection' });
    expect(banner).toHaveTextContent('Everything else keeps working');
    await userEvent
      .setup()
      .click(within(banner).getByRole('button', { name: 'Reconnect calendar' }));
    await waitFor(() => expect(redirect).toHaveBeenCalled());
    expect(api.count('POST /api/v1/calendar/sync')).toBe(0);
  });

  it.each([
    ['connected', CONNECTED],
    ['disconnected', DISCONNECTED],
    ['feature off', 404 as const],
  ])('does not show when %s', async (_name, status) => {
    const api = installApi({
      'GET /api/v1/me': () => json(meBody()),
      'GET /api/v1/calendar': () =>
        status === 404 ? apiError(404, 'not_found', 'Resource not found.') : json(status),
      'POST /api/v1/calendar/sync': () =>
        json({
          status: 'cached',
          syncedAt: null,
          movedTaskIds: [],
          finishChanged: false,
          text: '',
        }),
    });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await waitFor(() => expect(api.count('GET /api/v1/calendar')).toBe(1));
    expect(screen.queryByRole('region', { name: 'Calendar connection' })).not.toBeInTheDocument();
  });

  it('hides on the Settings page, where the section has the same button', async () => {
    installApi({
      'GET /api/v1/me': () => json(meBody()),
      'GET /api/v1/calendar': () => json(NEEDS),
    });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByText(/Needs to be reconnected/);
    expect(screen.queryByRole('region', { name: 'Calendar connection' })).not.toBeInTheDocument();
  });

  it('sends the body of a sync as null-free JSON', async () => {
    const api = open(CONNECTED);
    await region();
    await waitFor(() => expect(api.count('POST /api/v1/calendar/sync')).toBe(1));
    const call = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/calendar/sync'));
    expect(await bodyOf(call)).toBeNull();
  });
});
