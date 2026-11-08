import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CV_LINES, CV_TEXT, FORBIDDEN } from '../../test/cv-fixture';
import { buildDocx } from '../../test/docx-fixture';
import { fakeAuth, renderApp, SESSION } from '../../test/helpers';
import { installSetupApi, profileCalls, profileView } from '../../test/setup-fixtures';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const click = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name }));

/** Everything the app sent: URL, method, header names and values, and body, of every request. */
async function everythingSent(api: ReturnType<typeof installSetupApi>) {
  const parts: string[] = [];
  for (const call of api.calls) {
    parts.push(call.method, call.url);
    call.headers.forEach((value, name) => parts.push(`${name}: ${value}`));
    parts.push(await call.clone().text());
  }
  return parts.join('\n');
}

function webStorageDump() {
  const out: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      out.push(key, store.getItem(key) ?? '');
    }
  }
  return out.join('\n');
}

async function toCvStep() {
  await screen.findByRole('heading', { name: 'Welcome' });
  await click('Start setup');
  await userEvent.click(await screen.findByRole('radio', { name: 'Working full-time' }));
  for (let i = 0; i < 8; i++) {
    await click(/^(Next|Skip)$/);
    if (i < 7) await screen.findByRole('heading', { name: `Question ${i + 2} of 8` });
  }
  await screen.findByRole('heading', { name: 'Your CV (optional)' });
}

const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept']);
const ALLOWED_IMPORT_KEYS = ['education', 'rolesHeld', 'skills', 'tools', 'yearsExperience'];

describe('privacy: the CV never leaves the browser', () => {
  const paths: [string, () => Promise<void>][] = [
    [
      'pasted text',
      async () => {
        await click('Paste text instead');
        await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
        await userEvent.paste(CV_TEXT);
        await click('Read this text');
      },
    ],
    [
      'a DOCX file',
      async () => {
        const input = screen.getByLabelText(/Choose a PDF or DOCX file/);
        await userEvent.upload(input, buildDocx(CV_LINES));
      },
    ],
  ];

  it.each(paths)('sends none of the canary or contact details (%s)', async (_name, provide) => {
    const indexedDB = { open: vi.fn() };
    const caches = { open: vi.fn(), match: vi.fn(), has: vi.fn() };
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('caches', caches);
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();

    await provide();

    // The review screen shows what was found, with the redacted evidence, and nothing is sent yet.
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.getByRole('checkbox', { name: 'Excel' })).toBeChecked();
    expect(screen.getByText('Operations Coordinator, 4 years')).toBeInTheDocument();
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/import'))).toBe(false);
    // The person unticks a skill and a tool; neither must be sent.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Jira & Confluence' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Jira' }));
    await click('Save these to my profile');

    await screen.findByRole('heading', { name: 'Setup complete' });

    // 1. Nothing forbidden in any request: URL, headers, body.
    const sent = (await everythingSent(api)).toLowerCase();
    for (const secret of FORBIDDEN) expect(sent).not.toContain(secret.toLowerCase());
    // ... and no 30-character stretch of the raw text either (outside nothing: no value is that long).
    for (let i = 0; i + 30 <= CV_TEXT.length; i++) {
      expect(sent).not.toContain(CV_TEXT.slice(i, i + 30).toLowerCase());
    }
    for (const call of api.calls) {
      for (const name of call.headers.keys()) expect(ALLOWED_HEADERS.has(name)).toBe(true);
    }

    // 2. The import body has only the allowlisted fields, and only the ticked items.
    const imports = (await profileCalls(api)).filter((c) => c.path.endsWith('/import'));
    expect(imports).toHaveLength(1);
    const body = imports[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(ALLOWED_IMPORT_KEYS);
    const skills = body.skills as { skillId: string; level: number }[];
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) expect(Object.keys(s).sort()).toEqual(['level', 'skillId']);
    expect(skills.some((s) => s.skillId === 'jira')).toBe(false);
    expect(skills.some((s) => s.skillId === 'excel')).toBe(true);
    const roles = body.rolesHeld as Record<string, unknown>[];
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) expect(Object.keys(r).sort()).toEqual(['roleId', 'title', 'years']);
    expect(body.education).toBe('bachelor');
    expect(body.tools).toEqual(expect.arrayContaining(['Excel', 'SQL']));
    expect(body.tools).not.toContain('Jira');

    // 3. Nothing in web storage, nothing in IndexedDB or the Cache API.
    const stored = webStorageDump().toLowerCase();
    for (const secret of FORBIDDEN) expect(stored).not.toContain(secret.toLowerCase());
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();

    // 4. After the CV steps the text and the evidence are gone from the page too.
    expect(document.body.textContent).not.toContain('CANARY');
  });

  it('sends nothing from the CV when the person saves none of it', async () => {
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    await click('Paste text instead');
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste(CV_TEXT);
    await click('Read this text');
    await screen.findByRole('heading', { name: 'Review what we found' });
    await click('Don’t save any of it');
    await screen.findByRole('heading', { name: 'Setup complete' });
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/import'))).toBe(false);
    const sent = (await everythingSent(api)).toLowerCase();
    for (const secret of FORBIDDEN) expect(sent).not.toContain(secret.toLowerCase());
  });

  it('shows the message and the paste box when a file cannot be read, and keeps nothing', async () => {
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    const input = screen.getByLabelText(/Choose a PDF or DOCX file/);
    await userEvent
      .upload(
        input,
        new File(['old format'], 'cv.doc', { type: 'application/msword' }),
        // The input's `accept` filter would drop it before our own check; test our check.
      )
      .catch(() => {});
    // userEvent applies `accept`; use the real change event to reach the component's own check.
    const file = new File(['old format'], 'cv.doc');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Old .doc files can’t be read');
    expect(screen.getByRole('textbox', { name: /Paste the text of your CV/ })).toBeInTheDocument();
    expect(api.calls.every((c) => new URL(c.url).pathname !== '/api/v1/me/profile/import')).toBe(
      true,
    );
  });

  it('tells a text with no skills it found nothing, without sending anything', async () => {
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    await click('Paste text instead');
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste('Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do.');
    await click('Read this text');
    expect(await screen.findByText(/We didn’t find anything to suggest/)).toBeInTheDocument();
    expect((await profileCalls(api)).some((c) => c.path.endsWith('/import'))).toBe(false);
    await click('Continue');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Setup complete' })).toBeVisible(),
    );
  });

  it('rejects a paste that is too short to be a CV', async () => {
    installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    await click('Paste text instead');
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste('too short');
    await click('Read this text');
    expect(
      within(screen.getByRole('alert')).getByText(/Paste some of your CV text/),
    ).toBeInTheDocument();
  });

  it('marks evidence for automatic text direction', async () => {
    installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    await click('Paste text instead');
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste(CV_TEXT);
    await click('Read this text');
    await screen.findByRole('heading', { name: 'Review what we found' });
    const dirs = document.querySelectorAll('[dir="auto"]');
    expect(dirs.length).toBeGreaterThan(0);
  });
});

describe('the profile starts empty', () => {
  it('has no CV data before the CV step', () => {
    expect(profileView().skills).toEqual([]);
  });
});
