import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFirstRunMemory } from '../../lib/first-run';
import { usageBody } from '../../test/builder-fixtures';
import { CV_TEXT, FORBIDDEN } from '../../test/cv-fixture';
import { fakeAuth, json, meBody, renderApp, SESSION } from '../../test/helpers';
import {
  everythingSent,
  findLeak,
  restoreSideChannels,
  spyOnSideChannels,
  webStorageDump,
} from '../../test/privacy-harness';
import { installSetupApi, profileCalls, profileView } from '../../test/setup-fixtures';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetFirstRunMemory();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreSideChannels();
});

describe('first run, screen 2: the CV never leaves the browser', () => {
  it('sends only the confirmed allowlist, shows the levels, and keeps nothing in storage', async () => {
    const indexedDB = { open: vi.fn() };
    const caches = { open: vi.fn(), match: vi.fn(), has: vi.fn() };
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('caches', caches);
    const side = spyOnSideChannels();
    const api = installSetupApi({
      profile: profileView({ answers: { target_role: ['operations-associate'] } }),
      extra: {
        'GET /api/v1/me': () => json(meBody()),
        'GET /api/v1/ai/usage': () => json(usageBody(true)),
      },
    });
    renderApp({ auth: fakeAuth(SESSION), path: '/start?step=2' });
    await screen.findByRole('heading', { level: 2, name: 'Where are you now?' });
    const excelRow = () => screen.getByLabelText('Excel & spreadsheets').closest('li')!;
    expect(within(excelRow()).getByText(/not rated/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Pre-fill from my CV' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Paste text instead' }));
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste(CV_TEXT);
    await userEvent.click(screen.getByRole('button', { name: 'Read this text' }));
    await screen.findByRole('button', { name: 'Save these to my profile' });
    // Nothing is sent before the person confirms.
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/import'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Save these to my profile' }));

    // Back on screen 2 with the levels from the CV, labelled as such.
    expect(await screen.findByText(/Your levels below now include/)).toBeVisible();
    expect(within(excelRow()).getByText(/from your CV/)).toBeVisible();

    const sent = (await everythingSent(api)).toLowerCase();
    for (const secret of FORBIDDEN) expect(sent).not.toContain(secret.toLowerCase());
    for (let i = 0; i + 30 <= CV_TEXT.length; i++) {
      expect(sent).not.toContain(CV_TEXT.slice(i, i + 30).toLowerCase());
    }
    const imports = (await profileCalls(api)).filter((c) => c.path.endsWith('/import'));
    expect(imports).toHaveLength(1);
    expect(Object.keys(imports[0]!.body as object).sort()).toEqual([
      'education',
      'rolesHeld',
      'skills',
      'tools',
      'yearsExperience',
    ]);

    expect(findLeak(webStorageDump())).toBeNull();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
    expect(findLeak(side.logged.join('\n'))).toBeNull();
    expect(side.beacon).not.toHaveBeenCalled();
    expect(side.xhr).toEqual([]);
    expect(side.images).toEqual([]);
    expect(side.sockets).toEqual([]);
    expect(side.errors).toEqual([]);
    expect(document.body.textContent).not.toContain('CANARY');
  });
});
