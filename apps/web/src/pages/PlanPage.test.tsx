import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { apiError, fakeAuth, installApi, json, renderApp, SESSION } from '../test/helpers';
import {
  PLAN_ID,
  planDetail,
  planRoutes,
  planSummary,
  TASKS,
  taskView,
} from '../test/plan-fixtures';

afterEach(() => vi.unstubAllGlobals());

const BASE = `/api/v1/plans/${PLAN_ID}`;

function open(path: string, extra: Parameters<typeof planRoutes>[0] = {}) {
  const api = installApi(planRoutes(extra));
  renderApp({ auth: fakeAuth(SESSION), path });
  return api;
}

describe('Plan page', () => {
  it('lists every task with status, type chip, hours, dependencies and fixed time', async () => {
    open('/plan');
    await screen.findByRole('heading', { name: 'Courses' });
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const setup = within(rows[2]!);
    expect(setup.getByText('Admin')).toBeInTheDocument();
    expect(setup.getByText('Done')).toBeInTheDocument();
    expect(setup.getByText('0.5 h of 0.5 h')).toBeInTheDocument();

    const sql = within(rows[0]!);
    expect(sql.getByText('Course')).toBeInTheDocument();
    expect(sql.getByText('In progress')).toBeInTheDocument();
    expect(sql.getByText('After: Set up accounts')).toBeInTheDocument();

    const exam = within(rows[1]!);
    expect(exam.getByText('Exam')).toBeInTheDocument();
    expect(exam.getByText('Not started')).toBeInTheDocument();
    expect(exam.getByText('Fixed: Thu, Nov 19, 10:00')).toBeInTheDocument();
    expect(exam.getByText('After: Intro to SQL')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    open('/plan');
    await screen.findByRole('heading', { name: 'Demo plan' });
    await expectNoAxeViolations();
  });

  it('opens a task from the list', async () => {
    open('/plan');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Intro to SQL' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Intro to SQL' }),
    ).toBeInTheDocument();
  });

  it('shows a Retry when the tasks cannot be loaded', async () => {
    open('/plan', { [`GET ${BASE}/tasks`]: () => apiError(500, 'internal_error', 'boom') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
  });
});

describe('Task detail', () => {
  it('shows steps, notes, lessons and an external link that opens safely', async () => {
    open('/plan/sql1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Intro to SQL' }),
    ).toBeInTheDocument();
    const steps = within(screen.getByRole('heading', { name: 'How to do it' }).closest('section')!);
    expect(steps.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Create a free account',
      'Finish all lessons',
    ]);
    const notes = screen.getByRole('heading', { name: 'Notes' }).closest('section')!;
    expect(within(notes).getByText('Take notes as you go.')).toBeInTheDocument();
    expect(screen.getByText('Earns a certificate: SQL certificate.')).toBeInTheDocument();

    const course = screen.getByRole('link', { name: /Open the course page/ });
    expect(course).toHaveAttribute('href', 'https://example.test/sql');
    expect(course).toHaveAttribute('target', '_blank');
    expect(course).toHaveAttribute('rel', 'noopener noreferrer');

    const lesson = screen.getByRole('link', { name: /Select basics/ });
    expect(lesson).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/Needs check: confirm this link/)).toBeInTheDocument();
    // A lesson without a link is plain text.
    expect(screen.queryByRole('link', { name: /Joins/ })).not.toBeInTheDocument();
    expect(screen.getByText('Joins')).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('renders no link when the task has none, and never a javascript: link', async () => {
    open('/plan/exam', {
      [`GET ${BASE}/tasks`]: () =>
        json({
          tasks: [
            ...TASKS.slice(0, 2),
            taskView({
              id: 'exam',
              title: 'SQL exam',
              type: 'cert_exam',
              url: 'javascript:alert(1)',
              lessons: [{ title: 'Bad', url: 'javascript:alert(2)', needsCheck: false }],
            }),
          ],
        }),
    });
    await screen.findByRole('heading', { level: 1, name: 'SQL exam' });
    expect(screen.queryByRole('link', { name: /Open the course page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Bad/ })).not.toBeInTheDocument();
    const anchors = Array.from(document.querySelectorAll('a[href^="javascript"]'));
    expect(anchors).toHaveLength(0);
  });

  it('saves only the changed fields with PATCH', async () => {
    let body: unknown;
    const api = open('/plan/sql1', {
      [`PATCH ${BASE}/tasks/sql1`]: async (request) => {
        body = await request.json();
        return json(taskView({ title: 'SQL basics', estHours: 4 }));
      },
    });
    const user = userEvent.setup();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'SQL basics');
    const hours = screen.getByRole('spinbutton', { name: 'Estimated hours' });
    await user.clear(hours);
    await user.type(hours, '4');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(body).toEqual({ title: 'SQL basics', estHours: 4 });
    expect(api.count(`PATCH ${BASE}/tasks/sql1`)).toBe(1);
  });

  it('clears the notes with null', async () => {
    let body: unknown;
    open('/plan/sql1', {
      [`PATCH ${BASE}/tasks/sql1`]: async (request) => {
        body = await request.json();
        return json(taskView({ notes: undefined }));
      },
    });
    const user = userEvent.setup();
    await user.clear(await screen.findByRole('textbox', { name: 'Notes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(body).toEqual({ notes: null });
  });

  it('sends nothing when nothing changed', async () => {
    const api = open('/plan/sql1');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing has changed yet.');
    expect(api.count(`PATCH ${BASE}/tasks/sql1`)).toBe(0);
  });

  it('shows the API’s message when the edit is refused', async () => {
    open('/plan/sql1', {
      [`PATCH ${BASE}/tasks/sql1`]: () =>
        apiError(422, 'unprocessable', 'Dependencies must not form a loop.'),
    });
    const user = userEvent.setup();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.type(title, ' 2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dependencies must not form a loop.',
    );
  });

  it('says so when the task is not in the plan', async () => {
    open('/plan/missing');
    expect(await screen.findByRole('alert')).toHaveTextContent('This task is not in the plan.');
  });

  it('offers Reopen only for a done or skipped task, and only acts on click', async () => {
    const api = open('/plan/setup', {
      [`POST ${BASE}/tasks/setup/reopen`]: () => json(taskView({ id: 'setup' })),
    });
    const button = await screen.findByRole('button', { name: /Reopen/ });
    expect(api.count(`POST ${BASE}/tasks/setup/reopen`)).toBe(0);
    await userEvent.setup().click(button);
    await vi.waitFor(() => expect(api.count(`POST ${BASE}/tasks/setup/reopen`)).toBe(1));
  });
});

describe('Manage plans', () => {
  const NEW_ID = '33333333-3333-4333-8333-333333333333';

  function openWithDelete() {
    let deleted = false;
    const api = installApi(
      planRoutes({
        'GET /api/v1/plans': () => json({ plans: deleted ? [] : [planSummary()] }),
        [`DELETE ${BASE}`]: () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    return api;
  }

  it('deletes the plan only after confirmation, then shows the empty state', async () => {
    const api = openWithDelete();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/progress and the calendar events/i);
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(api.count(`DELETE ${BASE}`)).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByText(/No plan yet/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Plan deleted.');
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toHaveFocus();
    expect(api.count(`DELETE ${BASE}`)).toBe(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('cancelling the confirmation deletes nothing', async () => {
    const api = openWithDelete();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(screen.getByRole('button', { name: 'Keep this plan' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.count(`DELETE ${BASE}`)).toBe(0);
    expect(screen.getByRole('heading', { name: 'Demo plan' })).toBeInTheDocument();
  });

  it('shows an error and keeps the plan when the delete fails', async () => {
    open('/plan?tab=settings', {
      [`DELETE ${BASE}`]: () => apiError(500, 'internal_error', 'boom'),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The plan could not be deleted');
    expect(screen.getByRole('heading', { name: 'Demo plan' })).toBeInTheDocument();
  });

  const OTHER_ID = '44444444-4444-4444-8444-444444444444';
  function twoPlans(extra: Parameters<typeof planRoutes>[0] = {}) {
    let deleted = false;
    const api = installApi(
      planRoutes({
        'GET /api/v1/plans': () =>
          json({
            plans: deleted
              ? [planSummary({ id: OTHER_ID, name: 'Other plan' })]
              : [planSummary(), planSummary({ id: OTHER_ID, name: 'Other plan' })],
          }),
        [`GET /api/v1/plans/${OTHER_ID}/tasks`]: () => json({ tasks: [] }),
        [`GET /api/v1/plans/${OTHER_ID}`]: () =>
          json(planDetail({ id: OTHER_ID, name: 'Other plan' })),
        [`GET /api/v1/plans/${OTHER_ID}/practice/context`]: () =>
          json({ jobDescription: '', updatedAt: null }),
        [`DELETE ${BASE}`]: () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
        ...extra,
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    return api;
  }

  it('announces and focuses even when the plan list refetches slowly after the delete', async () => {
    let deleted = false;
    installApi(
      planRoutes({
        'GET /api/v1/plans': async () => {
          if (deleted) await new Promise((r) => setTimeout(r, 50));
          return json({ plans: deleted ? [] : [planSummary()] });
        },
        [`DELETE ${BASE}`]: () => {
          deleted = true;
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Plan deleted.');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('clears the announcement on the next action and announces a second delete again', async () => {
    const THIRD = '55555555-5555-4555-8555-555555555555';
    const remaining = [PLAN_ID, OTHER_ID, THIRD];
    const names: Record<string, string> = {
      [PLAN_ID]: 'Demo plan',
      [OTHER_ID]: 'Other plan',
      [THIRD]: 'Third plan',
    };
    const route = (id: string, delay = 0) => ({
      [`GET /api/v1/plans/${id}/tasks`]: () => json({ tasks: [] }),
      [`DELETE /api/v1/plans/${id}`]: async () => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        remaining.splice(remaining.indexOf(id), 1);
        return new Response(null, { status: 204 });
      },
    });
    installApi(
      planRoutes({
        'GET /api/v1/plans': () =>
          json({ plans: remaining.map((id) => planSummary({ id, name: names[id]! })) }),
        ...route(OTHER_ID, 100),
        ...route(THIRD),
        [`DELETE ${BASE}`]: () => {
          remaining.splice(remaining.indexOf(PLAN_ID), 1);
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Plan deleted.');
    await screen.findByRole('heading', { name: 'Other plan' });
    // Starting another delete clears the old announcement while it runs.
    await user.click(screen.getByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Plan deleted.'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });

  it('does not bring an old delete error back when returning to that plan', async () => {
    twoPlans({ [`DELETE ${BASE}`]: () => apiError(500, 'internal_error', 'boom') });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    await screen.findByRole('alert');
    const picker = screen.getByRole('combobox', { name: 'Plan' });
    await user.selectOptions(picker, OTHER_ID);
    await screen.findByRole('heading', { name: 'Other plan' });
    await user.selectOptions(picker, PLAN_ID);
    await screen.findByRole('heading', { name: 'Demo plan' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says a lost connection may or may not have deleted the plan', async () => {
    open('/plan?tab=settings', {
      [`DELETE ${BASE}`]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been deleted');
  });

  it('after deleting one of two plans the page shows the remaining one', async () => {
    twoPlans();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('heading', { name: 'Other plan' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Demo plan' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Plan deleted.');
  });

  it('a delete error does not carry over to another plan', async () => {
    twoPlans({ [`DELETE ${BASE}`]: () => apiError(500, 'internal_error', 'boom') });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete this plan' }));
    await user.click(await screen.findByRole('button', { name: 'Delete plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The plan could not be deleted');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan' }), OTHER_ID);
    expect(await screen.findByRole('heading', { name: 'Other plan' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('imports another plan from the disclosure and selects it', async () => {
    let imported = false;
    const bodies: Record<string, unknown>[] = [];
    installApi(
      planRoutes({
        'GET /api/v1/plans': () =>
          json({
            plans: imported
              ? [planSummary(), planSummary({ id: NEW_ID, name: 'Second plan' })]
              : [planSummary()],
          }),
        'POST /api/v1/plans/import': async (request) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          imported = true;
          return json(planDetail({ id: NEW_ID, name: 'Second plan' }), 201);
        },
        [`GET /api/v1/plans/${NEW_ID}/tasks`]: () => json({ tasks: [] }),
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan?tab=settings' });
    const user = userEvent.setup();
    const summary = await screen.findByText('Import another plan');
    expect(screen.getByRole('textbox', { name: /paste the plan json/i })).not.toBeVisible();
    await user.click(summary);
    await user.click(screen.getByRole('textbox', { name: /paste the plan json/i }));
    await user.paste(JSON.stringify({ formatVersion: 1, name: 'Second plan', tasks: [] }));
    await user.click(screen.getByRole('button', { name: 'Import plan' }));
    expect(await screen.findByRole('heading', { name: 'Second plan' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveValue(NEW_ID);
    expect(bodies).toHaveLength(1);
  });
});

describe('Delete a task', () => {
  /** A stateful stand-in for the API: a task with dependents answers 409 unless told to remove. */
  function withDelete() {
    let tasks = TASKS;
    const seen: string[] = [];
    const api = installApi(
      planRoutes({
        [`GET ${BASE}/tasks`]: () => json({ tasks }),
        [`DELETE ${BASE}/tasks/setup`]: (request) => {
          seen.push(new URL(request.url).search);
          const remove = new URL(request.url).searchParams.get('removeDependencies') === 'true';
          if (!remove) {
            return json(
              {
                error: {
                  code: 'has_dependents',
                  message: 'Other tasks depend on this task.',
                  requestId: 'req-1',
                  dependents: [{ id: 'sql1', title: 'Intro to SQL' }],
                },
              },
              409,
            );
          }
          tasks = tasks.filter((t) => t.id !== 'setup');
          return new Response(null, { status: 204 });
        },
        [`DELETE ${BASE}/tasks/exam`]: () => {
          tasks = tasks.filter((t) => t.id !== 'exam');
          return new Response(null, { status: 204 });
        },
      }),
    );
    return { api, seen };
  }

  it('deletes a task from the plan list only after confirmation, then announces it', async () => {
    const { api } = withDelete();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(dialog).toHaveTextContent(/practice sessions/i);
    expect(api.count(`DELETE ${BASE}/tasks/exam`)).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'SQL exam' })).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Task deleted.');
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toHaveFocus();
    expect(api.count(`DELETE ${BASE}/tasks/exam`)).toBe(1);
  });

  it('cancelling deletes nothing', async () => {
    const { api } = withDelete();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await user.click(screen.getByRole('button', { name: 'Keep this task' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.count(`DELETE ${BASE}/tasks/exam`)).toBe(0);
  });

  it('lists the dependent tasks on 409 and deletes only after the second confirmation', async () => {
    const { api, seen } = withDelete();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: Set up accounts' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete task' }),
    );
    const dialog = await screen.findByText(/These tasks come after this one/);
    const box = dialog.closest('[role="alertdialog"]') as HTMLElement;
    expect(within(box).getByText('Intro to SQL')).toBeInTheDocument();
    expect(api.count(`DELETE ${BASE}/tasks/setup`)).toBe(1);
    expect(seen).toEqual(['']);
    await user.click(within(box).getByRole('button', { name: 'Delete and remove the dependency' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Set up accounts' })).toBeNull());
    expect(seen).toEqual(['', '?removeDependencies=true']);
    expect(screen.getByRole('status')).toHaveTextContent('Task deleted.');
  });

  it('shows an error and keeps the task when the delete fails', async () => {
    open('/plan', { [`DELETE ${BASE}/tasks/exam`]: () => apiError(500, 'internal_error', 'boom') });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete task' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.getByRole('link', { name: 'SQL exam' })).toBeInTheDocument();
  });

  it('on the task page: deletes, returns to the plan and focuses the heading', async () => {
    const { api } = withDelete();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/exam' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete task' }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Task deleted.');
    expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toHaveFocus();
    expect(screen.queryByRole('link', { name: 'SQL exam' })).not.toBeInTheDocument();
    expect(api.count(`DELETE ${BASE}/tasks/exam`)).toBe(1);
  });

  it('still announces and focuses the heading when the list refetch after the delete is slow', async () => {
    let tasks = TASKS;
    installApi(
      planRoutes({
        [`GET ${BASE}/tasks`]: async () => {
          const snapshot = tasks;
          if (snapshot.length < TASKS.length) await new Promise((r) => setTimeout(r, 50));
          return json({ tasks: snapshot });
        },
        [`DELETE ${BASE}/tasks/exam`]: () => {
          tasks = tasks.filter((t) => t.id !== 'exam');
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete task' }),
    );
    // The row is gone from the list while the refetch is still running.
    await waitFor(() => expect(screen.queryByRole('link', { name: 'SQL exam' })).toBeNull());
    expect(await screen.findByText('Task deleted.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Plan' })).toHaveFocus(),
    );
  });

  it('does not pull the person back to the plan when they left the task page before the delete finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    installApi(
      planRoutes({
        [`DELETE ${BASE}/tasks/exam`]: async () => {
          await gate;
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/exam' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete task' }),
    );
    await user.click(screen.getByRole('link', { name: /Settings/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Plan' })).toBeNull();
  });

  it('has no accessibility violations with the dialog open', async () => {
    withDelete();
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Delete task: SQL exam' }));
    await screen.findByRole('alertdialog');
    await expectNoAxeViolations();
  });
});
