import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for pdf.js (the real one is tested in cv-extract.pdf.test.ts): it "reads" the fixture
// CV, one text item per line, so the real PDF code path of the wizard runs.
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/pdf.worker.test.mjs',
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async () => {
  const { CV_LINES } = await import('../../test/cv-fixture');
  const items = CV_LINES.map((str) => ({ str, hasEOL: true }));
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items }) }),
      }),
      destroy: async () => {},
    }),
  };
});
import { CV_LINES, CV_TEXT, FORBIDDEN } from '../../test/cv-fixture';
import { buildDocx } from '../../test/docx-fixture';
import { fakeAuth, renderApp, SESSION } from '../../test/helpers';
import { installSetupApi, profileCalls, profileView } from '../../test/setup-fixtures';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'sendBeacon');
});

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

/** The first secret, or 30-character stretch of the CV text, found in `haystack`; else null. */
function findLeak(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  for (const secret of FORBIDDEN) if (lower.includes(secret.toLowerCase())) return secret;
  for (let i = 0; i + 30 <= CV_TEXT.length; i++) {
    const piece = CV_TEXT.slice(i, i + 30);
    if (lower.includes(piece.toLowerCase())) return piece;
  }
  return null;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Records everything that leaves through console, sendBeacon and XMLHttpRequest. */
function spyOnSideChannels() {
  const logged: string[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const beacon = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  const xhr: string[] = [];
  class FakeXhr {
    open(...args: unknown[]) {
      xhr.push(args.join(' '));
    }
    setRequestHeader(...args: unknown[]) {
      xhr.push(args.join(': '));
    }
    send(body?: unknown) {
      xhr.push(String(body));
    }
    addEventListener() {}
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return { logged, beacon, xhr };
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
      'a PDF file',
      async () => {
        const input = screen.getByLabelText(/Choose a PDF or DOCX file/);
        await userEvent.upload(input, new File(['%PDF-1.4 stand-in'], 'cv.pdf'));
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
    const side = spyOnSideChannels();
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();

    await provide();

    // The review screen shows what was found, with the redacted evidence, and nothing is sent yet.
    await screen.findByRole('heading', { name: 'Review what we found' });
    expect(screen.getByRole('checkbox', { name: 'Excel' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Role 1 title' })).toHaveValue(
      'Operations Coordinator',
    );
    expect(screen.getByRole('spinbutton', { name: 'Role 1 years' })).toHaveValue(4);
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
    expect(findLeak(webStorageDump())).toBeNull();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();

    // 3b. Nothing through the console, sendBeacon or XMLHttpRequest either.
    expect(findLeak(side.logged.join('\n'))).toBeNull();
    expect(side.beacon).not.toHaveBeenCalled();
    expect(side.xhr).toEqual([]);

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

describe('review: confirming and fixing CV-derived roles', () => {
  const TEXT = [
    'Dana Example',
    '',
    'Experience',
    'Operations Coordinator, 2019 - 2023',
    'Built Excel reports and SQL queries for the weekly review.',
    'Chief Happiness Wizard, 2015 - 2017',
    '',
    'Skills',
    'Excel, SQL',
  ].join('\n');

  async function toReview() {
    const api = installSetupApi({ calendar: 404 });
    renderApp({ auth: fakeAuth(SESSION), path: '/setup' });
    await toCvStep();
    await click('Paste text instead');
    await userEvent.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
    await userEvent.paste(TEXT);
    await click('Read this text');
    await screen.findByRole('heading', { name: 'Review what we found' });
    return api;
  }

  const importBody = async (api: ReturnType<typeof installSetupApi>) =>
    (await profileCalls(api)).find((c) => c.path.endsWith('/import'))?.body as
      { rolesHeld: { roleId: string | null; title: string; years: number | null }[] } | undefined;

  it('offers the unmatched title as an unticked, editable row', async () => {
    await toReview();
    const titles = screen.getAllByRole('textbox').map((t) => (t as HTMLInputElement).value);
    expect(titles).toContain('Chief Happiness Wizard');
    const index = titles.indexOf('Chief Happiness Wizard') + 1;
    expect(screen.getByRole('checkbox', { name: `Include role ${index}` })).not.toBeChecked();
  });

  it('sends an edited title and years, and a ticked unmatched row', async () => {
    const api = await toReview();
    const title = screen.getByRole('textbox', { name: 'Role 1 title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Ops Lead');
    const years = screen.getByRole('spinbutton', { name: 'Role 1 years' });
    await userEvent.clear(years);
    await userEvent.type(years, '3.5');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include role 2' }));
    await click('Save these to my profile');
    await screen.findByRole('heading', { name: 'Setup complete' });
    const body = await importBody(api);
    expect(body?.rolesHeld[0]).toMatchObject({ title: 'Ops Lead', years: 3.5 });
    expect(body?.rolesHeld[1]).toMatchObject({ roleId: null, title: 'Chief Happiness Wizard' });
  });

  it('refuses a title with an email address and sends nothing', async () => {
    const api = await toReview();
    const title = screen.getByRole('textbox', { name: 'Role 1 title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Lead, mail dana.x@mailbox.example');
    await click('Save these to my profile');
    expect(await screen.findByRole('alert')).toHaveTextContent('Role 1: remove the email');
    expect(await importBody(api)).toBeUndefined();
  });

  it('refuses years outside 0 to 50', async () => {
    const api = await toReview();
    const years = screen.getByRole('spinbutton', { name: 'Role 1 years' });
    await userEvent.clear(years);
    await userEvent.type(years, '60');
    await click('Save these to my profile');
    expect(await screen.findByRole('alert')).toHaveTextContent('years must be between 0 and 50');
    expect(await importBody(api)).toBeUndefined();
  });
});
