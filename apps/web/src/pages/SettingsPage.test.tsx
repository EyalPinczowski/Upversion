import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import {
  apiError,
  ENV,
  fakeAuth,
  installApi,
  json,
  meBody,
  renderApp,
  SESSION,
} from '../test/helpers';
import { planRoutes } from '../test/plan-fixtures';

const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:fake');
const revokeObjectURL = vi.fn();
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

let scrollSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  clickSpy.mockClear();
  vi.unstubAllGlobals();
  scrollSpy?.mockRestore();
  scrollSpy = undefined;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function open(
  routes: Parameters<typeof installApi>[0] = {},
  auth = fakeAuth(SESSION),
  appEnv: 'operational' | 'rnd' = 'operational',
) {
  const api = installApi({ 'GET /api/v1/me': () => json(meBody()), ...routes });
  renderApp({ auth, path: '/settings', env: { ...ENV, appEnv } });
  return { api, auth };
}

const deleteButton = () => screen.getByRole('button', { name: 'Delete my account' });
const confirmBox = () =>
  screen.getByRole('textbox', { name: /Type .delete my account. to confirm/ });

describe('settings page', () => {
  it('shows the signed-in email and the account sections', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    for (const name of ['Profile', 'Appearance', 'Your data', 'Sign out', 'Delete my account']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 2, name: 'App' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  it('has only App and Connections groups, and nothing that belongs to a plan', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.getByRole('heading', { level: 2, name: 'App' })).toBeInTheDocument();
    for (const name of ['Study time', 'Practice', 'Start date', 'Subjects', 'Manage plans']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
  });

  it('shows Connections with the calendar when the calendar feature is on', async () => {
    open({
      'GET /api/v1/calendar': () =>
        json({ status: 'disconnected', lastSyncedAt: null, lastErrorCode: null, sources: [] }),
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Connections' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('hides Connections when the calendar feature is off', async () => {
    open({ 'GET /api/v1/calendar': () => apiError(404, 'not_found', 'off') });
    await screen.findByRole('heading', { level: 2, name: 'App' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('heading', { name: 'Connections' })).not.toBeInTheDocument();
  });

  it.each(['#time-heading', '#practice-heading', '#start-date-heading'])(
    'sends the old anchor %s to the Plan settings tab',
    async (hash) => {
      // jsdom has no scrollIntoView; define it so it can be spied on (removed in afterEach).
      Element.prototype.scrollIntoView = () => {};
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
      scrollSpy = scroll;
      installApi(planRoutes());
      const urls: string[] = [];
      renderApp({
        auth: fakeAuth(SESSION),
        path: `/settings${hash}`,
        onLocation: (url) => urls.push(url),
      });
      expect(await screen.findByRole('tab', { name: 'Plan settings' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(await screen.findByRole('heading', { name: 'Study time' })).toBeInTheDocument();
      // The hash stays, and the page scrolls to the section once it has rendered.
      expect(urls[urls.length - 1]).toBe(`/plan?tab=settings${hash}`);
      const target = await waitFor(() => {
        const el = document.getElementById(hash.slice(1));
        expect(el).toHaveFocus();
        return el;
      });
      expect(scroll).toHaveBeenCalled();
      expect(scroll.mock.contexts[0]).toBe(target);
    },
  );

  it('does not redirect a visit to /settings without an old anchor', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  describe('display name', () => {
    it('saves the trimmed name with PATCH /me and confirms it', async () => {
      let body: unknown;
      open({
        'PATCH /api/v1/me': async (request) => {
          body = await request.json();
          return json(meBody({ displayName: 'Dana' }));
        },
      });
      const user = userEvent.setup();
      await user.type(await screen.findByRole('textbox', { name: /Display name/ }), '  Dana ');
      await user.click(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByText('Saved.')).toBeInTheDocument();
      expect(body).toEqual({ displayName: 'Dana' });
      expect(screen.getByRole('textbox', { name: /Display name/ })).toHaveValue('Dana');
    });

    it('clears the name by sending null when the field is emptied', async () => {
      let body: unknown;
      open({
        'GET /api/v1/me': () => json(meBody({ displayName: 'Dana' })),
        'PATCH /api/v1/me': async (request) => {
          body = await request.json();
          return json(meBody());
        },
      });
      const user = userEvent.setup();
      await user.clear(await screen.findByDisplayValue('Dana'));
      await user.click(screen.getByRole('button', { name: 'Save name' }));
      await screen.findByText('Saved.');
      expect(body).toEqual({ displayName: null });
    });

    it('does not send a name longer than 80 characters', async () => {
      const { api } = open();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('textbox', { name: /Display name/ }));
      await user.paste('x'.repeat(81));
      await user.click(screen.getByRole('button', { name: 'Save name' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Use at most 80 characters.');
      expect(api.count('PATCH /api/v1/me')).toBe(0);
    });

    it('shows an error and keeps the typed name when the server refuses', async () => {
      open({ 'PATCH /api/v1/me': () => apiError(400, 'validation_error', 'Bad shape.') });
      const user = userEvent.setup();
      await user.type(await screen.findByRole('textbox', { name: /Display name/ }), 'Dana');
      await user.click(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t save that name');
      expect(screen.getByRole('textbox', { name: /Display name/ })).toHaveValue('Dana');
    });
  });

  describe('theme', () => {
    it('follows the device by default and can be overridden and reset', async () => {
      open();
      const user = userEvent.setup();
      expect(await screen.findByRole('radio', { name: 'Follow my device' })).toBeChecked();
      expect(document.documentElement).not.toHaveAttribute('data-theme');

      await user.click(screen.getByRole('radio', { name: 'Dark' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(window.localStorage.getItem('upversion.theme')).toBe('dark');

      await user.click(screen.getByRole('radio', { name: 'Light' }));
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');

      await user.click(screen.getByRole('radio', { name: 'Follow my device' }));
      expect(document.documentElement).not.toHaveAttribute('data-theme');
      expect(window.localStorage.getItem('upversion.theme')).toBeNull();
    });
  });

  describe('export my data', () => {
    it('downloads the API response as a JSON file', async () => {
      const exported = { exportedAt: '2026-01-01T00:00:00.000Z', formatVersion: 1, plans: [] };
      const { api } = open({ 'GET /api/v1/me/export': () => json(exported) });
      await userEvent.click(await screen.findByRole('button', { name: 'Export my data' }));
      expect(await screen.findByText('Your export was downloaded.')).toBeInTheDocument();
      expect(api.count('GET /api/v1/me/export')).toBe(1);
      expect(clickSpy).toHaveBeenCalledOnce();
      const link = clickSpy.mock.contexts[0] as HTMLAnchorElement;
      expect(link.download).toBe('upversion-export.json');
      const blob = createObjectURL.mock.calls[0]![0];
      expect(blob.type).toBe('application/json');
      expect(JSON.parse(await blob.text())).toEqual(exported);
    });

    it('says so, and downloads nothing, when the export fails', async () => {
      open({ 'GET /api/v1/me/export': () => apiError(500, 'internal_error', 'x') });
      await userEvent.click(await screen.findByRole('button', { name: 'Export my data' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t prepare your export');
      expect(clickSpy).not.toHaveBeenCalled();
      expect(screen.queryByText('Your export was downloaded.')).not.toBeInTheDocument();
    });
  });

  describe('sign out', () => {
    it('signs out of this device', async () => {
      const { auth } = open();
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
      expect(auth.signOut).toHaveBeenCalledExactlyOnceWith('local');
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    });

    it('signs out of all devices with the global scope', async () => {
      const { auth } = open();
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out of all devices' }));
      expect(auth.signOut).toHaveBeenCalledExactlyOnceWith('global');
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    });

    it('stays signed in and says so when signing out everywhere fails', async () => {
      const auth = fakeAuth(SESSION);
      auth.signOut.mockRejectedValueOnce(new Error('offline'));
      open({}, auth);
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out of all devices' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'We couldn’t sign you out everywhere',
      );
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    });
  });

  describe('delete my account', () => {
    it('is disabled until the exact phrase is typed', async () => {
      open();
      const user = userEvent.setup();
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      expect(deleteButton()).toBeDisabled();

      for (const wrong of [
        'delete',
        'delete my acount',
        'Delete my account',
        'DELETE MY ACCOUNT',
        'delete  my account',
        'please delete my account',
      ]) {
        await user.clear(confirmBox());
        await user.type(confirmBox(), wrong);
        expect(deleteButton(), wrong).toBeDisabled();
      }

      await user.clear(confirmBox());
      await user.type(confirmBox(), 'delete my account');
      expect(deleteButton()).toBeEnabled();
    });

    it('says the sign-in record is deleted on the live app', async () => {
      open();
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      const section = screen.getByRole('region', { name: 'Delete my account' });
      expect(section).toHaveTextContent('and sign-in record (your email)');
      expect(section).not.toHaveTextContent('R&D test account');
    });

    it('says on R&D that the sign-in record stays because it is shared with the live app', async () => {
      open({}, fakeAuth(SESSION), 'rnd');
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      const section = screen.getByRole('region', { name: 'Delete my account' });
      expect(section).toHaveTextContent(
        'R&D test account: your sign-in record stays because it is shared with the live app.',
      );
      expect(section).not.toHaveTextContent('and sign-in record (your email)');
    });

    it('turns off phone autocorrection and capitalisation for the phrase', async () => {
      open();
      await screen.findByRole('heading', { level: 1, name: 'Settings' });
      expect(confirmBox()).toHaveAttribute('autocapitalize', 'none');
      expect(confirmBox()).toHaveAttribute('autocorrect', 'off');
      expect(confirmBox()).toHaveAttribute('spellcheck', 'false');
    });

    it('does not call the API when the form is submitted with a wrong phrase', async () => {
      const { api } = open({ 'DELETE /api/v1/me': () => new Response(null, { status: 204 }) });
      const user = userEvent.setup();
      await user.type(
        await screen.findByRole('textbox', { name: /Type .delete/ }),
        'delete my accountt{Enter}',
      );
      expect(api.count('DELETE /api/v1/me')).toBe(0);
    });

    it('sends the phrase, then signs out, clears the session and shows the sign-in page', async () => {
      let body: unknown;
      const { auth } = open({
        'DELETE /api/v1/me': async (request) => {
          body = await request.json();
          return new Response(null, { status: 204 });
        },
      });
      const user = userEvent.setup();
      await user.type(
        await screen.findByRole('textbox', { name: /Type .delete/ }),
        ' delete my account ',
      );
      await user.click(deleteButton());
      expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
      expect(body).toEqual({ confirmation: 'delete my account' });
      expect(auth.signOut).toHaveBeenCalledExactlyOnceWith('local');
      expect(screen.getByText('Your account was deleted.')).toBeInTheDocument();
      expect(screen.queryByText('dana@example.com')).not.toBeInTheDocument();
    });

    it('keeps the account and the session, and says so, when deletion fails', async () => {
      const { auth } = open({ 'DELETE /api/v1/me': () => apiError(500, 'internal_error', 'x') });
      const user = userEvent.setup();
      await user.type(
        await screen.findByRole('textbox', { name: /Type .delete/ }),
        'delete my account',
      );
      await user.click(deleteButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t delete the account');
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    });

    it('reports a lost connection while deleting as such', async () => {
      open({
        'DELETE /api/v1/me': () => {
          throw new TypeError('Failed to fetch');
        },
      });
      const user = userEvent.setup();
      await user.type(
        await screen.findByRole('textbox', { name: /Type .delete/ }),
        'delete my account',
      );
      await user.click(deleteButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('Can’t reach the server');
      await waitFor(() => expect(deleteButton()).toBeEnabled());
    });
  });

  it('has no automatically detectable accessibility violations', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await expectNoAxeViolations();
  });
});
