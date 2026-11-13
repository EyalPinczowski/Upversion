import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanSummary } from '../api/client';
import { dayRoutes } from '../test/day-fixtures';
import { expectNoAxeViolations } from '../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../test/helpers';
import { callsTo, usageBody } from '../test/builder-fixtures';
import { openTasks, PLAN_ID, planSummary } from '../test/plan-fixtures';
import { practiceRoutes, TASK_ID } from '../test/practice-fixtures';

const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const BANNER = /This plan is archived \(read-only\)\. You can look at it/;
const STORE = 'skillstack.plan';
const RESTORE = `POST /api/v1/plans/${PLAN_ID}/restore`;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const plansBody = (status: PlanSummary['status']) => ({
  'GET /api/v1/plans': () => json({ plans: [planSummary({ status })] }),
  'GET /api/v1/ai/usage': () => json(usageBody(true)),
});

describe('which plan opens by default', () => {
  const archivedNewest = planSummary({
    id: PLAN_ID,
    name: 'Archived newest',
    status: 'archived',
    createdAt: '2026-11-10T08:00:00.000Z',
  });
  const activeOlder = planSummary({
    id: OTHER_ID,
    name: 'Active older',
    status: 'active',
    createdAt: '2026-10-01T08:00:00.000Z',
  });

  it('opens the newest ACTIVE plan, not just the first in the list', async () => {
    installApi(
      dayRoutes({
        'GET /api/v1/plans': () => json({ plans: [archivedNewest, activeOlder] }),
        'GET /api/v1/ai/usage': () => json(usageBody(true)),
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Active older' })).toBeVisible();
    expect(screen.queryByText(/This plan is archived/)).toBeNull();
    const switcher = screen.getByLabelText('Plan');
    expect(switcher).toHaveValue(OTHER_ID);
    expect(
      within(switcher).getByRole('option', { name: 'Archived newest (Archived)' }),
    ).toBeVisible();
  });

  it('keeps a stored choice, even an archived plan, and falls back to the newest plan when none is active', async () => {
    window.localStorage.setItem(STORE, PLAN_ID);
    installApi(
      dayRoutes({ 'GET /api/v1/plans': () => json({ plans: [archivedNewest, activeOlder] }) }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Archived newest' })).toBeVisible();
  });

  it('falls back to the newest plan when nothing is active', async () => {
    installApi(
      dayRoutes({
        'GET /api/v1/plans': () =>
          json({ plans: [{ ...activeOlder, status: 'archived' }, archivedNewest] }),
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Archived newest' })).toBeVisible();
  });
});

describe('an archived plan is read-only', () => {
  it('Today: a banner, no start or end of the day, no log, done, skip or work-ahead controls', async () => {
    installApi(dayRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: '/' });
    expect(await screen.findByText(BANNER)).toBeVisible();
    await screen.findByRole('heading', { name: 'Today’s blocks' });
    for (const name of [
      /Start study day/,
      /Log time/,
      /Mark done/,
      /^Skip/,
      /Reopen/,
      /Work ahead|Add hours/,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // The blocks are still there to read.
    expect(screen.getAllByText('Intro to SQL').length).toBeGreaterThan(0);
  });

  it('Today, the same plan while active: the controls are there (so the test above means something)', async () => {
    installApi(dayRoutes(plansBody('active')));
    renderApp({ auth: fakeAuth(SESSION), path: '/' });
    expect(await screen.findByRole('button', { name: /Start study day/ })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /Log time/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/This plan is archived/)).toBeNull();
  });

  const skippedOpen = {
    [`GET /api/v1/plans/${PLAN_ID}/open-tasks`]: () =>
      json(
        openTasks({
          tasks: [
            {
              taskId: 'sql1',
              title: 'Intro to SQL',
              type: 'course',
              status: 'skipped',
              estHours: 3,
              doneHours: 1,
              remainingHours: 2,
              plannedDates: ['2026-11-09'],
              carriedOverFrom: ['2026-11-09'],
            },
          ],
        }),
      ),
  };

  it('Week: a banner and no Reopen on a skipped task (active plan: Reopen is there)', async () => {
    installApi(dayRoutes({ ...plansBody('active'), ...skippedOpen }));
    renderApp({ auth: fakeAuth(SESSION), path: '/week' });
    expect(await screen.findByRole('button', { name: /^Reopen/ })).toBeVisible();
  });

  it('Week: archived', async () => {
    installApi(dayRoutes({ ...plansBody('archived'), ...skippedOpen }));
    renderApp({ auth: fakeAuth(SESSION), path: '/week' });
    expect(await screen.findByText(BANNER)).toBeVisible();
    await screen.findByRole('heading', { name: 'Open tasks' });
    expect(screen.queryByRole('button', { name: /^Reopen/ })).toBeNull();
  });

  it('Plan: no Delete task buttons and no time settings form, but Delete this plan stays', async () => {
    installApi(dayRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByText(BANNER)).toBeVisible();
    await screen.findByRole('link', { name: 'Intro to SQL' });
    expect(screen.queryByRole('button', { name: /Delete task/ })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Plan settings' }));
    expect(await screen.findByText(/study time can’t be changed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
    expect(screen.getByText(/job description can’t be changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete this plan' })).toBeVisible();
    // Only one banner on the page (the settings sections do not repeat it).
    expect(screen.getAllByText(BANNER)).toHaveLength(1);
  });

  it('Plan, active: Delete task buttons are there', async () => {
    installApi(dayRoutes(plansBody('active')));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect((await screen.findAllByRole('button', { name: /Delete task/ })).length).toBeGreaterThan(
      0,
    );
  });

  it('task detail: no log, done or skip, no edit form, no delete', async () => {
    installApi(dayRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/sql1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Intro to SQL' })).toBeVisible();
    expect(screen.getByText(BANNER)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Log time|Mark done|^Skip/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Edit task' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete task/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Delete this task' })).toBeNull();
  });

  it('task detail, active: the edit form and the delete are there', async () => {
    installApi(dayRoutes(plansBody('active')));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/sql1' });
    expect(await screen.findByRole('heading', { name: 'Edit task' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Delete task/ })).toBeVisible();
  });

  it('review: no review form and no suggestions', async () => {
    installApi(dayRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: '/review/2026-11-10' });
    expect(await screen.findByText(/the review can’t be changed/)).toBeVisible();
    expect(screen.queryByRole('form', { name: 'End-of-day review' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save review|Update review/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Suggestions for your plan' })).toBeNull();
  });

  it('review, active: the form is there', async () => {
    installApi(dayRoutes(plansBody('active')));
    renderApp({ auth: fakeAuth(SESSION), path: '/review/2026-11-10' });
    expect(await screen.findByRole('form', { name: 'End-of-day review' })).toBeVisible();
  });

  it('practice: a new practice cannot be started', async () => {
    installApi(practiceRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: `/practice/${TASK_ID}` });
    expect(await screen.findByText(/a new practice can’t be started/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start practice' })).toBeNull();
  });

  it('practice, active: Start practice is there', async () => {
    installApi(practiceRoutes(plansBody('active')));
    renderApp({ auth: fakeAuth(SESSION), path: `/practice/${TASK_ID}` });
    expect(await screen.findByRole('button', { name: 'Start practice' })).toBeVisible();
  });

  it('a 409 plan_archived from the server is explained, not shown as a failure', async () => {
    // The plan list still says "active" (another device archived it a moment ago).
    installApi(
      dayRoutes({
        ...plansBody('active'),
        [`POST /api/v1/plans/${PLAN_ID}/tasks/sql1/complete`]: () =>
          apiError(409, 'plan_archived', 'This plan is archived.'),
        [`POST /api/v1/plans/${PLAN_ID}/tasks/sql1/skip`]: () =>
          apiError(409, 'plan_archived', 'This plan is archived.'),
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/sql1' });
    await userEvent.click(await screen.findByRole('button', { name: /Mark done/ }));
    expect(
      await screen.findByText(/This plan is archived \(read-only\), so nothing can be changed/),
    ).toBeVisible();
  });

  it('has no axe violations on an archived plan page', async () => {
    installApi(dayRoutes(plansBody('archived')));
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    await screen.findByText(BANNER);
    await screen.findByRole('link', { name: 'Intro to SQL' });
    await expectNoAxeViolations();
  });
});

describe('Restore this plan', () => {
  const archived = planSummary({
    id: PLAN_ID,
    name: 'Archived plan',
    status: 'archived',
    createdAt: '2026-10-01T08:00:00.000Z',
  });
  const active = planSummary({
    id: OTHER_ID,
    name: 'Current plan',
    status: 'active',
    createdAt: '2026-11-01T08:00:00.000Z',
  });

  function open(options: { plans?: PlanSummary[]; restore?: () => Response; flag?: boolean } = {}) {
    let plans = options.plans ?? [archived, active];
    const api = installApi(
      dayRoutes({
        'GET /api/v1/plans': () => json({ plans }),
        'GET /api/v1/ai/usage': () => json(usageBody(options.flag ?? true)),
        [RESTORE]:
          options.restore ??
          (() => {
            plans = plans.map((p) =>
              p.id === PLAN_ID
                ? { ...p, status: 'active' as const }
                : { ...p, status: 'archived' as const },
            );
            return json({ ...archived, status: 'active' });
          }),
      }),
    );
    window.localStorage.setItem(STORE, PLAN_ID);
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    return Object.assign(api, {
      setPlans: (next: PlanSummary[]) => {
        plans = next;
      },
    });
  }

  it('asks first, naming the plan that will be archived, then sends exactly its id and selects the restored plan', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore this plan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Current plan');
    expect(dialog).toHaveTextContent('will be archived');
    expect(dialog).toHaveTextContent('Archived plan');
    expect(dialog).toHaveTextContent('Tasks are rescheduled from today');
    expect(callsTo(api, RESTORE)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Restore it' }));
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/restore')),
      ).toHaveLength(1),
    );
    const call = api.calls.find((c) => c.url.endsWith('/restore'))!;
    expect(await call.clone().json()).toEqual({ replacesPlanIds: [OTHER_ID] });
    await waitFor(() => expect(screen.queryByText(/This plan is archived/)).toBeNull());
    expect(window.localStorage.getItem(STORE)).toBe(PLAN_ID);
    expect(await screen.findByRole('heading', { level: 2, name: 'Archived plan' })).toBeVisible();
  });

  it('with no active plan the dialog names only the restored plan and sends an empty list', async () => {
    const api = open({ plans: [archived] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore this plan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).not.toHaveTextContent('will be archived');
    await user.click(within(dialog).getByRole('button', { name: 'Restore it' }));
    await waitFor(() => expect(api.calls.some((c) => c.url.endsWith('/restore'))).toBe(true));
    const call = api.calls.find((c) => c.url.endsWith('/restore'))!;
    expect(await call.clone().json()).toEqual({ replacesPlanIds: [] });
  });

  it('cancel sends nothing', async () => {
    const api = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore this plan' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls.some((c) => c.url.endsWith('/restore'))).toBe(false);
  });

  it('active_plan_changed: re-reads the plans and shows the new names in the dialog', async () => {
    let first = true;
    const api = open({
      restore: () => {
        if (first) {
          first = false;
          api.setPlans([
            archived,
            { ...active, status: 'archived' },
            planSummary({
              id: '88888888-8888-4888-8888-888888888888',
              name: 'Imported meanwhile',
              status: 'active',
            }),
          ]);
          return apiError(409, 'active_plan_changed', 'x');
        }
        return json({ ...archived, status: 'active' });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore this plan' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore it' }),
    );
    expect(await screen.findByText(/Your active plans changed in the meantime/)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent('Imported meanwhile'),
    );
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent('Current plan');
  });

  it('plan_not_archived: explains and closes', async () => {
    open({ restore: () => apiError(409, 'plan_not_archived', 'x') });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Restore this plan' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore it' }),
    );
    expect(await screen.findByText(/no longer archived/)).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('is not offered when the plan builder is off (the route would answer 404)', async () => {
    open({ flag: false });
    expect(await screen.findByText(BANNER)).toBeVisible();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('button', { name: 'Restore this plan' })).toBeNull();
  });

  it('is not offered on an active plan', async () => {
    window.localStorage.setItem(STORE, OTHER_ID);
    installApi(
      dayRoutes({
        'GET /api/v1/plans': () => json({ plans: [archived, active] }),
        'GET /api/v1/ai/usage': () => json(usageBody(true)),
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    await screen.findByRole('heading', { level: 2, name: 'Current plan' });
    expect(screen.queryByRole('button', { name: 'Restore this plan' })).toBeNull();
  });
});
