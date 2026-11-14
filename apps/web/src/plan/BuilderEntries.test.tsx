import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBuilderApi, plan, usageBody } from '../test/builder-fixtures';
import { fakeAuth, json, renderApp, SESSION } from '../test/helpers';
import { planRoutes } from '../test/plan-fixtures';
import { installSetupApi, profileView } from '../test/setup-fixtures';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the entries to the plan builder', () => {
  it('shows "Build a plan" on an empty Plan page and "Build a new plan" in the header when the flag is on', async () => {
    installBuilderApi({ flag: true, plans: [] });
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByText(/No plan yet/)).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Build a plan' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Build a new plan' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Build a plan' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Build a plan' })).toBeVisible();
  });

  it('shows the header entry on a Plan page with a plan', async () => {
    installBuilderApi({ flag: true, plans: [plan()], extra: planRoutes() });
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByRole('button', { name: 'Build a new plan' })).toBeVisible();
  });

  it('hides every entry when the flag is off', async () => {
    installBuilderApi({ flag: false, plans: [] });
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByText(/No plan yet/)).toBeVisible();
    // Wait until the flag has been read, so "not there" is not just "not loaded yet".
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByRole('button', { name: /Build a/ })).toBeNull();
  });

  it('hides the entries when the usage request fails', async () => {
    installBuilderApi({
      plans: [],
      extra: { 'GET /api/v1/ai/usage': () => json({ error: { code: 'x', message: 'x' } }, 500) },
    });
    renderApp({ auth: fakeAuth(SESSION), path: '/plan' });
    expect(await screen.findByText(/No plan yet/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Build a/ })).toBeNull();
  });

  it('turns /plan/new into the Plan page when the flag is off', async () => {
    const onLocation = vi.fn();
    installBuilderApi({ flag: false, plans: [] });
    renderApp({ auth: fakeAuth(SESSION), path: '/plan/new', onLocation });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Build a plan' })).toBeNull();
    await waitFor(() => expect(onLocation).toHaveBeenLastCalledWith('/plan'));
  });

  describe('the setup Done step', () => {
    async function finishSetup(flag: boolean) {
      installSetupApi({
        profile: profileView({ answers: { current_status: 'student' } }),
        calendar: { status: 'disconnected' },
        extra: { 'GET /api/v1/ai/usage': () => json(usageBody(flag)) },
      });
      renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
      const press = (name: string | RegExp) =>
        userEvent.click(screen.getByRole('button', { name }));
      await screen.findByRole('heading', { name: 'Welcome' });
      await press('Start setup');
      await screen.findByRole('heading', { name: 'Question 1 of 8' });
      for (let i = 0; i < 8; i++) await press(/^(Next|Skip)$/);
      await press('Skip this step');
      await screen.findByRole('heading', { name: 'Calendar (optional)' });
      await press('Skip for now');
      await screen.findByRole('heading', { name: 'Setup complete' });
    }

    it('offers "Build my first plan" when the flag is on, and it opens the builder', async () => {
      await finishSetup(true);
      await userEvent.click(await screen.findByRole('button', { name: 'Build my first plan' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Build a plan' })).toBeVisible();
    });

    it('does not offer it when the flag is off', async () => {
      await finishSetup(false);
      expect(screen.getByRole('link', { name: 'Go to Today' })).toBeVisible();
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.queryByRole('button', { name: 'Build my first plan' })).toBeNull();
    });
  });
});
