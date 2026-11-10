import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AiHooks from '../../api/ai-hooks';
import type { AiUsage, CvTailorResult } from '../../api/ai-hooks';
import { cvTextSession } from '../../cv/cv-text-session';
import { expectNoAxeViolations } from '../../test/axe';
import { CANARY, CONTACT, CV_TEXT, FORBIDDEN } from '../../test/cv-fixture';
import {
  apiError,
  fakeAuth,
  installApi,
  json,
  meBody,
  renderApp,
  SESSION,
} from '../../test/helpers';
import { restoreSideChannels, spyOnSideChannels, webStorageDump } from '../../test/privacy-harness';

const resetSpy = vi.hoisted(() => vi.fn());
// Wraps the real hook only to see that the page drops the mutation's copy of the answer.
vi.mock('../../api/ai-hooks', async (original) => {
  const real = await original<typeof AiHooks>();
  return {
    ...real,
    useCvTailor: () => {
      const t = real.useCvTailor();
      return {
        ...t,
        reset: () => {
          resetSpy();
          t.reset();
        },
      };
    },
  };
});

const JOB =
  'We need an operations analyst who can build Excel reports and SQL queries, run project management for vendors, and use Python and Tableau to present results to the weekly review.';
const TAILOR = 'POST /api/v1/me/cv/tailor';

const usageBody = (over: { used?: number; ai?: boolean; flag?: boolean } = {}): AiUsage => ({
  day: '2026-11-10',
  resetsAt: '2026-11-11T00:00:00.000Z',
  configured: over.ai !== false,
  user: {
    practiceMessages: { used: 0, cap: 30 },
    practiceFeedback: { used: 0, cap: 10 },
    dayOverview: { used: 0, cap: 0 },
    cvTailor: { used: over.used ?? 0, cap: 3 },
  },
  features: { cvTailor: over.flag !== false },
  avoidedToday: 0,
  providers: [
    ['cloudflare-ai', 'Cloudflare Workers AI'],
    ['groq', 'Groq'],
  ].map(([id, label]) => ({
    id: id!,
    label: label!,
    configured: over.ai !== false,
    available: over.ai !== false,
    cooldownUntil: null,
    usedToday: 0,
    budget: 100,
  })),
});

const answer = (over: Partial<CvTailorResult> = {}): CvTailorResult => ({
  text: 'SUMMARY\nAnalyst with Excel and SQL.\nEXPERIENCE\n- Cut costs by [number?] across sites\n- Reached 40% faster reviews\nSKILLS\nExcel, SQL',
  notes: [
    { kind: 'missing_keyword', text: 'Tableau' },
    { kind: 'check_number', text: '40% is not in your CV' },
  ],
  flags: [{ kind: 'number', text: '40%' }],
  providers: [{ id: 'cloudflare-ai', label: 'Cloudflare Workers AI' }],
  usage: { used: 1, cap: 3 },
  ...over,
});

interface Setup {
  usage?: Parameters<typeof usageBody>[0];
  reply?: (request: Request) => Response | Promise<Response>;
}

function install(opts: Setup = {}) {
  let usage = opts.usage ?? {};
  let usageFails = false;
  const api = installApi({
    'GET /api/v1/me': () => json(meBody({ displayName: 'Dana Q Example' })),
    'GET /api/v1/ai/usage': () =>
      usageFails ? apiError(500, 'internal', 'x') : json(usageBody(usage)),
    [TAILOR]: (r) => (opts.reply ? opts.reply(r) : json(answer())),
  });
  return {
    api,
    setUsage: (u: typeof usage) => (usage = u),
    failUsage: (on = true) => (usageFails = on),
  };
}

const tailorCalls = (api: ReturnType<typeof install>['api']) =>
  api.calls.filter((c) => new URL(c.url).pathname === '/api/v1/me/cv/tailor');

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  cvTextSession.clear();
  user = userEvent.setup();
  resetSpy.mockClear();
});
afterEach(() => {
  cvTextSession.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'sendBeacon');
  restoreSideChannels();
});

const click = (name: string | RegExp) => user.click(screen.getByRole('button', { name }));

async function open() {
  const view = renderApp({ auth: fakeAuth(SESSION), path: '/settings/tailor-cv' });
  await screen.findByRole('heading', { name: 'Your CV', level: 2 });
  return view;
}

async function toStep2(cv = CV_TEXT) {
  await click('Paste text instead');
  await user.click(screen.getByRole('textbox', { name: /Paste the text of your CV/ }));
  await user.paste(cv);
  await click('Read this text');
  await screen.findByRole('heading', { name: 'The job', level: 2 });
}

async function toStep3(job = JOB) {
  await toStep2();
  await user.click(screen.getByRole('textbox', { name: 'The job post' }));
  await user.paste(job);
  await click('Next: keyword list');
  await screen.findByRole('heading', { name: 'Keyword list', level: 2 });
}

async function toStep4() {
  await toStep3();
  await click('Next: write a tailored version with AI');
  await screen.findByRole('heading', { name: 'Preview and send', level: 2 });
}

const CONFIRM = 'I checked the text and removed my name and address';
const tick = () => user.click(screen.getByRole('checkbox', { name: CONFIRM }));
const box = () => screen.getByRole('checkbox', { name: CONFIRM }) as HTMLInputElement;
const cvBox = () => screen.getByRole('textbox', { name: 'Your CV, as it will be sent' });

describe('Tailor my CV: gate and entries', () => {
  it('redirects to Settings and shows no entry when the server flag is off', async () => {
    install({ usage: { flag: false } });
    renderApp({ auth: fakeAuth(SESSION), path: '/settings/tailor-cv' });
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(screen.queryByRole('heading', { name: 'Tailor my CV to a job' })).toBeNull();
  });

  it('shows the Settings entry when the flag is on', async () => {
    install();
    renderApp({ auth: fakeAuth(SESSION), path: '/settings' });
    expect(await screen.findByRole('heading', { name: 'Tailor my CV to a job' })).toBeVisible();
  });
});

describe('Tailor my CV: the flow and the privacy rules', () => {
  it('sends nothing before the preview is confirmed, then one POST with the cleaned text only', async () => {
    const { api } = install();
    const spies = spyOnSideChannels();
    await open();
    await toStep3();

    // Steps 1 to 3 made no tailoring request. The keyword list was computed on this device.
    expect(tailorCalls(api)).toHaveLength(0);
    expect(screen.getByText('In the post, not in your CV')).toBeVisible();
    expect(screen.getByText(/^Python/)).toBeVisible();

    await click('Next: write a tailored version with AI');
    await screen.findByRole('heading', { name: 'Preview and send', level: 2 });
    expect(tailorCalls(api)).toHaveLength(0);
    // The contact block is dropped in the preview.
    expect((cvBox() as HTMLTextAreaElement).value).not.toContain(CONTACT.email);
    expect((cvBox() as HTMLTextAreaElement).value).not.toContain('Fictional Lane');

    // Blocked until the box is ticked, with the reason in words.
    const send = screen.getByRole('button', { name: 'Send to AI' });
    expect(send).toBeDisabled();
    expect(
      screen.getByText(/Tick “I checked the text and removed my name and address”/),
    ).toBeVisible();
    await user.click(send);
    expect(tailorCalls(api)).toHaveLength(0);

    await tick();
    expect(send).toBeEnabled();
    // The providers are named before sending.
    expect(screen.getByText(/sends exactly the two texts above to/)).toHaveTextContent(
      'Cloudflare Workers AI',
    );
    await user.click(send);
    await screen.findByRole('heading', { name: 'Result', level: 2 });

    const calls = tailorCalls(api);
    expect(calls).toHaveLength(1);
    const body = await calls[0]!.clone().text();
    expect(body).toContain('CANARY-4f9c1e7a');
    for (const secret of FORBIDDEN) {
      if (secret.includes('CANARY') || secret === 'violet heron') continue;
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // Nothing else carries the text: other requests, console, beacon, XHR, images, sockets, errors.
    for (const c of api.calls) {
      if (c === calls[0]) continue;
      const all = `${c.url}\n${await c.clone().text()}`;
      expect(all).not.toContain('CANARY');
    }
    expect(JSON.stringify(spies.logged)).not.toContain('CANARY');
    expect(spies.beacon).not.toHaveBeenCalled();
    expect(spies.xhr).toEqual([]);
    expect(spies.images).toEqual([]);
    expect(spies.sockets).toEqual([]);
    expect(spies.errors).toEqual([]);
    expect(webStorageDump()).not.toContain('CANARY');
    expect(webStorageDump()).not.toContain(CONTACT.email);
    expect(cvTextSession.has()).toBe(false);
    expect(CANARY).toContain('CANARY');
  });

  it('blocks sending while a personal detail is flagged, live, and names what it found', async () => {
    const { api } = install();
    await open();
    await toStep4();
    await tick();
    const send = screen.getByRole('button', { name: 'Send to AI' });
    expect(send).toBeEnabled();

    await user.click(cvBox());
    await user.paste(' write to someone@mailbox.example');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An email address is still in the text.',
    );
    expect(send).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    await user.click(send);
    expect(tailorCalls(api)).toHaveLength(0);

    await user.clear(cvBox());
    await user.paste(CV_TEXT.split('\n').slice(5).join('\n'));
    // Editing the text withdraws the person's confirmation: it has to be given again.
    expect(send).toBeDisabled();
    await tick();
    await waitFor(() => expect(send).toBeEnabled());
  });

  it('finds the account name typed into the text', async () => {
    install();
    await open();
    await toStep4();
    await user.click(cvBox());
    await user.paste(' Dana');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your name or email');
    expect(screen.getByRole('button', { name: 'Send to AI' })).toBeDisabled();
  });

  it('Copy prompt sends no request, copies the prompt and still needs the checkbox', async () => {
    const { api } = install();
    await open();
    await toStep4();
    const copy = screen.getByRole('button', { name: 'Copy prompt' });
    expect(copy).toBeDisabled();
    await tick();
    const before = api.calls.length;
    await user.click(copy);
    expect(await screen.findByText(/Nothing was sent/)).toBeVisible();
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('<CV>');
    expect(copied).toContain('CANARY-4f9c1e7a');
    expect(copied).not.toContain(CONTACT.email);
    expect(api.calls.length).toBe(before);
    expect(tailorCalls(api)).toHaveLength(0);
  });

  it('with AI off the keyword list and Copy prompt work and Send is off', async () => {
    const { api } = install({ usage: { ai: false } });
    await open();
    await toStep3();
    expect(screen.getByText(/AI is not available right now/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Next: write a tailored/ })).toBeNull();
    await click('Copy prompt');
    await screen.findByRole('heading', { name: 'Preview and send', level: 2 });
    await tick();
    expect(screen.getByRole('button', { name: 'Send to AI' })).toBeDisabled();
    await click('Copy prompt');
    expect(await screen.findByText(/Nothing was sent/)).toBeVisible();
    expect(tailorCalls(api)).toHaveLength(0);
  });

  it('uses the CV text kept in this tab and forgets it on request', async () => {
    install();
    cvTextSession.set(CV_TEXT);
    await open();
    await click('Use the CV text from this tab');
    await screen.findByRole('heading', { name: 'The job', level: 2 });
    cvTextSession.set(CV_TEXT);
    await click('Back');
    await click('Forget my CV text');
    expect(cvTextSession.has()).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('CV text removed from this tab');
  });

  it('does not keep the CV in the session holder when the person pastes it', async () => {
    install();
    await open();
    await toStep2();
    expect(cvTextSession.has()).toBe(false);
  });

  it('shows the result with highlighted flags, the fixed line and the providers that got the text', async () => {
    install({
      reply: () =>
        json(
          answer({
            providers: [
              { id: 'cloudflare-ai', label: 'Cloudflare Workers AI' },
              { id: 'groq', label: 'Groq' },
            ],
          }),
        ),
    });
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });

    expect(
      screen.getByText(
        'Check every line. Only keep what is true. You may be asked about any of it in an interview.',
      ),
    ).toBeVisible();
    expect(screen.getByText(/The text was sent to: Cloudflare Workers AI, Groq\./)).toBeVisible();
    const marks = screen.getAllByText((_, el) => el?.tagName === 'MARK');
    expect(marks.map((m) => m.textContent)).toEqual(['[number?]', '40%']);
    expect(screen.getByText(/Check number:/)).toBeVisible();
    // A placeholder remains: a warning and a Copy button that says so.
    expect(screen.getByRole('alert')).toHaveTextContent('1 [number?] placeholder still need');
    await click('Copy text anyway');
    expect(await screen.findByRole('status')).toHaveTextContent(/still need a real number/);
    expect(await navigator.clipboard.readText()).toContain('Analyst with Excel');
    expect(screen.getByText(/1 of 3 used/)).toBeVisible();
  });

  it('does not break when a flag is cut short, missing from the text or full of regex characters', async () => {
    install({
      reply: () =>
        json(
          answer({
            text: 'SUMMARY\nLed a team of (12 people) at a firm.',
            flags: [
              { kind: 'term', text: '(12 people' },
              { kind: 'term', text: 'x'.repeat(200) },
              { kind: 'term', text: '[unclosed' },
            ],
          }),
        ),
    });
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    expect(screen.getByText('(12 people', { selector: 'mark' })).toBeVisible();
    expect(screen.getByText(/Led a team of/)).toBeVisible();
  });

  it('has no placeholder warning when none remain', async () => {
    install({ reply: () => json(answer({ text: 'SUMMARY\nAnalyst.', flags: [] })) });
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeVisible();
  });
});

describe('Tailor my CV: error states keep the text and say what still works', () => {
  async function failWith(
    reply: Setup['reply'],
    after?: (setUsage: ReturnType<typeof install>['setUsage'], failUsage: () => void) => void,
  ) {
    const { setUsage, failUsage } = install({ reply });
    await open();
    await toStep4();
    await tick();
    const text = (cvBox() as HTMLTextAreaElement).value;
    if (after) after(setUsage, failUsage);
    await click('Send to AI');
    return { text };
  }

  it('503 when no provider was attempted: not available, nothing was sent', async () => {
    const { text } = await failWith(() => apiError(503, 'ai_unavailable', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'AI is not available right now. Your keyword list still works.',
    );
    expect((cvBox() as HTMLTextAreaElement).value).toBe(text);
  });

  it('503 after the run count rose: says the text may have reached the providers', async () => {
    await failWith(
      () => apiError(503, 'ai_unavailable', 'x'),
      (setUsage) => setUsage({ used: 1 }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your text may have reached Cloudflare Workers AI, and Groq if Cloudflare Workers AI failed, and this run counted.',
    );
  });

  it('503 with the count at the cap still says the text may have reached the providers', async () => {
    await failWith(
      () => apiError(503, 'ai_unavailable', 'x'),
      (setUsage) => setUsage({ used: 3 }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('may have reached Cloudflare');
    expect(alert.textContent).not.toMatch(/You used today/);
  });

  it('a failed count refetch says we cannot tell, never nothing was sent', async () => {
    const { text } = await failWith(
      () => apiError(503, 'ai_unavailable', 'x'),
      (_setUsage, failUsage) => failUsage(),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('can’t tell whether your text reached an AI provider');
    expect(alert.textContent).not.toMatch(/not available right now|nothing was sent/i);
    // The failed background read must not replace the page or the text.
    expect((cvBox() as HTMLTextAreaElement).value).toBe(text);
    // The count is stale: say so, and offer to read it again instead of sending again.
    expect(screen.getByText(/we could not read the count just now/)).toBeVisible();
    expect(screen.queryByText(/Tailoring runs today: 0 of 3/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check count' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('Check count reads the count again and re-words the message', async () => {
    const { setUsage, failUsage } = install({ reply: () => apiError(503, 'ai_unavailable', 'x') });
    await open();
    await toStep4();
    await tick();
    failUsage();
    await click('Send to AI');
    await screen.findByRole('button', { name: 'Check count' });
    // The count is readable again and the run did count.
    failUsage(false);
    setUsage({ used: 1 });
    await click('Check count');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('this run counted'));
    expect(screen.getByText(/Tailoring runs today: 1 of 3 used/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check count' })).toBeNull();
  });

  it('names only Groq in the counted 503 when only Groq is available', async () => {
    let posted = false;
    installApi({
      'GET /api/v1/me': () => json(meBody({ displayName: 'Dana Q Example' })),
      'GET /api/v1/ai/usage': () => {
        const u = usageBody({ used: posted ? 1 : 0 });
        u.providers = u.providers.map((p) =>
          p.id === 'cloudflare-ai' ? { ...p, available: false } : p,
        );
        return json(u);
      },
      [TAILOR]: () => {
        posted = true;
        return apiError(503, 'ai_unavailable', 'x');
      },
    });
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('may have reached Groq, and this run counted');
    expect(alert.textContent).not.toMatch(/Cloudflare/);
  });

  it('429 ai_feature_cap is the daily limit for everyone, with no wait of a minute', async () => {
    await failWith(() => apiError(429, 'ai_feature_cap', 'x'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('daily limit for everyone');
    expect(alert.textContent).not.toMatch(/minute/);
  });

  it('offers the way back to the keyword list, Copy list and Copy prompt after a failure', async () => {
    const { api } = install({ reply: () => apiError(503, 'ai_unavailable', 'x') });
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    await screen.findByRole('alert');
    await click('Copy list');
    expect(await screen.findByText('Keyword list copied.')).toBeVisible();
    expect(await navigator.clipboard.readText()).toMatch(/In the job post, not in your CV/);
    await click('Copy prompt');
    expect(await screen.findByText(/Nothing was sent/)).toBeVisible();
    expect(tailorCalls(api)).toHaveLength(1);
    await click('Back to keyword list');
    await screen.findByRole('heading', { name: 'Keyword list', level: 2 });
  });

  it('shows a specific message when the server has the feature switched off', async () => {
    await failWith(() => apiError(404, 'not_found', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent('switched off on the server');
  });

  it('429 user cap names the cap and offers the keyword list', async () => {
    await failWith(() => apiError(429, 'ai_user_cap', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /You used today’s 3 tailoring runs\. They reset at/,
    );
  });

  it('429 rate limit asks to try again in a minute', async () => {
    await failWith(() => apiError(429, 'rate_limited', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a minute.');
  });

  it('un-ticks the checkbox when either text is edited, also after a 422', async () => {
    await failWith(() => apiError(422, 'pii_blocked', 'x'));
    await screen.findByRole('alert');
    expect(box().checked).toBe(true);
    await user.type(cvBox(), ' more');
    expect(box().checked).toBe(false);
    await tick();
    expect(box().checked).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'The job post, as it will be sent' }), 'x');
    expect(box().checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Send to AI' })).toBeDisabled();
  });

  it('422 pii_blocked keeps the text on the preview', async () => {
    const { text } = await failWith(() => apiError(422, 'pii_blocked', 'x'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server found personal details in the text. Remove them and send again.',
    );
    expect(screen.getByRole('heading', { name: 'Preview and send', level: 2 })).toBeVisible();
    expect((cvBox() as HTMLTextAreaElement).value).toBe(text);
  });

  it('a 502 never claims that nothing was sent', async () => {
    await failWith(() => apiError(502, 'bad_gateway', 'x'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('we can’t tell whether your text reached an AI provider');
    expect(alert.textContent).not.toMatch(/nothing was sent/i);
  });

  it('a dropped connection says the same', async () => {
    await failWith(() => {
      throw new TypeError('network');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('we can’t tell whether');
  });

  it('sends only once when the button is pressed twice quickly', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api } = install({
      reply: async () => {
        await gate;
        return json(answer());
      },
    });
    await open();
    await toStep4();
    await tick();
    const send = screen.getByRole('button', { name: 'Send to AI' });
    await user.click(send);
    await user.click(send);
    expect(tailorCalls(api)).toHaveLength(1);
    release();
    await screen.findByRole('heading', { name: 'Result', level: 2 });
  });
});

describe('Tailor my CV: what is sent and what is kept', () => {
  it('posts exactly the trimmed previewed texts', async () => {
    const { api } = install();
    await open();
    await toStep4();
    const jobBox = screen.getByRole('textbox', { name: 'The job post, as it will be sent' });
    await user.type(cvBox(), '\n\n   ');
    await user.type(jobBox, '   \n');
    await tick();
    const cv = (cvBox() as HTMLTextAreaElement).value;
    const job = (jobBox as HTMLTextAreaElement).value;
    expect(cv).not.toBe(cv.trim());
    expect(job).not.toBe(job.trim());
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    const body = JSON.parse(await tailorCalls(api)[0]!.clone().text()) as Record<string, string>;
    expect(body.cvText).toBe(cv.trim());
    expect(body.jobText).toBe(job.trim());
  });

  it('the in-flight guard alone stops a second send in the same tick', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api } = install({
      reply: async () => {
        await gate;
        return json(answer());
      },
    });
    await open();
    await toStep4();
    await tick();
    const send = screen.getByRole('button', { name: 'Send to AI' });
    // Two native clicks before React re-renders: the button is not disabled yet.
    act(() => {
      send.click();
      send.click();
    });
    await waitFor(() => expect(tailorCalls(api)).toHaveLength(1));
    release();
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    expect(tailorCalls(api)).toHaveLength(1);
  });

  it('names the providers with their data pages and the Groq line, only those available', async () => {
    install();
    await open();
    await toStep4();
    const cf = screen.getByRole('link', { name: 'How Cloudflare Workers AI handles data' });
    expect(cf).toHaveAttribute(
      'href',
      'https://developers.cloudflare.com/workers-ai/platform/data-usage/',
    );
    const groq = screen.getByRole('link', { name: 'How Groq handles data' });
    expect(groq).toHaveAttribute('href', 'https://console.groq.com/docs/your-data');
    expect(screen.getByText('Groq is used with Zero Data Retention on.')).toBeVisible();
    expect(screen.getByText(/it may then also go to Groq as a backup/)).toBeVisible();
  });

  it('names no provider that is not available', async () => {
    const api = installApi({
      'GET /api/v1/me': () => json(meBody({ displayName: 'Dana Q Example' })),
      'GET /api/v1/ai/usage': () => {
        const u = usageBody();
        u.providers = u.providers.map((p) => (p.id === 'groq' ? { ...p, available: false } : p));
        return json(u);
      },
      [TAILOR]: () => json(answer()),
    });
    expect(api).toBeTruthy();
    await open();
    await toStep4();
    expect(screen.queryByRole('link', { name: /Groq/ })).toBeNull();
    expect(screen.queryByText(/Groq/)).toBeNull();
    expect(screen.getByRole('link', { name: /Cloudflare/ })).toBeVisible();
  });

  it('turns Send off with a stated reason when today’s runs are used', async () => {
    const { api } = install({ usage: { used: 3 } });
    await open();
    await toStep4();
    await tick();
    const send = screen.getByRole('button', { name: 'Send to AI' });
    expect(send).toBeDisabled();
    expect(
      screen.getByText(/You used today’s 3 tailoring runs, so Send to AI is off/),
    ).toBeVisible();
    await user.click(send);
    expect(tailorCalls(api)).toHaveLength(0);
  });

  it('states why Send is off when AI is unavailable', async () => {
    install({ usage: { ai: false } });
    await open();
    await toStep3();
    await click('Copy prompt');
    await screen.findByRole('heading', { name: 'Preview and send', level: 2 });
    expect(screen.getByText('AI is not available right now, so Send to AI is off.')).toBeVisible();
  });

  async function toResult() {
    install();
    await open();
    await toStep4();
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
  }

  it('shows the trimmed texts that were actually sent', async () => {
    install();
    await open();
    await toStep4();
    await user.type(
      screen.getByRole('textbox', { name: 'The job post, as it will be sent' }),
      '   ',
    );
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    const job = screen
      .getByRole('heading', { name: 'The job post that was sent' })
      .closest('section')!
      .querySelector('p')!;
    expect(job.textContent).toBe(job.textContent!.trim());
    expect(job.textContent!.length).toBeGreaterThan(50);
  });

  it('Forget my CV text also clears the chosen role', async () => {
    install();
    cvTextSession.set(CV_TEXT);
    await open();
    await click('Use the CV text from this tab');
    await screen.findByRole('heading', { name: 'The job', level: 2 });
    const pick = screen.getByRole('combobox', { name: /Target role/ }) as HTMLSelectElement;
    await user.selectOptions(pick, pick.options[1]!.value);
    expect(pick.value).not.toBe('');
    cvTextSession.set(CV_TEXT);
    await click('Back');
    await click('Forget my CV text');
    await toStep2();
    expect((screen.getByRole('combobox', { name: /Target role/ }) as HTMLSelectElement).value).toBe(
      '',
    );
  });

  it('shows the job post that was sent on the result', async () => {
    await toResult();
    expect(screen.getByRole('heading', { name: 'The job post that was sent' })).toBeVisible();
  });

  it('Start again drops the answer and the texts', async () => {
    await toResult();
    resetSpy.mockClear();
    await click('Start again');
    expect(resetSpy).toHaveBeenCalled();
    expect(screen.queryByText(/Analyst with Excel and SQL/)).toBeNull();
    expect(document.body.textContent).not.toContain('CANARY');
  });

  it('Forget my CV text drops the result, the sent text and the page’s copies', async () => {
    await toResult();
    resetSpy.mockClear();
    await click('Forget my CV text');
    expect(resetSpy).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Your CV', level: 2 })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'removed from this tab and from this page',
    );
    expect(document.body.textContent).not.toContain('CANARY');
    expect(document.body.textContent).not.toContain('Analyst with Excel');
    expect(cvTextSession.has()).toBe(false);
  });

  it('drops the mutation’s copy of the answer when the page closes', async () => {
    const view = await toStep4Mounted();
    resetSpy.mockClear();
    view.unmount();
    expect(resetSpy).toHaveBeenCalled();
  });

  async function toStep4Mounted() {
    install();
    const view = await open();
    await toStep4();
    return view;
  }
});

describe('Tailor my CV: limits and accessibility', () => {
  it('shows the counter and blocks a job post over 3,000 characters', async () => {
    install();
    await open();
    await toStep2();
    await user.click(screen.getByRole('textbox', { name: 'The job post' }));
    await user.paste('word '.repeat(700));
    expect(screen.getByText(/3,499 of 3,000 characters \(too long\)/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next: keyword list' })).toBeDisabled();
  });

  it('passes axe on every step and moves focus to the step heading', async () => {
    install();
    await open();
    await expectNoAxeViolations();
    await toStep2();
    expect(screen.getByRole('heading', { name: 'The job', level: 2 })).toHaveFocus();
    await expectNoAxeViolations();
    await user.click(screen.getByRole('textbox', { name: 'The job post' }));
    await user.paste(JOB);
    await click('Next: keyword list');
    await screen.findByRole('heading', { name: 'Keyword list', level: 2 });
    await expectNoAxeViolations();
    await click('Next: write a tailored version with AI');
    await screen.findByRole('heading', { name: 'Preview and send', level: 2 });
    await expectNoAxeViolations();
    await tick();
    await click('Send to AI');
    await screen.findByRole('heading', { name: 'Result', level: 2 });
    expect(within(document.body).getByText('Step 5 of 5')).toBeVisible();
    await expectNoAxeViolations();
  });
});
