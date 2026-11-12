import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as navigate from '../../lib/navigate';
import { expectNoAxeViolations } from '../../test/axe';
import { fakeAuth, json, renderApp, SESSION } from '../../test/helpers';
import { installSetupApi, profileCalls, profileView } from '../../test/setup-fixtures';

const redirect = vi.spyOn(navigate, 'redirectTo').mockImplementation(() => {});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  redirect.mockClear();
});

const open = (path = '/setup', welcome: 'seen' | 'first-visit' = 'seen') =>
  renderApp({ auth: fakeAuth(SESSION), path, welcome });

const click = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name }));
const heading = () => screen.getByRole('heading', { level: 2 });
const nextStep = () => click(/^(Next|Skip)$/);

async function start() {
  await click('Start setup');
  await screen.findByRole('heading', { name: 'Question 1 of 8' });
}

/** Presses Next/Skip until the heading matches. Question 1 needs an answer first. */
async function passQuestions(count: number) {
  for (let i = 0; i < count; i++) await nextStep();
}

describe('the setup wizard', () => {
  it('starts at the welcome step and shows the first question after Start', async () => {
    const api = installSetupApi();
    open();
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    await start();
    expect(screen.getByRole('group', { name: /current situation/i })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 10')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    const calls = await profileCalls(api);
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      path: '/api/v1/me/profile/setup',
      body: { status: 'in_progress', step: 'q:current_status' },
    });
  });

  it('blocks Next on a required question, and only on that screen', async () => {
    const api = installSetupApi();
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await nextStep();
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an answer to continue.');
    expect(screen.getByRole('heading', { name: 'Question 1 of 8' })).toBeInTheDocument();
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/answers'))).toBe(false);

    await userEvent.click(screen.getByRole('radio', { name: 'Working full-time' }));
    await nextStep();
    expect(await screen.findByRole('heading', { name: 'Question 2 of 8' })).toBeInTheDocument();
    expect((await profileCalls(api)).find((c) => c.path.endsWith('/answers'))?.body).toEqual({
      answers: { current_status: 'employed' },
    });
  });

  it('lets optional questions be skipped and never blocks on the role and skill questions', async () => {
    const api = installSetupApi();
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await userEvent.click(screen.getByRole('radio', { name: 'Studying' }));
    await nextStep();
    // 2 education, 3 tools: optional, unanswered, so the button says Skip.
    expect(await screen.findByRole('heading', { name: 'Question 2 of 8' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    await passQuestions(2);
    // 4 days and 5 hours come pre-filled with their defaults.
    expect(await screen.findByRole('heading', { name: 'Question 4 of 8' })).toBeInTheDocument();
    await passQuestions(2);
    await screen.findByRole('heading', { name: 'Question 6 of 8' });
    await passQuestions(1);
    // 7 target_role and 8 target_skills: required in the plan builder, optional in setup.
    expect(await screen.findByRole('heading', { name: 'Question 7 of 8' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    await nextStep();
    expect(await screen.findByRole('heading', { name: 'Question 8 of 8' })).toBeInTheDocument();
    await nextStep();
    expect(await screen.findByRole('heading', { name: 'Your CV (optional)' })).toBeInTheDocument();

    const saved = (await profileCalls(api))
      .filter((c) => c.path.endsWith('/answers'))
      .map((c) => c.body);
    expect(saved).toEqual([
      { answers: { current_status: 'student' } },
      { answers: { days_per_week: [0, 1, 2, 3, 4] } },
      { answers: { hours_per_day: 3 } },
    ]);
  });

  it('shows the hours hint for full-time workers and the max for roles', async () => {
    installSetupApi({ profile: profileView({ answers: { current_status: 'employed' } }) });
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await nextStep();
    await passQuestions(3);
    await screen.findByRole('heading', { name: 'Question 5 of 8' });
    expect(screen.getByText(/Most people working full-time manage 1–2 hours/)).toBeInTheDocument();
  });

  it('takes choices only: no text box on any question screen, and role picks stop at 2', async () => {
    installSetupApi({ profile: profileView({ answers: { current_status: 'employed' } }) });
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    for (let i = 0; i < 6; i++) {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      await nextStep();
      await screen.findByRole('heading', { name: `Question ${i + 2} of 8` });
    }
    const roles = screen.getAllByRole('checkbox');
    for (const box of roles.slice(0, 3)) await userEvent.click(box);
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(2);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await nextStep();
    await screen.findByRole('heading', { name: 'Question 8 of 8' });
    // The question bank's "You can type ones that aren't listed" is not true in setup.
    expect(screen.queryByText(/You can type/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('resumes at the saved step with the saved answers filled in', async () => {
    installSetupApi({
      profile: profileView({
        setupStatus: 'in_progress',
        setupStep: 'q:time_of_day',
        answers: { time_of_day: 'evening' },
      }),
    });
    open();
    expect(await screen.findByRole('heading', { name: 'Question 6 of 8' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Evening' })).toBeChecked();
  });

  it('resumes the CV review at the CV step, because the text is gone after a reload', async () => {
    installSetupApi({
      profile: profileView({ setupStatus: 'in_progress', setupStep: 'review' }),
    });
    open();
    expect(await screen.findByRole('heading', { name: 'Your CV (optional)' })).toBeInTheDocument();
  });

  it('Back goes to the previous screen without losing the answer', async () => {
    installSetupApi();
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await userEvent.click(screen.getByRole('radio', { name: 'Looking for a job' }));
    await nextStep();
    await screen.findByRole('heading', { name: 'Question 2 of 8' });
    await click('Back');
    expect(await screen.findByRole('radio', { name: 'Looking for a job' })).toBeChecked();
  });

  it('skips the whole setup at any step: status dismissed, then the home page', async () => {
    const api = installSetupApi();
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/setup', onLocation: (u) => urls.push(u) });
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await userEvent.click(screen.getByRole('radio', { name: 'Studying' }));
    await nextStep();
    await screen.findByRole('heading', { name: 'Question 2 of 8' });
    await click('Skip setup for now');
    await waitFor(() => expect(urls.at(-1)).toBe('/'));
    expect((await profileCalls(api)).at(-1)).toEqual({
      method: 'PATCH',
      path: '/api/v1/me/profile/setup',
      body: { status: 'dismissed', step: 'q:education' },
    });
  });

  it('can also be skipped from the welcome screen', async () => {
    const api = installSetupApi();
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await click('Skip for now');
    await waitFor(async () =>
      expect((await profileCalls(api)).at(-1)?.body).toEqual({
        status: 'dismissed',
        step: 'welcome',
      }),
    );
  });

  it('says so and stays put when saving fails', async () => {
    installSetupApi({
      extra: {
        'PATCH /api/v1/me/profile/setup': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await click('Start setup');
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t save that');
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
  });

  it('ends on the done step with a summary, a Change button per answer, and status completed', async () => {
    const api = installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: { status: 'disconnected' },
    });
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await passQuestions(8);
    await click('Skip this step');
    expect(await screen.findByRole('heading', { name: 'Calendar (optional)' })).toBeInTheDocument();
    await click('Skip for now');
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeInTheDocument();
    expect((await profileCalls(api)).at(-1)?.body).toEqual({ status: 'completed', step: 'done' });
    expect(screen.getByText('Studying')).toBeInTheDocument();
    expect(screen.getByText('3 hours')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Change: Which days can you study/ }));
    expect(await screen.findByRole('heading', { name: 'Question 4 of 8' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Friday' }));
    await click('Save');
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeInTheDocument();
    expect(
      screen.getByText(/Sunday, Monday, Tuesday, Wednesday, Thursday, Friday/),
    ).toBeInTheDocument();
  });

  it('moves focus to the step heading on every step change', async () => {
    installSetupApi();
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await waitFor(() => expect(heading()).toHaveFocus());
    expect(heading()).toHaveTextContent('Question 1 of 8');
    // One announcement only: the focused heading, described by the question (no live region).
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(heading()).toHaveAccessibleDescription(/What's your current situation/);
  });

  it('passes axe on every step', async () => {
    installSetupApi({
      profile: profileView({ answers: { current_status: 'employed' } }),
      calendar: { status: 'disconnected' },
    });
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await expectNoAxeViolations();
    await start();
    for (let i = 1; i <= 8; i++) {
      await expectNoAxeViolations();
      await nextStep();
      if (i < 8) await screen.findByRole('heading', { name: `Question ${i + 1} of 8` });
    }
    await screen.findByRole('heading', { name: 'Your CV (optional)' });
    await userEvent.click(screen.getByRole('button', { name: 'Paste text instead' }));
    await expectNoAxeViolations();
    await click('Skip this step');
    await screen.findByRole('heading', { name: 'Calendar (optional)' });
    await expectNoAxeViolations();
    await click('Skip for now');
    await screen.findByRole('heading', { name: 'Setup complete' });
    await expectNoAxeViolations();
  });
});

describe('the calendar step', () => {
  async function toCalendar(api: ReturnType<typeof installSetupApi>) {
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await passQuestions(8);
    await click('Skip this step');
    return api;
  }

  it('is skipped entirely when the calendar feature is off', async () => {
    const api = installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: 404,
    });
    await toCalendar(api);
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeInTheDocument();
    expect(screen.queryByText('Calendar (optional)')).not.toBeInTheDocument();
  });

  it('reuses the connect flow and leaves a return path to /setup in sessionStorage', async () => {
    const api = installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: { status: 'disconnected' },
      extra: {
        'POST /api/v1/calendar/connect': () =>
          new Response(
            JSON.stringify({ authorizationUrl: 'https://accounts.google.com/o/oauth2/x' }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
      },
    });
    await toCalendar(api);
    await screen.findByRole('heading', { name: 'Calendar (optional)' });
    await click('Connect Google Calendar');
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/x'),
    );
    expect(window.sessionStorage.getItem('upversion.calendar-return')).toBe('/setup');
  });

  it('shows Continue when already connected', async () => {
    const api = installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: { status: 'connected' },
    });
    await toCalendar(api);
    expect(await screen.findByText('Google Calendar is connected.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Connect Google Calendar' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('is where the person lands again after the callback ("Continue setup")', async () => {
    window.sessionStorage.setItem('upversion.calendar-return', '/setup');
    installSetupApi({
      profile: profileView({ setupStatus: 'in_progress', setupStep: 'calendar' }),
      calendar: { status: 'connected' },
      extra: {
        'POST /api/v1/calendar/callback': () =>
          new Response(
            JSON.stringify({
              status: 'connected',
              lastSyncedAt: null,
              lastErrorCode: null,
              sources: [],
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
      },
    });
    const urls: string[] = [];
    window.history.replaceState(null, '', '/calendar/callback?code=c&state=s');
    renderApp({
      auth: fakeAuth(SESSION),
      path: '/calendar/callback?code=c&state=s',
      onLocation: (u) => urls.push(u),
    });
    const link = await screen.findByRole('link', { name: 'Continue setup' });
    expect(link).toHaveAttribute('href', '/setup');
    expect(window.sessionStorage.getItem('upversion.calendar-return')).toBeNull();
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Calendar (optional)' })).toBeInTheDocument();
  });
});

describe('feature visibility and the first-run redirect', () => {
  it('hides the wizard when the profile API answers 404: /setup goes home, no Settings entry', async () => {
    installSetupApi({ profile: 404 });
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/setup', onLocation: (u) => urls.push(u) });
    await waitFor(() => expect(urls.at(-1)).toBe('/'));
    expect(screen.queryByRole('heading', { name: 'Welcome' })).not.toBeInTheDocument();
  });

  it('shows no Settings entry when the feature is off', async () => {
    const api = installSetupApi({ profile: 404 });
    open('/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() => expect(api.count('GET /api/v1/me/profile')).toBe(1));
    expect(screen.queryByRole('region', { name: 'Profile setup' })).not.toBeInTheDocument();
  });

  it('sends a new user with no plan, not started, who has seen the welcome, to /setup once', async () => {
    installSetupApi();
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/', onLocation: (u) => urls.push(u) });
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(urls).toContain('/setup');
  });

  it('waits for the welcome dialog: no redirect on top of it, redirect after it is closed', async () => {
    installSetupApi();
    const urls: string[] = [];
    open('/', 'first-visit');
    renderApp({
      auth: fakeAuth(SESSION),
      path: '/',
      welcome: 'first-visit',
      onLocation: (u) => urls.push(u),
    });
    const dialog = await screen.findAllByRole('dialog', { name: 'Welcome to Upversion' });
    expect(dialog.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(urls).not.toContain('/setup');
    await userEvent.click(within(dialog.at(-1)!).getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(urls).toContain('/setup'));
  });

  it.each([
    ['has a plan', { plans: true, profile: profileView() }],
    ['dismissed the setup', { profile: profileView({ setupStatus: 'dismissed' }) }],
    ['completed the setup', { profile: profileView({ setupStatus: 'completed' }) }],
    ['stopped midway', { profile: profileView({ setupStatus: 'in_progress', setupStep: 'cv' }) }],
  ])('never redirects a person who %s', async (_name, options) => {
    const api = installSetupApi(options);
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/', onLocation: (u) => urls.push(u) });
    await waitFor(() => expect(api.count('GET /api/v1/me/profile')).toBe(1));
    await waitFor(() => expect(api.count('GET /api/v1/plans')).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(urls.every((u) => u === '/')).toBe(true);
  });

  it('does not redirect while the plan list failed to load', async () => {
    installSetupApi({
      extra: { 'GET /api/v1/plans': () => new Response('{}', { status: 500 }) },
    });
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/', onLocation: (u) => urls.push(u) });
    await new Promise((r) => setTimeout(r, 100));
    expect(urls.every((u) => u === '/')).toBe(true);
  });
});

describe('Settings > App > Profile setup', () => {
  it('offers "Set up your profile" before the first run and goes to /setup', async () => {
    installSetupApi({ plans: true });
    const urls: string[] = [];
    renderApp({ auth: fakeAuth(SESSION), path: '/settings', onLocation: (u) => urls.push(u) });
    const region = await screen.findByRole('region', { name: 'Profile setup' });
    await userEvent.click(within(region).getByRole('button', { name: 'Set up your profile' }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(urls.at(-1)).toBe('/setup');
  });

  it('offers "Finish setup" midway and "Run setup again" afterwards, which sets in_progress', async () => {
    const api = installSetupApi({
      plans: true,
      profile: profileView({ setupStatus: 'completed' }),
    });
    open('/settings');
    const region = await screen.findByRole('region', { name: 'Profile setup' });
    await userEvent.click(within(region).getByRole('button', { name: 'Run setup again' }));
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect((await profileCalls(api)).at(-1)?.body).toEqual({
      status: 'in_progress',
      step: 'welcome',
    });
  });

  it('clears the profile after a confirmation and shows the status as dismissed', async () => {
    const api = installSetupApi({
      plans: true,
      profile: profileView({ setupStatus: 'completed', answers: { current_status: 'student' } }),
    });
    open('/settings');
    const region = await screen.findByRole('region', { name: 'Profile setup' });
    await userEvent.click(within(region).getByRole('button', { name: 'Clear my profile' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear my profile' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(await screen.findByText(/You skipped the setup/)).toBeInTheDocument();
  });

  it('passes axe', async () => {
    installSetupApi({ plans: true });
    open('/settings');
    await screen.findByRole('region', { name: 'Profile setup' });
    await expectNoAxeViolations();
  });
});

describe('chunking', () => {
  it('keeps the wizard and pdf.js out of the entry code: both are loaded lazily', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const app = read('../../App.tsx');
    expect(app).toMatch(/lazy\(\(\) =>\s*import\('\.\/pages\/setup\/SetupPage'\)/);
    expect(app).not.toMatch(/^import .*pages\/setup\/SetupPage/m);
    const extract = read('./cv-extract.ts');
    expect(extract).not.toMatch(/^import .*pdfjs-dist/m);
    expect(extract).toMatch(/import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/);
    // The redirect in the shell is tiny and must not pull the wizard in.
    expect(read('./SetupRedirect.tsx')).not.toMatch(/SetupPage|cv-extract|pdfjs/);
  });
});

describe('saving problems and cleanup', () => {
  const failFirstCompletion = () => {
    let failed = false;
    return async (request: Request) => {
      const body = (await request.clone().json()) as { status: string; step?: string };
      if (body.status === 'completed' && !failed) {
        failed = true;
        throw new TypeError('Failed to fetch');
      }
      return json(
        profileView({ setupStatus: body.status as 'in_progress', setupStep: body.step ?? null }),
      );
    };
  };

  async function toCalendarStep() {
    open();
    await screen.findByRole('heading', { name: 'Welcome' });
    await start();
    await passQuestions(8);
    await click('Skip this step');
  }

  it('shows an alert with Retry when finishing the calendar step cannot be saved', async () => {
    installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: { status: 'disconnected' },
      extra: { 'PATCH /api/v1/me/profile/setup': failFirstCompletion() },
    });
    await toCalendarStep();
    await screen.findByRole('heading', { name: 'Calendar (optional)' });
    await click('Skip for now');
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t save that');
    await click('Retry');
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeInTheDocument();
  });

  it('does not sit on "Checking your calendar…" when the calendar is off and saving fails', async () => {
    installSetupApi({
      profile: profileView({ answers: { current_status: 'student' } }),
      calendar: 404,
      extra: { 'PATCH /api/v1/me/profile/setup': failFirstCompletion() },
    });
    await toCalendarStep();
    expect(await screen.findByText('Calendar sync is not available yet.')).toBeInTheDocument();
    expect(screen.queryByText('Checking your calendar…')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await click('Continue');
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeInTheDocument();
  });

  it('clears a saved list answer when everything is unticked and the person presses Skip', async () => {
    const api = installSetupApi({
      profile: profileView({
        setupStatus: 'in_progress',
        setupStep: 'q:tools_known',
        answers: { current_status: 'student', tools_known: ['Excel', 'SQL'] },
      }),
    });
    open();
    await screen.findByRole('heading', { name: 'Question 3 of 8' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Excel' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'SQL' }));
    await click('Skip');
    await screen.findByRole('heading', { name: 'Question 4 of 8' });
    const saved = (await profileCalls(api)).filter((c) => c.path.endsWith('/answers'));
    expect(saved.at(-1)?.body).toEqual({ answers: { tools_known: [] } });
    expect(api.state.profile?.answers.tools_known).toEqual([]);
  });

  it('does not send anything for an untouched optional question', async () => {
    const api = installSetupApi({
      profile: profileView({
        setupStatus: 'in_progress',
        setupStep: 'q:tools_known',
        answers: { current_status: 'student' },
      }),
    });
    open();
    await screen.findByRole('heading', { name: 'Question 3 of 8' });
    await click('Skip');
    await screen.findByRole('heading', { name: 'Question 4 of 8' });
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/answers'))).toBe(false);
  });
});

describe('the calendar return path', () => {
  it('is cleared by a connect from Settings, so no "Continue setup" is offered later', async () => {
    window.sessionStorage.setItem('upversion.calendar-return', '/setup');
    installSetupApi({
      plans: true,
      calendar: { status: 'disconnected' },
      extra: {
        'POST /api/v1/calendar/connect': () =>
          json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/x' }),
      },
    });
    open('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() => expect(redirect).toHaveBeenCalled());
    expect(window.sessionStorage.getItem('upversion.calendar-return')).toBeNull();
  });
});

describe('Settings entry details', () => {
  it('hides "Clear my profile" before the setup has started', async () => {
    installSetupApi({ plans: true });
    open('/settings');
    const region = await screen.findByRole('region', { name: 'Profile setup' });
    expect(
      within(region).queryByRole('button', { name: 'Clear my profile' }),
    ).not.toBeInTheDocument();
  });
});
