import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cvTextSession } from '../../cv/cv-text-session';
import { expectNoAxeViolations } from '../../test/axe';
import { CV_LINES, CV_TEXT, FORBIDDEN } from '../../test/cv-fixture';
import { buildDocx } from '../../test/docx-fixture';
import { fakeAuth, json, renderApp, SESSION } from '../../test/helpers';
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
  cvTextSession.clear();
});
afterEach(() => {
  cvTextSession.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'sendBeacon');
  restoreSideChannels();
});

const click = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name }));
const KEEP = /Keep my CV text in this tab so I can tailor it to a job/;

/** A profile that already came from an earlier CV, plus one skill the person added. */
const existing = () =>
  profileView({
    setupStatus: 'completed',
    skills: [
      { skillId: 'python', level: 2, source: 'cv' },
      { skillId: 'excel', level: 1, source: 'cv' },
      { skillId: 'git', level: 2, source: 'manual' },
    ],
    rolesHeld: [{ roleId: null, title: 'Old Role', years: 2 }],
    yearsExperience: 6,
    cvImportedAt: '2026-10-01T10:00:00.000Z',
  });

async function open(options: Parameters<typeof installSetupApi>[0] = {}) {
  const api = installSetupApi({ profile: existing(), calendar: 404, ...options });
  const view = renderApp({ auth: fakeAuth(SESSION), path: '/settings/cv' });
  await screen.findByRole('heading', { name: 'Choose your new CV' });
  return { api, ...view };
}

async function paste(text: string) {
  await click('Paste text instead');
  await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
  await userEvent.paste(text);
  await click('Read this text');
}

const docx = () =>
  userEvent.upload(screen.getByLabelText(/Choose a PDF or DOCX file/), buildDocx(CV_LINES));

const imports = async (api: Awaited<ReturnType<typeof open>>['api']) =>
  (await profileCalls(api)).filter((c) => c.path.endsWith('/import'));

describe('Change my CV: the flow', () => {
  it('lists what is replaced, saves only the ticked items and confirms with focus on the heading', async () => {
    const { api } = await open();
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });

    const block = screen.getByRole('region', { name: 'This will be replaced' });
    // Old CV skill that the new CV does not bring back is named as removed; Excel is kept.
    expect(block).toHaveTextContent('Not ticked, so removed: Python basics.');
    expect(block).toHaveTextContent('Your 1 saved role held is replaced by the 1 ticked above.');
    expect(block).toHaveTextContent('Years of experience (6) are replaced by 4');
    // Skills the person added themselves stay, and the page says so.
    expect(block).toHaveTextContent(
      'Skills you added yourself or chose in setup stay as they are: Git & GitHub.',
    );
    expect(block).toHaveTextContent(
      'Education and tools are added only if your profile has none yet.',
    );
    // The list follows the ticks: unticking Excel puts it on the list too.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Excel & spreadsheets' }));
    expect(block).toHaveTextContent(/removed: Python basics, Excel & spreadsheets\./);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Excel & spreadsheets' }));
    expect(await imports(api)).toHaveLength(0);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Jira & Confluence' }));
    await click('Save these to my profile');

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your profile now matches your new CV.',
    );
    const heading = screen.getByRole('heading', { name: 'CV saved' });
    await waitFor(() => expect(heading).toHaveFocus());
    const sent = await imports(api);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as { skills: { skillId: string }[] };
    expect(body.skills.some((s) => s.skillId === 'excel')).toBe(true);
    expect(body.skills.some((s) => s.skillId === 'jira')).toBe(false);
    // The profile query now holds the new data, shown on the next visit to Settings.
    expect(api.state.profile?.yearsExperience).toBe(4);
  });

  it('reads a DOCX file the same way', async () => {
    await open();
    await docx();
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.getByRole('checkbox', { name: 'Excel & spreadsheets' })).toBeChecked();
    expect(screen.getByRole('region', { name: 'This will be replaced' })).toBeVisible();
  });

  it('says nothing is replaced when no CV was saved before', async () => {
    await open({ profile: profileView({ setupStatus: 'dismissed' }) });
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.getByRole('region', { name: 'This will be replaced' })).toHaveTextContent(
      'Nothing is saved from a CV yet',
    );
  });

  it('Cancel on the first step changes nothing and goes back to Settings', async () => {
    const locations: string[] = [];
    const api = installSetupApi({ profile: existing(), calendar: 404 });
    renderApp({
      auth: fakeAuth(SESSION),
      path: '/settings/cv',
      onLocation: (u) => locations.push(u),
    });
    await screen.findByRole('heading', { name: 'Choose your new CV' });
    await click('Cancel');
    await screen.findByRole('heading', { name: 'Settings' });
    expect(locations.at(-1)).toBe('/settings');
    expect((await profileCalls(api)).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('"Don’t save any of it" and Back change nothing', async () => {
    const { api } = await open();
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Back');
    await screen.findByRole('heading', { name: 'Choose your new CV' });
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Don’t save any of it');
    await screen.findByRole('heading', { name: 'Settings' });
    expect((await profileCalls(api)).filter((c) => c.method !== 'GET')).toEqual([]);
    expect(api.state.profile?.yearsExperience).toBe(6);
  });

  it('keeps the review open with a message when saving fails', async () => {
    const { api } = await open({
      extra: {
        'PUT /api/v1/me/profile/import': () =>
          new Response(JSON.stringify({ error: { code: 'x', message: 'x', requestId: 'r' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Save these to my profile');
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was changed');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.state.profile?.yearsExperience).toBe(6);
  });

  it('passes axe on every step', async () => {
    await open();
    await expectNoAxeViolations();
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await expectNoAxeViolations();
    await click('Save these to my profile');
    await screen.findByRole('status');
    await expectNoAxeViolations();
  });
});

describe('Change my CV: privacy (the canary test)', () => {
  const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept']);
  const ALLOWED_IMPORT_KEYS = ['education', 'rolesHeld', 'skills', 'tools', 'yearsExperience'];
  const sources: [string, () => Promise<void>][] = [
    ['pasted text', () => paste(CV_TEXT)],
    ['a DOCX file', docx],
  ];
  const cases = sources.flatMap(([name, provide]) =>
    [false, true].map((keep) => [name, keep, provide] as const),
  );

  it.each(cases)(
    'sends none of the canary or contact details (%s, keep box ticked: %s)',
    async (_name, keep, provide) => {
      const indexedDB = { open: vi.fn() };
      const caches = { open: vi.fn(), match: vi.fn(), has: vi.fn() };
      vi.stubGlobal('indexedDB', indexedDB);
      vi.stubGlobal('caches', caches);
      const side = spyOnSideChannels();
      const { api } = await open();
      if (keep) await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));

      await provide();
      await screen.findByRole('heading', { name: 'Review what we found' });
      expect((await imports(api)).length).toBe(0);
      await click('Save these to my profile');
      await screen.findByRole('status');

      const sent = (await everythingSent(api)).toLowerCase();
      expect(findLeak(sent)).toBeNull();
      for (const call of api.calls) {
        for (const name of call.headers.keys()) expect(ALLOWED_HEADERS.has(name)).toBe(true);
      }
      const body = (await imports(api))[0]!.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(ALLOWED_IMPORT_KEYS);
      for (const s of body.skills as object[]) {
        expect(Object.keys(s).sort()).toEqual(['level', 'skillId']);
      }
      for (const r of body.rolesHeld as object[]) {
        expect(Object.keys(r).sort()).toEqual(['roleId', 'title', 'years']);
      }

      expect(findLeak(webStorageDump())).toBeNull();
      expect(indexedDB.open).not.toHaveBeenCalled();
      expect(caches.open).not.toHaveBeenCalled();
      expect(findLeak(side.logged.join('\n'))).toBeNull();
      expect(side.beacon).not.toHaveBeenCalled();
      expect(side.xhr).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(side.images).toEqual([]);
      expect(side.sockets).toEqual([]);
      expect(side.errors).toEqual([]);
      expect(document.body.textContent).not.toContain('CANARY');
      for (const secret of FORBIDDEN) expect(document.body.textContent).not.toContain(secret);
      // The text is only where the person chose: in the holder when ticked, nowhere when not.
      expect(cvTextSession.has()).toBe(keep);
    },
  );
});

describe('Change my CV: the tailor link', () => {
  it('sits in its own section with a heading, after the file box and not next to the checkbox', async () => {
    await open({
      extra: {
        'GET /api/v1/ai/usage': () =>
          json({
            day: '2026-11-10',
            resetsAt: '2026-11-11T00:00:00.000Z',
            configured: true,
            user: {
              practiceMessages: { used: 0, cap: 30 },
              practiceFeedback: { used: 0, cap: 10 },
              dayOverview: { used: 0, cap: 0 },
              cvTailor: { used: 0, cap: 3 },
            },
            features: { cvTailor: true },
            avoidedToday: 0,
            providers: [],
          }),
      },
    });
    const link = await screen.findByRole('link', { name: 'Tailor my CV to a job' });
    const region = screen.getByRole('region', { name: 'Applying for a job?' });
    expect(region).toContainElement(link);
    expect(region).not.toContainElement(screen.getByRole('checkbox', { name: KEEP }));
    const file = screen.getByLabelText(/Choose a PDF or DOCX file/);
    expect(file.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Change my CV: file button', () => {
  it('shows a styled button, not the browser default file input', async () => {
    await open();
    const input = screen.getByLabelText(/Choose a PDF or DOCX file/);
    expect(input).toHaveAttribute('type', 'file');
    expect(input.parentElement).toHaveTextContent('Choose file');
    expect(input).toHaveClass('opacity-0');
  });
});

describe('Change my CV: keeping the text in this tab', () => {
  it('is unticked by default and keeps nothing', async () => {
    await open();
    expect(screen.getByRole('checkbox', { name: KEEP })).not.toBeChecked();
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(cvTextSession.has()).toBe(false);
    await click('Save these to my profile');
    await screen.findByRole('status');
    expect(cvTextSession.has()).toBe(false);
  });

  it('keeps the text in memory when ticked, and never in web storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(cvTextSession.get()).toBe(CV_TEXT);
    await click('Save these to my profile');
    await screen.findByRole('status');
    expect(cvTextSession.get()).toBe(CV_TEXT);
    expect(findLeak(webStorageDump())).toBeNull();
    expect(setItem.mock.calls.flat().join('\n')).not.toContain('CANARY');
  });

  it('"Forget it now" and unticking the box remove it', async () => {
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Forget it now');
    expect(cvTextSession.has()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Forget it now' })).not.toBeInTheDocument();
    await click('Back');
    expect(screen.getByRole('checkbox', { name: KEEP })).not.toBeChecked();

    cvTextSession.set('text from before');
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    expect(cvTextSession.has()).toBe(false);
  });

  it('does not claim the text is kept after the box was unticked and a CV read again', async () => {
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.getByRole('button', { name: 'Forget it now' })).toBeVisible();
    await click('Back');
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.queryByRole('button', { name: 'Forget it now' })).not.toBeInTheDocument();
    expect(screen.queryByText(/still kept in this tab/)).not.toBeInTheDocument();
    expect(cvTextSession.has()).toBe(false);
  });

  it('announces the removal, moves focus, and offers Forget on the saved step too', async () => {
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Save these to my profile');
    await screen.findByRole('heading', { name: 'CV saved' });
    expect(screen.getByText(/still kept in this tab/)).toBeVisible();
    await click('Forget it now');
    expect(await screen.findByText('CV text removed from this tab')).toHaveAttribute(
      'role',
      'status',
    );
    expect(screen.getByRole('heading', { name: 'CV saved' })).toHaveFocus();
    expect(cvTextSession.has()).toBe(false);
  });

  it('uses the privacy wording that mentions the box', async () => {
    await open();
    expect(screen.getByText(/unless you tick the box above/)).toBeVisible();
    expect(screen.getByText(/never written to this device’s storage/)).toBeVisible();
  });

  it('leaving the page with the box unticked clears the holder', async () => {
    cvTextSession.set('stale text');
    const view = await open();
    // It starts ticked because the tab holds text; the person unticks it and leaves.
    const box = screen.getByRole('checkbox', { name: KEEP });
    expect(box).toBeChecked();
    await userEvent.click(box);
    cvTextSession.set('typed after unticking');
    view.unmount();
    expect(cvTextSession.has()).toBe(false);
  });

  it('is cleared on sign-out', async () => {
    const auth = fakeAuth(SESSION);
    installSetupApi({ profile: existing(), calendar: 404 });
    renderApp({ auth, path: '/settings/cv' });
    await screen.findByRole('heading', { name: 'Choose your new CV' });
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(cvTextSession.has()).toBe(true);
    await act(async () => {
      auth.emit(null);
    });
    expect(cvTextSession.has()).toBe(false);
  });

  it('is cleared when a different account signs in', async () => {
    const auth = fakeAuth(SESSION);
    installSetupApi({ profile: existing(), calendar: 404 });
    renderApp({ auth, path: '/settings/cv' });
    await screen.findByRole('heading', { name: 'Choose your new CV' });
    await userEvent.click(screen.getByRole('checkbox', { name: KEEP }));
    await paste(CV_TEXT);
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(cvTextSession.has()).toBe(true);
    await act(async () => {
      auth.emit({ userId: '22222222-2222-4222-8222-222222222222', email: 'other@example.com' });
    });
    expect(cvTextSession.has()).toBe(false);
  });
});

describe('Change my CV: the profile feature flag and the entry in Settings', () => {
  it('shows the entry next to "Profile setup" when setup was completed', async () => {
    installSetupApi({ profile: existing(), calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByRole('heading', { name: 'Profile setup' });
    await click('Change my CV');
    await screen.findByRole('heading', { name: 'Choose your new CV' });
  });

  it('shows the entry after the setup was dismissed, and hides it before any setup or profile', async () => {
    installSetupApi({ profile: profileView({ setupStatus: 'dismissed' }), calendar: 404 });
    const first = renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByRole('button', { name: 'Change my CV' });
    first.unmount();

    installSetupApi({ profile: profileView(), calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByRole('heading', { name: 'Profile setup' });
    expect(screen.queryByRole('button', { name: 'Change my CV' })).not.toBeInTheDocument();
  });

  it('hides the entry when the profile API is off (404), and the route leaves the page', async () => {
    const api = installSetupApi({ profile: 404, calendar: 404 });
    const first = renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() => expect(api.count('GET /api/v1/me/profile')).toBe(1));
    expect(screen.queryByRole('button', { name: 'Change my CV' })).not.toBeInTheDocument();
    first.unmount();

    const locations: string[] = [];
    installSetupApi({ profile: 404, calendar: 404 });
    renderApp({
      auth: fakeAuth(SESSION),
      path: '/settings/cv',
      onLocation: (u) => locations.push(u),
    });
    await screen.findByRole('heading', { name: 'Settings' });
    expect(locations.at(-1)).toBe('/settings');
    expect(screen.queryByRole('heading', { name: 'Choose your new CV' })).not.toBeInTheDocument();
  });
});
