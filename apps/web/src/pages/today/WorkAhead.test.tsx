import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Block } from '../../api/client';
import { expectNoAxeViolations } from '../../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../../test/helpers';
import {
  dayState,
  NOW,
  PLAN_ID,
  planDetail,
  planRoutes,
  previewResult,
  schedule,
} from '../../test/plan-fixtures';
import { addedMinutes, hasPassedBlock, workAheadEffect } from './work-ahead';

// 10:00 in Jerusalem (UTC+2) on the fixture's today, so "already passed" is predictable.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  saved.length = 0;
});

const BASE = `/api/v1/plans/${PLAN_ID}`;
const TODAY = '2026-11-10';
const study = (
  taskId: string,
  date: string,
  start: string,
  end: string,
  minutes: number,
): Block => ({ taskId, date, start, end, minutes, kind: 'study' });
const CURRENT = [
  study('sql1', TODAY, '09:00', '12:00', 180),
  study('setup', '2026-11-11', '09:00', '09:30', 30),
  study('sql1', '2026-11-11', '09:30', '12:00', 150),
];
const PROPOSED = [
  study('sql1', TODAY, '09:00', '12:00', 180),
  study('setup', TODAY, '12:00', '13:00', 60),
  study('sql1', '2026-11-11', '09:00', '11:30', 150),
];
const titleOf = (id: string) => ({ sql1: 'Intro to SQL', setup: 'Set up accounts' })[id] ?? id;

describe('work-ahead helpers', () => {
  it('says the first task of tomorrow now starts today', () => {
    expect(workAheadEffect(CURRENT, PROPOSED, TODAY, titleOf)).toBe(
      'Tomorrow’s first task, Set up accounts, now starts today.',
    );
  });

  it('says how much more of a task that was already started moves into today', () => {
    const current = [
      study('sql1', TODAY, '09:00', '12:00', 180),
      study('sql1', '2026-11-11', '09:00', '11:00', 120),
    ];
    const proposed = [
      study('sql1', TODAY, '09:00', '13:00', 240),
      study('sql1', '2026-11-11', '09:00', '10:00', 60),
    ];
    expect(workAheadEffect(current, proposed, TODAY, titleOf)).toBe(
      '1 h more of Intro to SQL, Tomorrow’s first task, moves into today.',
    );
  });

  it('names the weekday when the next work is not tomorrow, and says nothing when nothing moves', () => {
    const current = [study('setup', '2026-11-12', '09:00', '10:00', 60)];
    const proposed = [study('setup', TODAY, '09:00', '10:00', 60)];
    expect(workAheadEffect(current, proposed, TODAY, titleOf)).toBe(
      'Thu’s first task, Set up accounts, now starts today.',
    );
    expect(workAheadEffect(CURRENT, CURRENT, TODAY, titleOf)).toBe('');
    expect(addedMinutes(CURRENT, PROPOSED, TODAY)).toBe(60);
    expect(addedMinutes(CURRENT, CURRENT, TODAY)).toBe(0);
  });
});

const saved: unknown[] = [];

describe('hasPassedBlock', () => {
  const NOW_MS = Date.parse('2026-11-10T08:00:00Z'); // 10:00 in Jerusalem
  it('flags only new or changed blocks that start before the current time', () => {
    const zone = 'Asia/Jerusalem';
    expect(hasPassedBlock(CURRENT, PROPOSED, TODAY, NOW_MS, zone)).toBe(false);
    // The block that was already planned from 09:00 is not new, so it is not flagged.
    expect(hasPassedBlock(CURRENT, CURRENT, TODAY, NOW_MS, zone)).toBe(false);
    const early = [...CURRENT, study('setup', TODAY, '09:30', '10:30', 60)];
    expect(hasPassedBlock(CURRENT, early, TODAY, NOW_MS, zone)).toBe(true);
    // Extending a block that began earlier only adds time after it: all of that is in the future.
    const extended = [study('sql1', TODAY, '09:00', '11:00', 120)];
    const before = [study('sql1', TODAY, '09:00', '10:30', 90)];
    expect(hasPassedBlock(before, extended, TODAY, Date.parse('2026-11-10T07:30:00Z'), zone)).toBe(
      false,
    ); // 09:30 now: 10:30-11:00 is added
    // The same extension flagged when the added part is already behind us (now 10:45).
    expect(hasPassedBlock(before, extended, TODAY, Date.parse('2026-11-10T08:45:00Z'), zone)).toBe(
      true,
    );
    // Another day, or another zone's date, is not compared.
    expect(hasPassedBlock(CURRENT, early, '2026-11-11', NOW_MS, zone)).toBe(false);
  });
});

function open(extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(
    planRoutes({
      [`GET ${BASE}/schedule`]: () => json(schedule({ blocks: CURRENT })),
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved, plan finish unchanged.'),
          proposed: { finishDate: '2026-11-20', warnings: [], blocks: PROPOSED },
        }),
      [`PUT ${BASE}/day-overrides/${TODAY}`]: async (request) => {
        const body = await request.json();
        saved.push(body);
        return json({ date: TODAY, ...body });
      },
      [`DELETE ${BASE}/day-overrides/${TODAY}`]: () => new Response(null, { status: 204 }),
      ...extra,
    }),
  );
  renderApp({ auth: fakeAuth(SESSION), path: '/' });
  return api;
}

const workAheadButton = () => screen.findByRole('button', { name: 'Work ahead' });
const bodyOf = async (call: Request | undefined) => (call ? await call.clone().json() : undefined);
const previewCall = (api: ReturnType<typeof open>) =>
  api.calls.find((c) => c.url.endsWith('/schedule/preview'));
const dayOff = {
  [`GET ${BASE}`]: () => json(planDetail({ overrides: [{ date: TODAY, isStudyDay: false }] })),
};

describe('Work ahead on Today', () => {
  it('previews first, saves only after approval, and shows the effect', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));

    expect(
      await screen.findByText(/Tomorrow’s first task, Set up accounts, now starts today\./),
    ).toBeInTheDocument();
    expect(await bodyOf(previewCall(api))).toEqual({
      today: TODAY,
      overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 9 }],
    });
    // Nothing is saved yet.
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Add 2 h to today' }));
    await waitFor(() => expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(saved).toEqual([{ isStudyDay: true, capacityHours: 9 }]);
    expect(
      await screen.findByText(/Today now has 8 h of study\. Tomorrow’s first task/),
    ).toBeInTheDocument();
  });

  it('cancelling the preview saves nothing', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 1 hour' }));
    await screen.findByText('What this would change');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('What this would change')).not.toBeInTheDocument();
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);
  });

  it('never saves by itself: opening the panel only reads', async () => {
    const api = open();
    await userEvent.setup().click(await workAheadButton());
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('explains that the study window is the limit and offers no approval when nothing fits', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('Nothing moved.'),
          proposed: { finishDate: '2026-11-20', warnings: [], blocks: CURRENT },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 3 hours' }));
    expect(await screen.findByText(/has no room for more today/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 3 h to today' })).toBeDisabled();
  });

  it('says when only part of the extra time fits', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved.'),
          proposed: {
            finishDate: '2026-11-20',
            warnings: [],
            blocks: [...CURRENT, study('setup', TODAY, '12:00', '12:30', 30)],
          },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    expect(
      await screen.findByText(/Only 0.5 h more fits in your study window/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 2 h to today' })).toBeEnabled();
  });

  it('on a day off offers "Make today a study day" with hours', async () => {
    const api = open(dayOff);
    const user = userEvent.setup();
    expect(await screen.findByText(/Today has its own setting: day off/)).toBeInTheDocument();
    await user.click(await workAheadButton());
    expect(screen.getByText('Today is not a study day')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add 1 hour' })).not.toBeInTheDocument();
    const hours = screen.getByRole('spinbutton', { name: 'Hours today' });
    await user.clear(hours);
    await user.type(hours, '4');
    await user.click(screen.getByRole('button', { name: 'Make today a study day' }));
    const heading = await screen.findByText('What this would change');
    expect(await bodyOf(previewCall(api))).toEqual({
      today: TODAY,
      overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 4 }],
    });
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);
    await user.click(
      within(heading.parentElement!).getByRole('button', { name: 'Make today a study day' }),
    );
    await waitFor(() => expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(saved).toEqual([{ isStudyDay: true, capacityHours: 4 }]);
  });

  it('asks for the hours before previewing', async () => {
    const api = open(dayOff);
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.clear(screen.getByRole('spinbutton', { name: 'Hours today' }));
    await user.click(screen.getByRole('button', { name: 'Make today a study day' }));
    expect(screen.getByText('Enter how many hours you want to study today.')).toBeInTheDocument();
    expect(previewCall(api)).toBeUndefined();
  });

  it('"Back to normal" removes today’s exception', async () => {
    const api = open({
      [`GET ${BASE}`]: () =>
        json(planDetail({ overrides: [{ date: TODAY, isStudyDay: true, capacityHours: 9 }] })),
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText(/Today has its own setting: study day, 9 h/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to normal' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/study day of 9 h/);
    expect(dialog).toHaveTextContent(/may have been set in Plan settings/);
    expect(api.count(`DELETE ${BASE}/day-overrides/${TODAY}`)).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.count(`DELETE ${BASE}/day-overrides/${TODAY}`)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Back to normal' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove the exception',
      }),
    );
    await waitFor(() => expect(api.count(`DELETE ${BASE}/day-overrides/${TODAY}`)).toBe(1));
    expect(
      await screen.findByText(/Back to normal: today follows your usual hours/),
    ).toBeInTheDocument();
  });

  it('has no Back to normal when today has no exception', async () => {
    open();
    await workAheadButton();
    expect(screen.queryByRole('button', { name: 'Back to normal' })).not.toBeInTheDocument();
  });

  it('is not offered once the day has ended', async () => {
    open({
      [`GET ${BASE}/days/${TODAY}`]: () =>
        json(
          dayState({
            status: 'ended',
            startedAt: NOW,
            endedAt: NOW,
            frozen: { frozenAt: NOW, source: 'day_end', blocks: [] },
          }),
        ),
    });
    await screen.findByText('Day ended');
    expect(screen.queryByRole('button', { name: 'Work ahead' })).not.toBeInTheDocument();
  });

  it('shows the API’s message when saving is refused', async () => {
    open({
      [`PUT ${BASE}/day-overrides/${TODAY}`]: () =>
        apiError(422, 'unprocessable', 'A plan can have at most 1000 day overrides.'),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 1 hour' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 h to today' }));
    expect(
      await screen.findByText('A plan can have at most 1000 day overrides.'),
    ).toBeInTheDocument();
  });

  it('names a day off in the Back to normal confirmation', async () => {
    open(dayOff);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Back to normal' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/a day off/);
  });

  it('reports the hours that really result, not the hours asked for', async () => {
    open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved.'),
          proposed: {
            finishDate: '2026-11-20',
            warnings: [],
            blocks: [...CURRENT, study('setup', TODAY, '12:00', '12:30', 30)],
          },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 h to today' }));
    expect(await screen.findByText(/Today now has 7\.5 h of study/)).toBeInTheDocument();
  });

  it('says part of the time has passed and offers no approval when new time starts before now', async () => {
    const api = open({
      [`POST ${BASE}/schedule/preview`]: () =>
        json({
          ...previewResult('1 task moved.'),
          proposed: {
            finishDate: '2026-11-20',
            warnings: [],
            blocks: [...CURRENT, study('setup', TODAY, '09:00', '10:00', 60)],
          },
        }),
    });
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 1 hour' }));
    expect(await screen.findByText(/Part of this time has already passed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 h to today' })).toBeDisabled();
    expect(api.count(`PUT ${BASE}/day-overrides/${TODAY}`)).toBe(0);
  });

  it('keeps one live region at a time, never nested', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    const section = () =>
      screen.getByRole('heading', { name: 'Work ahead', level: 2 }).closest('section')!;
    const live = () => Array.from(section().querySelectorAll('[aria-live], [role="status"]'));
    const check = () => {
      expect(live().length).toBeLessThanOrEqual(1);
      for (const el of live()) expect(el.querySelector('[aria-live], [role="status"]')).toBeNull();
    };
    check();
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    await screen.findByText('What this would change');
    check();
    expect(screen.getByText(/Preview ready/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add 2 h to today' }));
    await screen.findByText(/Today now has/);
    check();
    expect(live()).toHaveLength(1);
  });

  it('has no accessibility violations with the preview open', async () => {
    open();
    const user = userEvent.setup();
    await user.click(await workAheadButton());
    await user.click(screen.getByRole('button', { name: 'Add 2 hours' }));
    await screen.findByText('What this would change');
    await expectNoAxeViolations();
  });
});
