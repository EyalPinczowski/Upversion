import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuth, installApi, json, meBody, renderApp, SESSION } from '../../test/helpers';
import {
  hasSeenWelcome,
  resolveTourSteps,
  TOUR_STEPS,
  resetWelcomeMemory,
} from '../../lib/welcome';

beforeEach(() => {
  window.localStorage.clear();
  resetWelcomeMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(path = '/') {
  installApi({ 'GET /api/v1/me': () => json(meBody()) });
  return renderApp({ auth: fakeAuth(SESSION), path, welcome: 'first-visit' });
}

const announcement = () => screen.getByText(/^Step \d+ of \d+: /);
const welcome = () => screen.findByRole('dialog', { name: 'Welcome to Upversion' });

describe('first-visit welcome', () => {
  it('shows on the first visit with the key messages and two buttons', async () => {
    open();
    const dialog = within(await welcome());
    expect(dialog.getByRole('button', { name: 'Take the guide' })).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    expect(dialog.getByText(/suggestions until you approve/i)).toBeInTheDocument();
    expect(dialog.getByText(/never marks a task done/i)).toBeInTheDocument();
    expect(dialog.getByText(/AI is optional/i)).toBeInTheDocument();
    expect(dialog.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(dialog.getAllByRole('listitem').length).toBeLessThanOrEqual(5);
  });

  it('shows once: Skip marks it seen and a second visit stays quiet', async () => {
    const first = open();
    await userEvent.click(within(await welcome()).getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hasSeenWelcome(SESSION.userId)).toBe(true);
    first.unmount();

    installApi({ 'GET /api/v1/me': () => json(meBody()) });
    renderApp({ auth: fakeAuth(SESSION), path: '/', welcome: 'seen' });
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is remembered per user, in storage', async () => {
    open();
    await userEvent.click(within(await welcome()).getByRole('button', { name: 'Skip for now' }));
    expect(window.localStorage.getItem(`upversion.welcome-seen.${SESSION.userId}`)).toBe('1');
    expect(hasSeenWelcome('22222222-2222-4222-8222-222222222222')).toBe(false);
  });

  it('Escape closes it and counts as seen', async () => {
    open();
    await welcome();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hasSeenWelcome(SESSION.userId)).toBe(true);
  });

  it('is labelled, modal, and keeps Tab inside', async () => {
    open();
    const dialog = await welcome();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const skip = screen.getByRole('button', { name: 'Skip for now' });
    const take = screen.getByRole('button', { name: 'Take the guide' });
    expect(skip).toHaveFocus();
    await userEvent.tab();
    expect(take).toHaveFocus();
    await userEvent.tab();
    expect(skip).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(take).toHaveFocus();
  });

  it('still works when storage throws: seen for this visit only', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open();
    await userEvent.click(within(await welcome()).getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hasSeenWelcome(SESSION.userId)).toBe(true);
  });
});

describe('guided tour', () => {
  async function startTour() {
    open();
    await userEvent.click(within(await welcome()).getByRole('button', { name: 'Take the guide' }));
    return screen.findByRole('dialog', { name: 'Today' });
  }

  it('starts from "Take the guide", closes the welcome and marks it seen', async () => {
    const card = await startTour();
    expect(screen.queryByRole('dialog', { name: 'Welcome to Upversion' })).not.toBeInTheDocument();
    expect(card).toHaveAttribute('aria-modal', 'false');
    expect(card).toHaveFocus();
    expect(hasSeenWelcome(SESSION.userId)).toBe(true);
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('data-tour-active');
  });

  it('walks Today, Week, Plan, Settings with Next and Back, skipping steps whose target is missing', async () => {
    await startTour();
    const status = announcement();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Step 1 of 4: Today');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(status).toHaveTextContent('Step 2 of 4: Week');
    expect(screen.getByRole('link', { name: 'Week' })).toHaveAttribute('data-tour-active');
    expect(screen.getByRole('link', { name: 'Today' })).not.toHaveAttribute('data-tour-active');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(status).toHaveTextContent('Step 3 of 4: Plan');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Curriculum and Plan settings are not on the screen: skipped.
    expect(status).toHaveTextContent('Step 4 of 4: Settings');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(status).toHaveTextContent('Step 3 of 4: Plan');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tour-active]')).toBeNull();
  });

  it('is operable with the keyboard and keeps focus on Next across steps', async () => {
    await startTour();
    await userEvent.tab(); // Back is disabled, so Next
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(announcement()).toHaveTextContent('Step 2 of 4: Week');
    expect(next).toHaveFocus();
  });

  it('Close and Escape end the tour and clear the highlight', async () => {
    await startTour();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tour-active]')).toBeNull();
  });

  it('Escape ends the tour', async () => {
    await startTour();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not trap the page: the rest of the app stays reachable', async () => {
    await startTour();
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Today' })).toBeInTheDocument();
  });

  it('resolveTourSteps keeps only steps with a target, whatever the data says', () => {
    document.body.innerHTML = '<a id="here" href="#">x</a>';
    const steps = [
      { id: 'a', title: 'A', body: '', targets: ['#missing', '#here'] },
      { id: 'b', title: 'B', body: '', targets: ['#missing'] },
    ];
    expect(resolveTourSteps(steps).map((s) => s.id)).toEqual(['a']);
    document.body.innerHTML = '';
    expect(resolveTourSteps(TOUR_STEPS)).toEqual([]);
  });

  it('includes the plan tabs when they exist on the screen', () => {
    document.body.innerHTML =
      '<nav aria-label="Main"><a href="/">T</a></nav><button data-tour="plan-curriculum">C</button><button data-tour="plan-settings">S</button>';
    expect(resolveTourSteps().map((s) => s.id)).toEqual([
      'today',
      'plan-curriculum',
      'plan-settings',
    ]);
    document.body.innerHTML = '';
  });
});

describe('where the welcome does not show', () => {
  it('stays away from the calendar callback page', async () => {
    open('/calendar/callback');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('dialog', { name: 'Welcome to Upversion' })).not.toBeInTheDocument();
  });

  it.each(['/signin', '/terms', '/privacy', '/disclaimer'])('stays away from %s', async (path) => {
    installApi({ 'GET /api/v1/me': () => json(meBody()) });
    renderApp({ auth: fakeAuth(null), path, welcome: 'first-visit' });
    await screen.findByRole('main');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('show it again from Settings', () => {
  it('reopens the welcome after it was seen, and returns focus to the button', async () => {
    installApi({ 'GET /api/v1/me': () => json(meBody()) });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings', welcome: 'seen' });
    const help = within(await screen.findByRole('region', { name: 'Help' }));
    const button = help.getByRole('button', { name: 'Show the welcome guide again' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(button);
    await welcome();
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
