import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildPlanBody, BuildRequestBody, PlanSummary } from '../../api/client';
import { resetFirstRunMemory } from '../../lib/first-run';
import { expectNoAxeViolations } from '../../test/axe';
import { draft, NEW_PLAN_ID, plan, usageBody } from '../../test/builder-fixtures';
import { apiError, fakeAuth, json, meBody, renderApp, SESSION } from '../../test/helpers';
import { installSetupApi, profileCalls, profileView } from '../../test/setup-fixtures';

const PREVIEW = 'POST /api/v1/plans/build/preview';
const BUILD = 'POST /api/v1/plans/build';
const WAIT = { timeout: 4000 };

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetFirstRunMemory();
  user = userEvent.setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(
  options: {
    profile?: Parameters<typeof profileView>[0] | 404;
    plans?: PlanSummary[];
    builder?: boolean;
    path?: string;
    welcome?: 'seen' | 'first-visit';
    extra?: Record<string, (request: Request) => Response | Promise<Response>>;
  } = {},
  onLocation?: (url: string) => void,
) {
  let plans = options.plans ?? [];
  const api = installSetupApi({
    profile: options.profile === 404 ? 404 : profileView(options.profile),
    extra: {
      'GET /api/v1/me': () => json(meBody()),
      'GET /api/v1/ai/usage': () => json(usageBody(options.builder ?? true)),
      'GET /api/v1/plans': () => json({ plans }),
      [PREVIEW]: () => json(draft()),
      [BUILD]: () => {
        const created = plan({ id: NEW_PLAN_ID, name: 'Operations plan' });
        plans = [created];
        return json(created, 201);
      },
      ...options.extra,
    },
  });
  renderApp({
    auth: fakeAuth(SESSION),
    path: options.path ?? '/',
    welcome: options.welcome,
    onLocation,
  });
  return api;
}

const heading = (name: string) => screen.findByRole('heading', { level: 2, name });
const next = () => user.click(screen.getByRole('button', { name: 'Next' }));
const back = () => user.click(screen.getByRole('button', { name: 'Back' }));
const calls = (api: { calls: Request[] }, key: string) =>
  api.calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key);

async function pickRole(title = 'Operations Associate / Analyst') {
  await user.click(await screen.findByRole('checkbox', { name: title }));
}

describe('the first run', () => {
  it('sends a new person with no plan to the four screens, with no welcome dialog', async () => {
    const seen: string[] = [];
    open({ welcome: 'first-visit' }, (u) => seen.push(u));
    expect(await heading('What are you aiming for?')).toBeInTheDocument();
    expect(seen.at(-1)).toBe('/start');
    expect(screen.getByText('Step 1 of 4: What are you aiming for?')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.queryByRole('dialog', { name: 'Welcome to Upversion' })).toBeNull();
  });

  it('walks goal, where you are now, time and money, and the draft, then starts the plan on Today', async () => {
    const seen: string[] = [];
    const api = open({}, (u) => seen.push(u));
    await heading('What are you aiming for?');
    await pickRole();
    await next();

    await heading('Where are you now?');
    expect(screen.getByText('Step 2 of 4: Where are you now?')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Excel & spreadsheets'), '2');
    await next();

    await heading('How much time and money?');
    await user.click(screen.getByRole('button', { name: '8 weeks' }));
    const hours = screen.getByLabelText('Hours per study day');
    await user.clear(hours);
    await user.type(hours, '2');
    await user.click(
      screen.getByRole('radio', { name: 'Flexible – whatever gives the best result' }),
    );
    await next();

    await heading('Your draft plan');
    expect(screen.getByText('Step 4 of 4: Your draft plan')).toBeInTheDocument();
    await waitFor(() => expect(calls(api, PREVIEW).length).toBeGreaterThan(0), WAIT);
    const sent = (await calls(api, PREVIEW)[0]!.clone().json()) as BuildRequestBody;
    expect(sent.targetRoleIds).toEqual(['operations-associate']);
    expect(sent.skillLevels?.['excel']).toBe(2);
    expect(sent.weekPattern.defaultHours).toBe(2);
    expect(sent.budget.mode).toBe('flexible');

    const start = screen.getByRole('button', { name: 'Start this plan' });
    await waitFor(() => expect(start).toBeEnabled(), WAIT);
    await user.click(start);
    await waitFor(() => expect(seen.at(-1)).toBe('/'), WAIT);
    const built = (await calls(api, BUILD)[0]!.clone().json()) as BuildPlanBody;
    expect(built.replacesPlanIds).toEqual([]);
    expect(built.request.targetRoleIds).toEqual(['operations-associate']);

    // The answers of screens 1 and 3 are saved, and the first run is marked finished.
    const saved = (await profileCalls(api)).filter((c) => c.path.endsWith('/answers'));
    expect(saved.map((c) => (c.body as { answers: object }).answers)).toEqual([
      { target_role: ['operations-associate'], target_skills: [] },
      { days_per_week: [0, 1, 2, 3, 4], hours_per_day: 2, time_of_day: 'flexible' },
    ]);
    await waitFor(async () => {
      const setup = (await profileCalls(api)).filter((c) => c.path.endsWith('/setup'));
      expect((setup.at(-1)!.body as { status: string }).status).toBe('completed');
    });
  });

  it('keeps the choices on Back and Forward and keeps the step in the address', async () => {
    const seen: string[] = [];
    open({}, (u) => seen.push(u));
    await heading('What are you aiming for?');
    await pickRole();
    await next();
    const second = await heading('Where are you now?');
    expect(seen.at(-1)).toBe('/start?step=2');
    await waitFor(() => expect(second).toHaveFocus());
    await back();
    await heading('What are you aiming for?');
    expect(seen.at(-1)).toBe('/start?step=1');
    expect(screen.getByRole('checkbox', { name: 'Operations Associate / Analyst' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await next();
    await heading('Where are you now?');
  });

  it('asks for a role before screen 2 and allows at most two', async () => {
    open();
    await heading('What are you aiming for?');
    await next();
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose at least one role.');
    expect(screen.getByText('Step 1 of 4: What are you aiming for?')).toBeInTheDocument();
  });

  it('does not open a later screen by address while the role is missing', async () => {
    open({ path: '/start?step=3' });
    await heading('What are you aiming for?');
  });

  it('resumes at the saved screen with the saved answers', async () => {
    open({
      profile: {
        setupStatus: 'in_progress',
        setupStep: 'fr:3',
        answers: { target_role: ['operations-associate'], hours_per_day: 2 },
      },
    });
    await heading('How much time and money?');
    expect(screen.getByLabelText('Hours per study day')).toHaveValue(2);
    await back();
    await heading('Where are you now?');
    await back();
    await heading('What are you aiming for?');
    expect(screen.getByRole('checkbox', { name: 'Operations Associate / Analyst' })).toBeChecked();
  });

  it('saves the step so a reload resumes there', async () => {
    const api = open();
    await heading('What are you aiming for?');
    await pickRole();
    await next();
    await heading('Where are you now?');
    const setup = (await profileCalls(api)).filter((c) => c.path.endsWith('/setup'));
    expect(setup.at(-1)!.body).toEqual({ status: 'in_progress', step: 'fr:2' });
  });

  it('suggests 3 or 4 roles for "Not sure" and lets the person tick one', async () => {
    open();
    await heading('What are you aiming for?');
    await user.click(screen.getByText('Not sure which role? Help me choose'));
    await user.click(screen.getByRole('checkbox', { name: 'Finding answers in data and numbers' }));
    await user.click(screen.getByRole('button', { name: 'Suggest roles' }));
    const group = await screen.findByRole('group', { name: /These roles could fit/ });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    expect(boxes.length).toBeLessThanOrEqual(4);
    await user.click(within(group).getByRole('checkbox', { name: 'Junior Data / BI Analyst' }));
    // The same role in the main list is ticked too.
    for (const box of screen.getAllByRole('checkbox', { name: 'Junior Data / BI Analyst' })) {
      expect(box).toBeChecked();
    }
    await next();
    await heading('Where are you now?');
  });

  it('shows the CV pre-fill on screen 2 only', async () => {
    open();
    await heading('What are you aiming for?');
    expect(screen.queryByRole('button', { name: 'Pre-fill from my CV' })).toBeNull();
    await pickRole();
    await next();
    await heading('Where are you now?');
    expect(screen.getByRole('button', { name: 'Pre-fill from my CV' })).toBeVisible();
  });

  it('does not block the plan when saving the answers fails', async () => {
    const api = open({
      extra: {
        'PUT /api/v1/me/profile/answers': () => apiError(500, 'internal', 'Something went wrong.'),
      },
    });
    await heading('What are you aiming for?');
    await pickRole();
    await next();
    await heading('Where are you now?');
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t save your answers/);
    expect(calls(api, PREVIEW)).toHaveLength(0);
  });

  it('works with no profile API: nothing is saved and the plan can still be built', async () => {
    const seen: string[] = [];
    const api = open({ profile: 404 }, (u) => seen.push(u));
    await heading('What are you aiming for?');
    await pickRole();
    await next();
    await heading('Where are you now?');
    expect(screen.queryByRole('button', { name: 'Pre-fill from my CV' })).toBeNull();
    await next();
    await heading('How much time and money?');
    await next();
    await heading('Your draft plan');
    const start = screen.getByRole('button', { name: 'Start this plan' });
    await waitFor(() => expect(start).toBeEnabled(), WAIT);
    await user.click(start);
    await waitFor(() => expect(seen.at(-1)).toBe('/'), WAIT);
    expect((await profileCalls(api)).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('has no accessibility violations on any screen', async () => {
    const api = open();
    await heading('What are you aiming for?');
    await expectNoAxeViolations(document.body);
    await pickRole();
    await next();
    await heading('Where are you now?');
    await expectNoAxeViolations(document.body);
    await next();
    await heading('How much time and money?');
    await expectNoAxeViolations(document.body);
    await next();
    await heading('Your draft plan');
    await waitFor(() => expect(calls(api, PREVIEW).length).toBeGreaterThan(0), WAIT);
    await screen.findByRole('button', { name: 'Start this plan' });
    await expectNoAxeViolations(document.body);
  });
});

describe('who gets the first run', () => {
  it('skips it for a person who already has a plan, and the address /start goes to Today', async () => {
    const seen: string[] = [];
    open({ plans: [plan()], path: '/start' }, (u) => seen.push(u));
    await waitFor(() => expect(seen.at(-1)).toBe('/'), WAIT);
    expect(screen.queryByText(/Step 1 of 4/)).toBeNull();
  });

  it('does not redirect a person who skipped it, and Skip for now remembers that', async () => {
    const seen: string[] = [];
    const api = open({}, (u) => seen.push(u));
    await heading('What are you aiming for?');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(seen.at(-1)).toBe('/'), WAIT);
    const setup = (await profileCalls(api)).filter((c) => c.path.endsWith('/setup'));
    expect((setup.at(-1)!.body as { status: string }).status).toBe('dismissed');
    // Stays on Today: no bounce back to the first run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.at(-1)).toBe('/');
  });

  it('does not redirect when the profile says setup was finished or skipped before', async () => {
    const seen: string[] = [];
    open({ profile: { setupStatus: 'completed' } }, (u) => seen.push(u));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.every((u) => u === '/')).toBe(true);
  });

  it('with the plan builder off, falls back to the setup wizard (profile on) and never opens /start', async () => {
    const seen: string[] = [];
    open({ builder: false, welcome: 'seen' }, (u) => seen.push(u));
    await waitFor(() => expect(seen.at(-1)).toBe('/setup'), WAIT);
    expect(await heading('Welcome')).toBeInTheDocument();
  });

  it('with the plan builder off, /start leads to the setup wizard, never a dead end', async () => {
    const seen: string[] = [];
    open({ builder: false, path: '/start' }, (u) => seen.push(u));
    await waitFor(() => expect(seen.at(-1)).toBe('/setup'), WAIT);
  });

  it('with the plan builder and the profile both off, /start leads to Today', async () => {
    const seen: string[] = [];
    open({ builder: false, profile: 404, path: '/start' }, (u) => seen.push(u));
    await waitFor(() => expect(seen.at(-1)).toBe('/'), WAIT);
  });

  it('the welcome dialog still opens for a person with a plan who has not seen it', async () => {
    open({ plans: [plan()], welcome: 'first-visit' });
    expect(await screen.findByRole('dialog', { name: 'Welcome to Upversion' })).toBeVisible();
  });
});
