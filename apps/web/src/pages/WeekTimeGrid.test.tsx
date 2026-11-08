import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { fakeAuth, installApi, json, renderApp, SESSION } from '../test/helpers';
import { openTasks, PLAN_ID, planRoutes, progress, schedule } from '../test/plan-fixtures';

const BASE = `/api/v1/plans/${PLAN_ID}`;

// Week of Sun Nov 8 to Sat Nov 14, today Tue Nov 10 (see plan-fixtures).
const study = (taskId: string, date: string, start: string, end: string) => ({
  taskId,
  date,
  start,
  end,
  minutes: 60,
  kind: 'study' as const,
});
const blocks = [
  study('sql1', '2026-11-10', '09:00', '10:00'),
  study('setup', '2026-11-10', '09:30', '10:30'),
  study('sql1', '2026-11-11', '11:00', '12:00'),
];

const connected = {
  status: 'connected',
  lastSyncedAt: null,
  lastErrorCode: null,
  sources: [{ calendarId: 'work', name: 'Work', blocksTime: true }],
};
const busyItems = [
  { date: '2026-11-10', startMinute: 840, endMinute: 900, allDay: false, title: 'Dentist' },
  { date: '2026-11-11', startMinute: 0, endMinute: 1440, allDay: true, title: 'Conference' },
];

function open(extra: Parameters<typeof planRoutes>[0] = {}, path = '/week?view=grid') {
  const api = installApi(
    planRoutes({
      [`GET ${BASE}/schedule`]: () => json(schedule({ blocks })),
      [`GET ${BASE}/progress`]: () => json(progress()),
      [`GET ${BASE}/open-tasks`]: () => json(openTasks()),
      ...extra,
    }),
  );
  renderApp({ auth: fakeAuth(SESSION), path });
  return api;
}

const withCalendar = (items = busyItems) => ({
  'GET /api/v1/calendar': () => json(connected),
  'GET /api/v1/calendar/busy': () => json({ items }),
});

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Week time grid', () => {
  it('draws plan blocks with accessible names, task type text and a link to the task', async () => {
    open(withCalendar());
    await screen.findByRole('heading', { name: 'Time grid' });
    const course = await screen.findByRole('link', {
      name: 'Course: Intro to SQL, 09:00 to 10:00',
    });
    expect(course).toHaveAttribute('href', '/plan/sql1');
    expect(course).toHaveTextContent('Course');
    expect(
      screen.getByRole('link', { name: 'Admin: Set up accounts, 09:30 to 10:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Course: Intro to SQL, 11:00 to 12:00' }),
    ).toBeInTheDocument();
  });

  it('draws busy time as labelled, keyboard-reachable blocks and all-day events in a strip', async () => {
    open(withCalendar());
    const busy = await screen.findByRole('group', { name: 'Busy: Dentist, 14:00 to 15:00' });
    expect(busy).toHaveTextContent('Busy');
    expect(busy).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Busy all day: Conference')).toBeInTheDocument();
    // No gradient anywhere in the grid.
    expect(document.querySelector('#grid-heading')!.closest('section')!.outerHTML).not.toMatch(
      /gradient/i,
    );
  });

  it('puts overlapping blocks side by side', async () => {
    open(withCalendar());
    const first = await screen.findByRole('link', { name: /Intro to SQL, 09:00 to 10:00/ });
    const second = screen.getByRole('link', { name: /Set up accounts, 09:30 to 10:30/ });
    const box = (el: HTMLElement) => el.parentElement!.style;
    expect(box(first).width).toBe('50%');
    expect(box(second).width).toBe('50%');
    expect(box(first).left).toBe('0%');
    expect(box(second).left).toBe('50%');
    // A block that overlaps nothing takes the whole column.
    const alone = screen.getByRole('link', { name: /Intro to SQL, 11:00 to 12:00/ });
    expect(box(alone).width).toBe('100%');
  });

  it('marks today with text', async () => {
    open(withCalendar());
    const today = await screen.findByRole('group', { name: 'Tue, Nov 10, today' });
    expect(within(today).getByText('Today')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Wed, Nov 11' })).toBeInTheDocument();
  });

  it('shows one day at a time on a phone, chosen with the day buttons', async () => {
    open(withCalendar());
    const days = await screen.findByRole('group', { name: 'Day' });
    expect(within(days).getByRole('button', { name: /Tue/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Only the selected column is shown below the lg breakpoint: the others carry `hidden`.
    const column = (name: string) => screen.getByRole('group', { name });
    expect(column('Tue, Nov 10, today').className).not.toMatch(/(^| )hidden( |$)/);
    expect(column('Wed, Nov 11').className).toMatch(/(^| )hidden( |$)/);
    await userEvent.setup().click(within(days).getByRole('button', { name: /Wed/ }));
    expect(column('Wed, Nov 11').className).not.toMatch(/(^| )hidden( |$)/);
    expect(column('Tue, Nov 10, today').className).toMatch(/(^| )hidden( |$)/);
  });

  it('asks for the busy time of the shown week only, and only once connected', async () => {
    const api = open(withCalendar());
    await screen.findByRole('group', { name: /Busy: Dentist/ });
    const call = api.calls.find((c) => new URL(c.url).pathname === '/api/v1/calendar/busy')!;
    expect(new URL(call.url).searchParams.get('from')).toBe('2026-11-08');
    expect(new URL(call.url).searchParams.get('to')).toBe('2026-11-14');
  });

  it('has no accessibility violations', async () => {
    open(withCalendar());
    await screen.findByRole('group', { name: /Busy: Dentist/ });
    await expectNoAxeViolations();
  });
});

describe('Week time grid without a calendar', () => {
  it.each([
    [
      'disconnected',
      {
        'GET /api/v1/calendar': () => json({ ...connected, status: 'disconnected', sources: [] }),
      },
    ],
    ['the feature switched off on the server (404)', {}],
  ])('still shows the plan and one line to connect when %s', async (_name, routes) => {
    const api = open(routes);
    const hint = await screen.findByText(/to see your busy time/);
    expect(hint).toHaveTextContent('Connect Google Calendar in Settings to see your busy time');
    expect(
      within(hint).getByRole('link', { name: 'Connect Google Calendar in Settings' }),
    ).toHaveAttribute('href', '/settings');
    expect(await screen.findByRole('link', { name: /Course: Intro to SQL, 09:00/ })).toBeVisible();
    expect(screen.queryByText('Busy', { exact: true })).not.toBeInTheDocument();
    expect(api.count('GET /api/v1/calendar/busy')).toBe(0);
  });

  it('does not show the line when the calendar is connected', async () => {
    open(withCalendar([]));
    await screen.findByRole('heading', { name: 'Time grid' });
    await screen.findByRole('link', { name: /Course: Intro to SQL, 09:00/ });
    expect(screen.queryByText(/to see your busy time/)).not.toBeInTheDocument();
  });
});

describe('Week view toggle', () => {
  it('starts on the list, with the list fully there', async () => {
    open(withCalendar(), '/week');
    expect(await screen.findByRole('heading', { name: 'Open tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Time grid' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('group', { name: 'Week view' });
    expect(within(toggle).getByRole('button', { name: 'List' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(toggle).getByRole('button', { name: 'Time grid' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('switches to the grid and back, and remembers the choice on this device', async () => {
    open(withCalendar(), '/week');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Time grid' }));
    expect(await screen.findByRole('heading', { name: 'Time grid' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Open tasks' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('upversion.week-view')).toBe('grid');
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByRole('heading', { name: 'Open tasks' })).toBeInTheDocument();
    expect(window.localStorage.getItem('upversion.week-view')).toBe('list');
  });

  it('opens on the grid when the device remembers it', async () => {
    window.localStorage.setItem('upversion.week-view', 'grid');
    open(withCalendar(), '/week');
    expect(await screen.findByRole('heading', { name: 'Time grid' })).toBeInTheDocument();
  });

  it('lets the address win over what the device remembers', async () => {
    window.localStorage.setItem('upversion.week-view', 'grid');
    open(withCalendar(), '/week?view=list');
    expect(await screen.findByRole('heading', { name: 'Open tasks' })).toBeInTheDocument();
  });

  it('still works when browser storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open(withCalendar(), '/week');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Time grid' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Time grid' })).toBeVisible());
  });
});
