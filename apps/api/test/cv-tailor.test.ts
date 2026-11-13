import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { AIProvider } from '../src/ai/provider';
import { createCloudflareAIProvider } from '../src/ai/providers/cloudflare-ai';
import { createGroqProvider } from '../src/ai/providers/groq';
import type { FetchLike } from '../src/ai/providers/http';
import { loadConfig } from '../src/config';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

// Lets two tests force the failure paths that the shared checks normally prevent.
const force = vi.hoisted(() => ({ mode: 'off' as 'off' | 'throw' | 'oversize' }));
vi.mock('@upversion/shared', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const real = original.checkTailoredOutput as (...a: unknown[]) => Record<string, unknown>;
  return {
    ...original,
    checkTailoredOutput: (...args: unknown[]) => {
      const r = real(...args);
      if (force.mode === 'throw') throw new Error('boom');
      // Over the response schema (8000 characters): a serialization failure after the run was counted.
      if (force.mode === 'oversize') return { ...r, text: `${String(r.text)} ${'x'.repeat(9000)}` };
      return r;
    },
  };
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333'; // has not accepted the Terms
const D = '44444444-4444-4444-8444-444444444444';

const CF_ID = 'a'.repeat(32);
const URL_PATH = '/api/v1/me/cv/tailor';

// Fictional texts only. The canary sentence must show up at the provider and nowhere else.
const CANARY = 'The orchid ledger audit saved 14 hours weekly at the Quillmere depot.';
const CV = `Operations analyst with six years in logistics planning.

EXPERIENCE
Operations Analyst, Lantern Freight Ltd    Mar 2018 - Jun 2021
- Handled 300 orders a week and built dashboards in Power BI.
- Wrote SQL queries to find late deliveries and reported them every Monday.
- ${CANARY}

SKILLS
SQL, Excel, Power BI, Jira`;
const JOB =
  'We are hiring an operations analyst to own weekly reporting. You will write SQL, build dashboards in Tableau and manage stakeholders. Experience with Python scripting and process improvement is a plus.';

const ANSWER = `SUMMARY
Operations analyst focused on reporting. Write to fake.person@example.org.

EXPERIENCE
- Handled 300 orders a week and cut late deliveries by 40%.
- Built dashboards in Power BI.
- ${CANARY}

SKILLS
SQL, Power BI, Tableau

===NOTES===
gap: Python scripting
keyword: reporting`;

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const THIRTY = 30;

/** True when any 30-character window of `needle` occurs in `haystack`. */
function leaks(haystack: string, needle: string): boolean {
  for (let i = 0; i + THIRTY <= needle.length; i += 1) {
    const piece = needle.slice(i, i + THIRTY);
    if (piece.trim().length === THIRTY && haystack.includes(piece)) return true;
  }
  return false;
}

interface Captured {
  url: string;
  body: string;
}

describe.skipIf(!dbAvailable)('POST /me/cv/tailor (real Postgres, real provider clients)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp> | undefined;
  let fetched: Captured[];
  let logs: string[];
  let respond: (url: string, call: number) => Response | Promise<Response>;

  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);

  const completion = (content: string, status = 200) =>
    new Response(JSON.stringify({ model: 'stub-model', choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const stubFetch: FetchLike = async (url, init) => {
    fetched.push({ url, body: String(init.body) });
    return respond(url, fetched.length);
  };

  const cloudflare = () =>
    createCloudflareAIProvider({
      accountId: CF_ID,
      apiToken: 'cf-test-token',
      freePlanConfirmed: true,
      fetch: stubFetch,
    });
  const groq = () =>
    createGroqProvider({ apiKey: 'groq-test-key', noCardConfirmed: true, fetch: stubFetch });

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
  });

  const start = async (
    options: {
      providers?: AIProvider[];
      env?: Record<string, string>;
      cvTailor?: boolean;
    } = {},
  ) => {
    const providers = options.providers ?? [cloudflare(), groq()];
    const base = loadConfig({});
    const ai = loadConfig({
      APP_ENV: 'rnd',
      AI_PROVIDERS: providers.map((p) => p.id).join(','),
      AI_FAKE_PROVIDER: providers.some((p) => p.id === 'fake') ? 'true' : 'false',
      AI_BUDGET_GROQ_DAILY: '1000',
      AI_BUDGET_CLOUDFLARE_AI_DAILY: '1000',
      ...options.env,
    }).ai;
    const built = buildApp(
      testConfig({
        appEnv: 'rnd',
        ai,
        rateLimitPerMinute: 100_000,
        logLevel: 'info',
        features: { ...base.features, cvTailor: options.cvTailor ?? true },
      }),
      {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        ai: { providers },
        logStream: { write: (line) => logs.push(line) },
      },
    );
    await built.ready();
    app = built;
    return built;
  };

  beforeEach(async () => {
    force.mode = 'off';
    fetched = [];
    logs = [];
    respond = () => completion(ANSWER);
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query('delete from rnd.ai_provider_usage');
      await c.query(
        `insert into rnd.allowed_emails (email)
         values ('zed.quill@example.com'), ('b@example.com'), ('c@example.com'), ('d@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email, display_name)
         values ($1, 'zed.quill@example.com', 'Zebediah Quillfeather'),
                ($2, 'b@example.com', null), ($3, 'c@example.com', null), ($4, 'd@example.com', null)`,
        [A, B, C, D],
      );
      await acceptCurrentLegal(c, [A, B, D]);
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });
  const post = async (payload: unknown, who: [string, string] = [A, 'zed.quill@example.com']) =>
    app!.inject({
      method: 'POST',
      url: URL_PATH,
      headers: await as(...who),
      payload: payload as object,
    });
  const run = (extra: Record<string, unknown> = {}) => post({ cvText: CV, jobText: JOB, ...extra });

  const tailorRows = () =>
    rows<{ user_id: string; requests: number }>(
      `select user_id, requests from rnd.ai_usage_daily where purpose = 'cv_tailor' order by user_id`,
    );
  const providerRows = () =>
    rows<{ provider_id: string; requests: number }>(
      `select provider_id, requests from rnd.ai_provider_usage order by provider_id`,
    );
  const setProviderUsage = async (id: string, requests: number) =>
    rows(
      `insert into rnd.ai_provider_usage (day, provider_id, requests)
       values ((now() at time zone 'utc')::date, $1, $2)
       on conflict (day, provider_id) do update set requests = $2`,
      [id, requests],
    );
  const seedUsage = async (user: string, requests: number) =>
    rows(
      `insert into rnd.ai_usage_daily (user_id, day, purpose, requests)
       values ($1, (now() at time zone 'utc')::date, 'cv_tailor', $2)`,
      [user, requests],
    );

  // -------------------------------------------------------------------------------------------

  it('tailors a CV: checked answer, providers that received the text, usage', async () => {
    await start();
    const res = await run();
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Object.keys(json).sort()).toEqual(['flags', 'notes', 'providers', 'text', 'usage']);
    expect(json.providers).toEqual([{ id: 'cloudflare-ai', label: 'Cloudflare Workers AI' }]);
    expect(json.usage).toEqual({ used: 1, cap: 3 });
    // The invented email is gone and said so; the invented number and skill are flagged.
    expect(json.text).not.toMatch(EMAIL_RE);
    expect(json.text).toContain(CANARY);
    const kinds = json.notes.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain('output_redacted');
    expect(kinds).toContain('check_number');
    expect(kinds).toContain('check_skill');
    expect(json.notes).toContainEqual({ kind: 'missing_keyword', text: 'Process improvement' });
    expect(json.notes).toContainEqual({ kind: 'model_note', text: 'gap: Python scripting' });
    expect(json.flags.map((f: { kind: string }) => f.kind)).toContain('number');
    // One call, to Cloudflare, with the 8B chat model (json: false).
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.url).toContain('api.cloudflare.com');
    expect(JSON.parse(fetched[0]!.body).model).toBe('@cf/meta/llama-3.1-8b-instruct-fp8-fast');
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
  });

  it('privacy canary at the provider fetch: clean text goes out, personal details never do', async () => {
    await start();
    const res = await run();
    expect(res.statusCode).toBe(200);
    const sent = fetched.map((f) => f.body).join('\n');
    expect(sent).toContain(CANARY); // the capture is real
    expect(sent).not.toMatch(EMAIL_RE);
    for (const token of ['zed.quill', 'Zebediah', 'Quillfeather', 'example.com']) {
      expect(sent).not.toContain(token);
    }
  });

  it.each([
    ['email', 'Write to canary.person@example.org for references.'],
    ['phone', 'Call +1 202 555 0143 any time.'],
    ['url', 'Portfolio at https://canary-portfolio.example.org/me'],
    ['handle', 'Find me as @canary_person on the usual sites.'],
    ['the account email', 'Send mail to zed.quill@example.com.'],
    ['a name token of the account', 'Reference: Zebediah vouches for this.'],
  ])('answers 422 pii_blocked for %s in the CV, with zero provider calls', async (_kind, extra) => {
    await start();
    const address = '14 Marigold Lane, Springfield';
    const res = await post({ cvText: `${address}\n${extra}\n${CV}`, jobText: JOB });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('pii_blocked');
    expect(res.body).not.toContain('Marigold');
    expect(res.body).not.toContain(extra);
    expect(fetched).toHaveLength(0);
    expect(await tailorRows()).toEqual([]);
    expect(await providerRows()).toEqual([]);
  });

  it.each([
    ['email', 'Reply to canary.person@example.org.'],
    ['phone', 'Call +1 202 555 0143.'],
    ['url', 'See https://canary-portfolio.example.org/job'],
    ['handle', 'Ping @canary_person.'],
    ['a name token of the account', 'Ask Zebediah.'],
  ])(
    'answers 422 pii_blocked for %s in the job text, with zero provider calls',
    async (_k, extra) => {
      await start();
      const res = await post({ cvText: CV, jobText: `${JOB} ${extra}` });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('pii_blocked');
      expect(fetched).toHaveLength(0);
      expect(await tailorRows()).toEqual([]);
      expect(await providerRows()).toEqual([]);
    },
  );

  it('lets catalog tool names that look like hosts through, unchanged', async () => {
    await start();
    const res = await post({
      cvText: `${CV}\n- Built ASP.NET dashboards for monday.com customers.`,
      jobText: JOB,
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(fetched[0]!.body).messages as { content: string }[];
    const user = sent[sent.length - 1]!.content;
    expect(user).toContain('Built ASP.NET dashboards for monday.com customers.');
    expect(user).not.toContain('[removed]');
  });

  it('stores nothing: no 30-character piece of the texts or the answer in any table', async () => {
    await start();
    const before = await providerRows();
    expect(before).toEqual([]);
    const res = await run();
    expect(res.statusCode).toBe(200);
    const answer = res.json().text as string;

    const columns = await rows<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'rnd'
          and data_type in ('text', 'character varying', 'character', 'jsonb', 'json', 'ARRAY')
        order by 1, 2`,
    );
    expect(columns.length).toBeGreaterThan(20);
    let blob = '';
    for (const { table_name: t, column_name: c } of columns) {
      const found = await rows<{ v: string }>(
        `select "${c}"::text as v from rnd."${t}" where "${c}" is not null`,
      );
      blob += found.map((r) => r.v).join('\n') + '\n';
    }
    expect(blob.length).toBeGreaterThan(50);
    for (const text of [CV, JOB, ANSWER, answer]) expect(leaks(blob, text)).toBe(false);
    expect(leaks(CV, CV)).toBe(true); // the scan itself works
    expect(await rows(`select 1 from rnd.ai_cache`)).toEqual([]);
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
  });

  it('logs nothing of the texts or the answer on success, 400, 422, 429 and 503', async () => {
    await start({ env: { AI_USER_DAILY_CV_TAILOR: '1' } });
    expect((await run()).statusCode).toBe(200);
    expect((await run()).statusCode).toBe(429); // ai_user_cap
    expect((await post({ cvText: CV, jobText: JOB, userId: A })).statusCode).toBe(400);
    expect(
      (await post({ cvText: `${CV}\ncanary.person@example.org`, jobText: JOB })).statusCode,
    ).toBe(422);
    await app!.close();
    respond = () => completion('', 500);
    await start();
    expect((await run()).statusCode).toBe(503);
    const out = logs.join('\n');
    expect(out.length).toBeGreaterThan(100);
    for (const text of [CV, JOB, ANSWER]) expect(leaks(out, text)).toBe(false);
    expect(out).not.toContain('canary.person');
    expect(out).not.toContain('cf-test-token');
  });

  it('answers 404 when FEATURE_CV_TAILOR is off, and the usage endpoint says so', async () => {
    await start({ cvTailor: false });
    expect((await run()).statusCode).toBe(404);
    expect(fetched).toHaveLength(0);
    const usage = await app!.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: await as(A, 'zed.quill@example.com'),
    });
    expect(usage.json().features).toEqual({ cvTailor: false, planBuilder: false });
  });

  it('shows the meter and the flag on the usage endpoint when on', async () => {
    await start();
    await run();
    const usage = await app!.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: await as(A, 'zed.quill@example.com'),
    });
    expect(usage.json().features).toEqual({ cvTailor: true, planBuilder: false });
    expect(usage.json().user.cvTailor).toEqual({ used: 1, cap: 3 });
    // Another user sees their own meter only (RLS unaffected).
    const other = await app!.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: await as(B, 'b@example.com'),
    });
    expect(other.json().user.cvTailor).toEqual({ used: 0, cap: 3 });
  });

  it('needs a token and accepted Terms', async () => {
    await start();
    const anon = await app!.inject({
      method: 'POST',
      url: URL_PATH,
      payload: { cvText: CV, jobText: JOB },
    });
    expect(anon.statusCode).toBe(401);
    const terms = await post({ cvText: CV, jobText: JOB }, [C, 'c@example.com']);
    expect(terms.statusCode).toBe(403);
    expect(terms.json().error.code).toBe('terms_not_accepted');
    expect(fetched).toHaveLength(0);
    expect(await tailorRows()).toEqual([]);
  });

  it('is strict about the body: unknown keys, userId, sizes, role, NUL', async () => {
    await start();
    const bad = async (payload: Record<string, unknown>, status: number) => {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(Object.keys(payload))).toBe(status);
    };
    await bad({ cvText: CV, jobText: JOB, extra: 1 }, 400);
    await bad({ cvText: CV, jobText: JOB, userId: B }, 400);
    await bad({ cvText: CV, jobText: JOB, user_id: B }, 400);
    await bad({ cvText: 'too short', jobText: JOB }, 400);
    await bad({ cvText: CV, jobText: 'too short' }, 400);
    await bad({ cvText: 'x'.repeat(6001), jobText: JOB }, 400);
    await bad({ cvText: CV, jobText: 'y'.repeat(3001) }, 400);
    await bad({ cvText: CV, jobText: JOB, roleId: 'no-such-role-id' }, 400);
    await bad({ cvText: `${CV}\u0000`, jobText: JOB }, 422);
    expect(fetched).toHaveLength(0);
    expect(await tailorRows()).toEqual([]);
  });

  it('adds the catalog title of a known role to the prompt', async () => {
    const { CATALOG_TAXONOMY } = await import('@upversion/shared');
    const role = CATALOG_TAXONOMY.roles[0]!;
    await start();
    const res = await run({ roleId: role.id });
    expect(res.statusCode).toBe(200);
    expect(fetched[0]!.body).toContain(`Target role: ${role.title}`);
  });

  it('rate limits per user: 3 per minute, then 429 rate_limited', async () => {
    await start({ env: { AI_USER_DAILY_CV_TAILOR: '10' } });
    for (let i = 0; i < 3; i += 1) expect((await run()).statusCode).toBe(200);
    const res = await run();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(fetched).toHaveLength(3);
    // Another user has their own window.
    expect((await post({ cvText: CV, jobText: JOB }, [B, 'b@example.com'])).statusCode).toBe(200);
  });

  it('caps runs per user per day: 429 ai_user_cap, nothing sent for the refused run', async () => {
    await start({ env: { AI_USER_DAILY_CV_TAILOR: '2' } });
    expect((await run()).statusCode).toBe(200);
    expect((await run()).statusCode).toBe(200);
    const res = await run();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('ai_user_cap');
    expect(res.json().error.fallbacks).toEqual(['keyword_list', 'copy_prompt']);
    expect(fetched).toHaveLength(2);
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 2 }]);
  });

  it('caps runs app-wide, summed from the database over all users, across restarts', async () => {
    await seedUsage(B, 1);
    await seedUsage(D, 1);
    await start({ env: { AI_CV_TAILOR_DAILY_TOTAL: '2' } });
    const res = await run();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('ai_feature_cap');
    expect(fetched).toHaveLength(0);
    expect((await tailorRows()).map((r) => r.user_id)).not.toContain(A);
    // A restart changes nothing: the count is in the database, not in memory.
    await app!.close();
    await start({ env: { AI_CV_TAILOR_DAILY_TOTAL: '2' } });
    expect((await run()).json().error.code).toBe('ai_feature_cap');
    // One below the cap passes, and that run is what fills it.
    await app!.close();
    await start({ env: { AI_CV_TAILOR_DAILY_TOTAL: '3' } });
    expect((await run()).statusCode).toBe(200);
    expect((await run()).json().error.code).toBe('ai_feature_cap');
    expect(fetched).toHaveLength(1);
  });

  it('a run refused for "no provider" adds nothing to the user or the app-wide count', async () => {
    await start({ providers: [] });
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ai_unavailable');
    expect(res.json().error.fallbacks).toEqual(['keyword_list']);
    expect(fetched).toHaveLength(0);
    expect(await tailorRows()).toEqual([]);
  });

  it('budget exhausted: 503, and neither the user count nor the app-wide count moves', async () => {
    await setProviderUsage('cloudflare-ai', 1000);
    await setProviderUsage('groq', 1000);
    await start();
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ai_unavailable');
    expect(fetched).toHaveLength(0);
    // The fix: before it, the gateway reserved the user's run first and refunded nothing.
    expect(await tailorRows()).toEqual([]);
    const total = await rows<{ n: string }>(
      `select coalesce(sum(requests), 0)::text as n from rnd.ai_usage_daily where purpose = 'cv_tailor'`,
    );
    expect(Number(total[0]!.n)).toBe(0);
  });

  it('falls back to Groq after Cloudflare fails; both providers are named', async () => {
    respond = (url) => (url.includes('cloudflare') ? completion('', 500) : completion(ANSWER));
    await start();
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.json().providers).toEqual([
      { id: 'cloudflare-ai', label: 'Cloudflare Workers AI' },
      { id: 'groq', label: 'Groq' },
    ]);
    expect(fetched.map((f) => new URL(f.url).hostname)).toEqual([
      'api.cloudflare.com',
      'api.groq.com',
    ]);
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
  });

  it('both providers fail: 503 without provider information, the run stays counted', async () => {
    respond = () => completion('', 500);
    await start();
    const res = await run();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: {
        code: 'ai_unavailable',
        message: 'CV tailoring is not available right now.',
        requestId: expect.any(String),
        fallbacks: ['keyword_list'],
      },
    });
    expect(fetched).toHaveLength(2);
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
  });

  it('never reaches a third provider, even one ahead in the global order; its small window is ignored', async () => {
    const reached: string[] = [];
    const other: AIProvider = {
      id: 'fake',
      label: 'Other',
      costTier: 'free',
      maxContextChars: 100,
      async generate() {
        reached.push('fake');
        return { text: ANSWER };
      },
    };
    await start({ providers: [other, cloudflare(), groq()] });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(reached).toEqual([]);
    expect(res.json().providers.map((p: { id: string }) => p.id)).toEqual(['cloudflare-ai']);

    // With Cloudflare and Groq both failing, the third provider still gets nothing.
    await app!.close();
    respond = () => completion('', 500);
    await start({ providers: [other, cloudflare(), groq()] });
    expect((await post({ cvText: CV, jobText: JOB }, [B, 'b@example.com'])).statusCode).toBe(503);
    expect(reached).toEqual([]);
  });

  it('turns a broken answer into plain text with a note, and still redacts it', async () => {
    respond = () => completion('Sure! Here you go, mail me at oops.person@example.org.');
    await start();
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.json().text).not.toMatch(EMAIL_RE);
    expect(res.json().notes.map((n: { kind: string }) => n.kind)).toContain('output_redacted');
  });

  it('caps flags at 100 with text of at most 200 characters: a 200, not a 500 after the run was counted', async () => {
    const numbers = Array.from({ length: 150 }, (_, i) => `- Saved ${1000 + i} hours`).join('\n');
    const words = Array.from({ length: 40 }, (_, i) => `Zq${String.fromCharCode(97 + (i % 26))}x`);
    const title = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
    respond = () =>
      completion(
        `SUMMARY\nAnalyst.\n\nEXPERIENCE\n${numbers}\n- Worked at ${title}\n\nSKILLS\nSQL`,
      );
    await start();
    const res = await run();
    expect(res.statusCode).toBe(200);
    const { flags } = res.json();
    expect(flags.length).toBeLessThanOrEqual(100);
    expect(flags.length).toBeGreaterThan(50);
    for (const f of flags) expect(f.text.length).toBeLessThanOrEqual(200);
    expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
  });

  it.each(['throw', 'oversize'] as const)(
    'a failure after the run was counted (%s) is a 500 and logs nothing of the texts or the answer',
    async (mode) => {
      await start();
      force.mode = mode;
      const res = await run();
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('internal_error');
      for (const text of [CV, JOB, ANSWER]) expect(leaks(res.body, text)).toBe(false);
      const out = logs.join('\n');
      expect(out).toContain('unhandled error');
      for (const text of [CV, JOB, ANSWER]) expect(leaks(out, text)).toBe(false);
      expect(await tailorRows()).toEqual([{ user_id: A, requests: 1 }]);
    },
  );

  it('does not let a user see or change another user’s counter (RLS)', async () => {
    await start();
    await post({ cvText: CV, jobText: JOB }, [B, 'b@example.com']);
    const res = await run();
    expect(res.json().usage).toEqual({ used: 1, cap: 3 });
    expect(await tailorRows()).toEqual([
      { user_id: A, requests: 1 },
      { user_id: B, requests: 1 },
    ]);
  });
});
