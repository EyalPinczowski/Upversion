import { PiiLeakError } from '@upversion/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { AIUsageStore } from '../src/ai/budget';
import type { AICache } from '../src/ai/cache';
import {
  AIAbortedError,
  AIUnavailableError,
  AIUserCapError,
  createAIGateway,
  type GatewayConfig,
} from '../src/ai/gateway';
import {
  ProviderQuotaError,
  ProviderUnavailableError,
  type AIProvider,
  type AIPurpose,
} from '../src/ai/provider';
import { createFakeProvider, FakeProviderRefusedError } from '../src/ai/providers/fake';
import { createAIRegistry } from '../src/ai/registry';
import {
  buildSafeRequest,
  isSafeAIRequest,
  truncateHistory,
  type SafeAIRequest,
} from '../src/ai/safe-request';
import { testConfig } from './helpers';

// Lets one test switch redaction off, so only the final gate stands between text and the model.
const redaction = vi.hoisted(() => ({ off: false }));
vi.mock('@upversion/shared', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    redactPii: (text: string, options?: unknown) =>
      redaction.off
        ? { text, count: 0 }
        : (original.redactPii as (t: string, o?: unknown) => unknown)(text, options),
  };
});

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const request = (over: Partial<Parameters<typeof buildSafeRequest>[0]> = {}): SafeAIRequest =>
  buildSafeRequest(
    {
      purpose: 'practice_message',
      system: 'You are a practice coach.',
      messages: [{ role: 'user', content: 'Ask me a question about caching.' }],
      maxOutputTokens: 300,
      json: false,
      ...over,
    },
    [],
  );

/** An in-memory stand-in for the database counters, with the same atomic rules. */
function memoryUsage(log: string[] = []) {
  const users = new Map<string, number>();
  const providers = new Map<string, number>();
  const avoided: string[] = [];
  const store: AIUsageStore = {
    async reserveUser(userId, purpose, cap) {
      const key = `${userId}:${purpose}`;
      const n = users.get(key) ?? 0;
      if (cap < 1 || n >= cap) return { ok: false };
      users.set(key, n + 1);
      log.push(`user:${userId}`);
      return { ok: true };
    },
    async noteAvoided(userId, purpose) {
      avoided.push(`${userId}:${purpose}`);
    },
    async reserveProvider(_userId, providerId, budget) {
      const n = providers.get(providerId) ?? 0;
      if (budget < 1 || n >= budget) return false;
      providers.set(providerId, n + 1);
      log.push(`reserve:${providerId}`);
      return true;
    },
    async providerUsage() {
      return Object.fromEntries(providers);
    },
    async cvTailorTotalToday() {
      return [...users].reduce((n, [key, v]) => (key.endsWith(':cv_tailor') ? n + v : n), 0);
    },
    async snapshot() {
      throw new Error('not used');
    },
  };
  return { store, users, providers, avoided };
}

function memoryCache(): AICache & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async get(userId, key) {
      return rows.get(`${userId}:${key}`) ?? null;
    },
    async put(userId, key, _purpose, text) {
      rows.set(`${userId}:${key}`, text);
    },
  };
}

type Behaviour = (signal: AbortSignal) => Promise<string>;
function provider(
  id: string,
  behaviour: Behaviour,
  calls: string[] = [],
  log: string[] = [],
): AIProvider {
  return {
    id,
    label: `Label ${id}`,
    costTier: 'free',
    maxContextChars: 8000,
    async generate(_req, { signal }) {
      calls.push(id);
      log.push(`call:${id}`);
      return { text: await behaviour(signal), model: `${id}-model` };
    },
  };
}
const ok =
  (text = 'hello'): Behaviour =>
  async () =>
    text;

function setup(
  providers: AIProvider[],
  over: Partial<GatewayConfig> = {},
  extra: { cache?: AICache | null; now?: () => Date; log?: string[] } = {},
) {
  const registry = createAIRegistry();
  for (const p of providers) registry.register(p);
  const usage = memoryUsage(extra.log);
  const warnings: Record<string, unknown>[] = [];
  const config: GatewayConfig = {
    providerOrder: providers.map((p) => p.id),
    budgets: Object.fromEntries(providers.map((p) => [p.id, 100])),
    userCaps: { practice_message: 5, practice_feedback: 2, day_overview: 1, cv_tailor: 3 },
    timeoutMs: 1000,
    turnTimeoutMs: 5000,
    historyChars: 12000,
    ...over,
  };
  const gateway = createAIGateway({
    registry,
    config,
    usage: usage.store,
    cache: extra.cache ?? null,
    now: extra.now,
    log: { warn: (obj) => warnings.push(obj) },
  });
  return { gateway, usage, warnings, config };
}

describe('fallback and cooldown', () => {
  it('falls back on a 429 and reports the switch', async () => {
    const calls: string[] = [];
    const { gateway } = setup([
      provider('one', async () => Promise.reject(new ProviderQuotaError()), calls),
      provider('two', ok('from two'), calls),
    ]);
    const result = await gateway.generate({ userId: USER_A, request: request() });
    expect(result).toMatchObject({
      text: 'from two',
      providerId: 'two',
      label: 'Label two',
      model: 'two-model',
      switched: { from: 'one', to: 'two', reason: 'quota' },
      cached: false,
    });
    expect(calls).toEqual(['one', 'two']);
  });

  it('makes no call to a cooled provider and keeps reporting the switch', async () => {
    let now = new Date('2026-11-01T10:00:00Z');
    const calls: string[] = [];
    const retryAt = new Date('2026-11-01T10:30:00Z');
    const { gateway } = setup(
      [
        provider('one', () => Promise.reject(new ProviderQuotaError(retryAt)), calls),
        provider('two', ok(), calls),
      ],
      {},
      { now: () => now },
    );
    await gateway.generate({ userId: USER_A, request: request() });
    calls.length = 0;
    const second = await gateway.generate({ userId: USER_A, request: request() });
    expect(calls).toEqual(['two']);
    expect(second.switched).toEqual({ from: 'one', to: 'two', reason: 'quota' });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(retryAt);

    now = new Date('2026-11-01T10:31:00Z');
    calls.length = 0;
    await gateway.generate({ userId: USER_A, request: request() });
    // The cooldown is over, so the first provider is tried again (and fails again).
    expect(calls).toEqual(['one', 'two']);
  });

  it('cools a 429 without retry-after until 00:00 UTC', async () => {
    const now = new Date('2026-11-01T22:00:00Z');
    const { gateway } = setup(
      [provider('one', () => Promise.reject(new ProviderQuotaError())), provider('two', ok())],
      {},
      { now: () => now },
    );
    await gateway.generate({ userId: USER_A, request: request() });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(new Date('2026-11-02T00:00:00Z'));
  });

  it('cools an unavailable provider for 60 seconds', async () => {
    const now = new Date('2026-11-01T10:00:00Z');
    const { gateway } = setup(
      [
        provider('one', () => Promise.reject(new ProviderUnavailableError())),
        provider('two', ok()),
      ],
      {},
      { now: () => now },
    );
    const result = await gateway.generate({ userId: USER_A, request: request() });
    expect(result.switched).toEqual({ from: 'one', to: 'two', reason: 'error' });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(new Date('2026-11-01T10:01:00Z'));
  });

  it('makes at most one attempt per provider and ends in AIUnavailable', async () => {
    const calls: string[] = [];
    const { gateway } = setup([
      provider('one', () => Promise.reject(new ProviderUnavailableError()), calls),
      provider('two', () => Promise.reject(new ProviderQuotaError()), calls),
    ]);
    const error = await gateway
      .generate({ userId: USER_A, request: request() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIUnavailableError);
    expect((error as AIUnavailableError).statusCode).toBe(503);
    expect((error as AIUnavailableError).reason).toBe('exhausted');
    expect(calls).toEqual(['one', 'two']);
  });

  it('treats an empty answer as a failed attempt', async () => {
    const { gateway } = setup([provider('one', ok('   ')), provider('two', ok('fine'))]);
    const result = await gateway.generate({ userId: USER_A, request: request() });
    expect(result.providerId).toBe('two');
    expect(result.switched?.reason).toBe('error');
  });
});

describe('cooldown rules (review fixes)', () => {
  const NOW = new Date('2026-11-01T10:00:00Z');

  it.each([
    ['a zero retry-after', new Date(NOW.getTime())],
    ['a past retry-after', new Date(NOW.getTime() - 1000)],
    ['a 1 s retry-after', new Date(NOW.getTime() + 1000)],
  ])('%s cools for at least 5 seconds, not until midnight', async (_name, retryAt) => {
    const { gateway } = setup(
      [
        provider('one', () => Promise.reject(new ProviderQuotaError(retryAt))),
        provider('two', ok()),
      ],
      {},
      { now: () => NOW },
    );
    await gateway.generate({ userId: USER_A, request: request() });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(new Date(NOW.getTime() + 5000));
  });

  it('caps a huge retry-after at 24 hours', async () => {
    const { gateway } = setup(
      [
        provider('one', () =>
          Promise.reject(new ProviderQuotaError(new Date('2027-01-01T00:00:00Z'))),
        ),
        provider('two', ok()),
      ],
      {},
      { now: () => NOW },
    );
    await gateway.generate({ userId: USER_A, request: request() });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(new Date('2026-11-02T10:00:00Z'));
  });

  it('a request-specific failure (such as a 400) sets no shared cooldown', async () => {
    const calls: string[] = [];
    const { gateway } = setup(
      [
        provider('one', () => Promise.reject(new ProviderUnavailableError(true)), calls),
        provider('two', ok(), calls),
      ],
      {},
      { now: () => NOW },
    );
    const first = await gateway.generate({ userId: USER_A, request: request() });
    expect(first.switched).toEqual({ from: 'one', to: 'two', reason: 'error' });
    expect(gateway.providers()[0]!.cooldownUntil).toBeNull();
    calls.length = 0;
    await gateway.generate({ userId: USER_B, request: request() });
    expect(calls).toEqual(['one', 'two']); // the next user still gets the first provider
  });

  it('a 5xx or network failure still cools the provider', async () => {
    const { gateway } = setup(
      [
        provider('one', () => Promise.reject(new ProviderUnavailableError())),
        provider('two', ok()),
      ],
      {},
      { now: () => NOW },
    );
    await gateway.generate({ userId: USER_A, request: request() });
    expect(gateway.providers()[0]!.cooldownUntil).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

describe('error bodies', () => {
  it('the user-cap answer carries the fallbacks', async () => {
    const app = buildApp(testConfig(), { db: null });
    app.get('/cap', async () => {
      throw new AIUserCapError('practice_message');
    });
    app.get('/gone', async () => {
      throw new AIAbortedError();
    });
    await app.ready();
    const cap = await app.inject({ method: 'GET', url: '/cap' });
    expect(cap.statusCode).toBe(429);
    expect(cap.json().error).toMatchObject({
      code: 'ai_user_cap',
      fallbacks: ['copy_prompt', 'self_rubric'],
    });
    const gone = await app.inject({ method: 'GET', url: '/gone' });
    expect(gone.statusCode).toBe(499);
    expect(gone.json().error.code).toBe('client_closed_request');
    await app.close();
  });
});

describe('timeouts and aborting', () => {
  it('moves on after the provider timeout and really aborts the call', async () => {
    let seen: AbortSignal | undefined;
    const { gateway } = setup(
      [
        provider('slow', (signal) => {
          seen = signal;
          return new Promise<string>(() => undefined); // ignores the signal and never answers
        }),
        provider('two', ok('quick')),
      ],
      { timeoutMs: 30 },
    );
    const result = await gateway.generate({ userId: USER_A, request: request() });
    expect(result).toMatchObject({
      providerId: 'two',
      switched: { from: 'slow', reason: 'timeout' },
    });
    expect(seen?.aborted).toBe(true);
  });

  it('stops at the whole-turn deadline', async () => {
    // Fake timers: no real waiting, so a slow CI runner cannot change the outcome.
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const hang: Behaviour = () => new Promise<string>(() => undefined);
      // The wall clock can read a millisecond earlier than the timers that just fired (they run
      // on the event loop's own clock). Once the second provider is called, make it do that.
      let skewMs = 0;
      const { gateway } = setup(
        [
          provider('a', hang, calls),
          provider(
            'b',
            (signal) => {
              skewMs = 1;
              return hang(signal);
            },
            calls,
          ),
          provider('c', ok(), calls),
        ],
        { timeoutMs: 40, turnTimeoutMs: 60 },
        { now: () => new Date(Date.now() - skewMs) },
      );
      const outcome = gateway.generate({ userId: USER_A, request: request() }).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(await outcome).toBeInstanceOf(AIUnavailableError);
      expect(calls).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the call in flight when the caller aborts, and does not try the next provider', async () => {
    const calls: string[] = [];
    let seen: AbortSignal | undefined;
    const { gateway } = setup([
      provider(
        'one',
        (signal) => {
          seen = signal;
          return new Promise<string>(() => undefined);
        },
        calls,
      ),
      provider('two', ok(), calls),
    ]);
    const controller = new AbortController();
    const pending = gateway.generate({
      userId: USER_A,
      request: request(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AIAbortedError);
    expect(seen?.aborted).toBe(true);
    expect(calls).toEqual(['one']);
  });
});

describe('budgets and caps', () => {
  it('reserves the provider budget before the call, and a failed call still counts', async () => {
    const log: string[] = [];
    const { gateway, usage } = setup(
      [provider('one', () => Promise.reject(new ProviderUnavailableError()), [], log)],
      {},
      { log },
    );
    await gateway.generate({ userId: USER_A, request: request() }).catch(() => undefined);
    expect(log).toEqual(['user:' + USER_A, 'reserve:one', 'call:one']);
    expect(usage.providers.get('one')).toBe(1);
  });

  it('skips a provider whose environment budget is 0 or unset, without reserving', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup(
      [provider('zero', ok(), calls), provider('unset', ok(), calls), provider('two', ok(), calls)],
      { budgets: { zero: 0, two: 10 } },
    );
    const result = await gateway.generate({ userId: USER_A, request: request() });
    expect(calls).toEqual(['two']);
    expect(usage.providers.has('zero')).toBe(false);
    expect(usage.providers.has('unset')).toBe(false);
    expect(result.switched).toBeNull();
  });

  it('answers AIUnavailable (not_configured) and spends no user call when nothing is usable', async () => {
    const empty = setup([]);
    const error = await empty.gateway
      .generate({ userId: USER_A, request: request() })
      .catch((e: unknown) => e);
    expect((error as AIUnavailableError).reason).toBe('not_configured');
    expect(empty.usage.users.size).toBe(0);

    const noBudget = setup([provider('one', ok())], { budgets: {} });
    await expect(
      noBudget.gateway.generate({ userId: USER_A, request: request() }),
    ).rejects.toBeInstanceOf(AIUnavailableError);
    expect(noBudget.usage.users.size).toBe(0);
  });

  it('moves to the next provider when the budget is used up', async () => {
    const calls: string[] = [];
    const { gateway } = setup([provider('one', ok(), calls), provider('two', ok(), calls)], {
      budgets: { one: 1, two: 5 },
    });
    await gateway.generate({ userId: USER_A, request: request() });
    const second = await gateway.generate({ userId: USER_A, request: request() });
    expect(calls).toEqual(['one', 'two']);
    expect(second.switched).toEqual({ from: 'one', to: 'two', reason: 'quota' });
  });

  it('stops a user at the cap (429) while another user still succeeds', async () => {
    const calls: string[] = [];
    const { gateway } = setup([provider('one', ok(), calls)], {
      userCaps: { practice_message: 2, practice_feedback: 2, day_overview: 1, cv_tailor: 3 },
    });
    await gateway.generate({ userId: USER_A, request: request() });
    await gateway.generate({ userId: USER_A, request: request() });
    const error = await gateway
      .generate({ userId: USER_A, request: request() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIUserCapError);
    expect((error as AIUserCapError).statusCode).toBe(429);
    expect((error as AIUserCapError).code).toBe('ai_user_cap');
    expect((error as AIUserCapError).fallbacks).toEqual(['copy_prompt', 'self_rubric']);
    expect(calls).toHaveLength(2);
    await expect(gateway.generate({ userId: USER_B, request: request() })).resolves.toMatchObject({
      providerId: 'one',
    });
  });

  it('does not reserve the user cap again when the caller already did', async () => {
    const { gateway, usage } = setup([provider('one', ok())]);
    await gateway.generate({ userId: USER_A, request: request(), userCap: 'already_reserved' });
    expect(usage.users.size).toBe(0);
  });

  it('treats a cap of 0 as no calls allowed', async () => {
    const { gateway } = setup([provider('one', ok())], {
      userCaps: { practice_message: 0, practice_feedback: 0, day_overview: 0, cv_tailor: 3 },
    });
    await expect(gateway.generate({ userId: USER_A, request: request() })).rejects.toBeInstanceOf(
      AIUserCapError,
    );
  });
});

describe('cache', () => {
  const overview = () =>
    request({
      purpose: 'day_overview',
      messages: [{ role: 'user', content: 'Overview of today.' }],
    });

  it('a hit makes no provider call, spends nothing and counts as avoided', async () => {
    const cache = memoryCache();
    const calls: string[] = [];
    const { gateway, usage } = setup([provider('one', ok('the overview'), calls)], {}, { cache });
    const first = await gateway.generate({ userId: USER_A, request: overview() });
    expect(first.cached).toBe(false);
    const second = await gateway.generate({ userId: USER_A, request: overview() });
    expect(second).toMatchObject({ text: 'the overview', cached: true, providerId: null });
    expect(calls).toHaveLength(1);
    expect(usage.providers.get('one')).toBe(1);
    expect(usage.users.get(`${USER_A}:day_overview`)).toBe(1);
    expect(usage.avoided).toEqual([`${USER_A}:day_overview`]);
  });

  it('is per user', async () => {
    const cache = memoryCache();
    const calls: string[] = [];
    const { gateway } = setup([provider('one', ok(), calls)], {}, { cache });
    await gateway.generate({ userId: USER_A, request: overview() });
    await gateway.generate({ userId: USER_B, request: overview() });
    expect(calls).toHaveLength(2);
  });

  it('never caches chat turns', async () => {
    const cache = memoryCache();
    const calls: string[] = [];
    const { gateway } = setup([provider('one', ok(), calls)], {}, { cache });
    await gateway.generate({ userId: USER_A, request: request() });
    await gateway.generate({ userId: USER_A, request: request() });
    expect(calls).toHaveLength(2);
    expect(cache.rows.size).toBe(0);
  });

  it('survives a broken cache', async () => {
    const broken: AICache = {
      get: () => Promise.reject(new Error('db down')),
      put: () => Promise.reject(new Error('db down')),
    };
    const { gateway } = setup([provider('one', ok('x'))], {}, { cache: broken });
    await expect(gateway.generate({ userId: USER_A, request: overview() })).resolves.toMatchObject({
      text: 'x',
    });
  });
});

describe('the privacy guard', () => {
  it('PiiLeakError blocks the call: no request exists, so no provider is reached', () => {
    redaction.off = true;
    try {
      expect(() => request({ system: 'Contact hr@acme.io for details' })).toThrow(PiiLeakError);
      expect(() =>
        buildSafeRequest(
          {
            purpose: 'practice_message',
            system: 's',
            messages: [{ role: 'user', content: 'I am Dana Levi' }],
            maxOutputTokens: 100,
            json: false,
          },
          ['Dana'],
        ),
      ).toThrow(PiiLeakError);
    } finally {
      redaction.off = false;
    }
  });

  it('redacts a known identifier and an email in every string', () => {
    const built = buildSafeRequest(
      {
        purpose: 'practice_message',
        system: 'Coach for Dana.',
        messages: [{ role: 'user', content: 'I am Dana, mail dana@example.com' }],
        maxOutputTokens: 100,
        json: false,
      },
      ['Dana'],
    );
    expect(JSON.stringify(built)).not.toMatch(/Dana|dana@/);
  });

  it('is the only way to make a request: raw objects fail the types and the run-time check', async () => {
    const { gateway } = setup([provider('one', ok())]);
    const raw = {
      purpose: 'practice_message' as AIPurpose,
      system: 'x',
      messages: [{ role: 'user' as const, content: 'jane@example.com' }],
      maxOutputTokens: 100,
      json: false,
    };
    // @ts-expect-error a raw object is not a SafeAIRequest
    const attempt = gateway.generate({ userId: USER_A, request: raw });
    await expect(attempt).rejects.toThrow(TypeError);
    expect(isSafeAIRequest(raw)).toBe(false);
    expect(isSafeAIRequest(request())).toBe(true);
  });

  it('rejects a request that is out of bounds', () => {
    expect(() => request({ maxOutputTokens: 100_000 })).toThrow();
    expect(() => request({ messages: [] })).toThrow();
  });
});

describe('history truncation', () => {
  const turn = (n: number, size: number) => ({
    role: n % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${n}`.padEnd(size, 'x'),
  });
  it('keeps the newest turns that fit and notes the omission', () => {
    const out = truncateHistory([turn(0, 100), turn(1, 100), turn(2, 100), turn(3, 100)], 250);
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toMatch(/^\[Earlier turns omitted\.\]\n2x/);
    expect(out[1]!.content.startsWith('3x')).toBe(true);
  });
  it('always keeps the last turn and changes nothing when everything fits', () => {
    expect(truncateHistory([turn(0, 500)], 10)).toHaveLength(1);
    const all = [turn(0, 5), turn(1, 5)];
    expect(truncateHistory(all, 100)).toEqual(all);
  });
});

describe('the paid and fake providers', () => {
  it('a paid provider is refused by the registry and never reached', async () => {
    const calls: string[] = [];
    const paid = { ...provider('paid', ok(), calls), costTier: 'paid' as const };
    const registry = createAIRegistry({ allowPaid: false });
    expect(() => registry.register(paid)).toThrow(/paid providers are disabled/);
    const gateway = createAIGateway({
      registry,
      config: {
        providerOrder: ['paid'],
        budgets: { paid: 10 },
        userCaps: { practice_message: 5, practice_feedback: 5, day_overview: 5, cv_tailor: 3 },
        timeoutMs: 100,
        turnTimeoutMs: 200,
        historyChars: 1000,
      },
      usage: memoryUsage().store,
    });
    await expect(gateway.generate({ userId: USER_A, request: request() })).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
    expect(calls).toEqual([]);
  });

  it('the fake provider is refused outside R&D', () => {
    expect(() => createFakeProvider({ appEnv: 'operational' })).toThrow(FakeProviderRefusedError);
    expect(() => createFakeProvider({ appEnv: 'anything' })).toThrow(FakeProviderRefusedError);
    expect(createFakeProvider({ appEnv: 'rnd' }).costTier).toBe('free');
  });

  it('the fake provider captures what would be sent and answers JSON when asked', async () => {
    const captured: SafeAIRequest[] = [];
    const fake = createFakeProvider({ appEnv: 'rnd', captured });
    const signal = new AbortController().signal;
    const json = await fake.generate(request({ json: true }), { signal });
    expect(JSON.parse(json.text)).toMatchObject({ score: 7 });
    expect(captured).toHaveLength(1);
  });
});

describe('no provider configured', () => {
  it('reports configured: false everywhere and never errors on its own', () => {
    const { gateway } = setup([], { providerOrder: [] });
    expect(gateway.providers()).toEqual([]);
    expect(gateway.historyLimitChars()).toBe(12000);
  });

  it('lists an unregistered id as not configured', () => {
    const { gateway } = setup([], { providerOrder: ['groq'], budgets: { groq: 10 } });
    expect(gateway.providers()).toEqual([
      { id: 'groq', label: 'groq', configured: false, budget: null, cooldownUntil: null },
    ]);
  });

  it('builds the app with AI off', async () => {
    const app = buildApp(testConfig(), { db: null });
    await app.ready();
    expect(app.aiGateway.providers()).toEqual([]);
    await app.close();
  });
});

describe('provider error text stays out of responses and logs', () => {
  it('shows neither in the HTTP answer nor in the captured log stream', async () => {
    const SECRET = 'SECRET-PROVIDER-TEXT sk-live-abc123 jane@example.com';
    const lines: string[] = [];
    const throwing: AIProvider = {
      id: 'fake',
      label: 'Throwing',
      costTier: 'free',
      maxContextChars: 1000,
      async generate() {
        throw new Error(SECRET);
      },
    };
    const quota: AIProvider = {
      ...throwing,
      id: 'groq',
      async generate() {
        const e = new ProviderQuotaError();
        (e as { message: string }).message = SECRET;
        throw e;
      },
    };
    const config = testConfig({
      logLevel: 'trace',
      appEnv: 'rnd',
    });
    config.ai = {
      ...config.ai,
      providerOrder: ['groq', 'fake'],
      budgets: { groq: 10, fake: 10 },
    };
    const app = buildApp(config, {
      db: null,
      logStream: { write: (line) => lines.push(line) },
      ai: { providers: [quota, throwing], usage: memoryUsage().store, cache: null },
    });
    app.get('/probe', async () => app.aiGateway.generate({ userId: USER_A, request: request() }));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ai_unavailable');
    expect(res.body).not.toMatch(/SECRET|sk-live|jane@/);
    const logged = lines.join('\n');
    expect(logged).toMatch(/ai provider failed/);
    expect(logged).not.toMatch(/SECRET|sk-live|jane@/);
    await app.close();
  });

  it('maps a PiiLeakError to 422 pii_blocked', async () => {
    const app = buildApp(testConfig(), { db: null });
    app.get('/pii', async () => {
      throw new PiiLeakError(['email']);
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/pii' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('pii_blocked');
    expect(res.body).not.toMatch(/email/);
    await app.close();
  });
});

describe('providers option and the budget check before the user’s reservation (ADR 016)', () => {
  const cv = () =>
    request({ purpose: 'cv_tailor', messages: [{ role: 'user', content: 'Tailor this CV.' }] });

  it('only consults the listed providers, in that order, and never another', async () => {
    const calls: string[] = [];
    const { gateway } = setup([
      provider('first', ok('from first'), calls),
      provider('second', ok('from second'), calls),
      provider('third', ok('from third'), calls),
    ]);
    const res = await gateway.generate({
      userId: USER_A,
      request: cv(),
      providers: ['third', 'second'],
    });
    expect(res.providerId).toBe('third');
    expect(res.sentTo).toEqual(['third']);
    expect(calls).toEqual(['third']);
  });

  it('lists every provider that received the text, the failed one first', async () => {
    const calls: string[] = [];
    const { gateway } = setup([
      provider('one', async () => Promise.reject(new ProviderUnavailableError()), calls),
      provider('two', ok('from two'), calls),
      provider('other', ok('from other'), calls),
    ]);
    const res = await gateway.generate({
      userId: USER_A,
      request: cv(),
      providers: ['one', 'two'],
    });
    expect(res.sentTo).toEqual(['one', 'two']);
    expect(res.switched).toMatchObject({ from: 'one', to: 'two' });
    expect(calls).toEqual(['one', 'two']);
  });

  it('ends in 503 without reaching an unlisted provider when the listed ones fail', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup([
      provider('one', async () => Promise.reject(new ProviderUnavailableError()), calls),
      provider('other', ok('from other'), calls),
    ]);
    await expect(
      gateway.generate({ userId: USER_A, request: cv(), providers: ['one'] }),
    ).rejects.toBeInstanceOf(AIUnavailableError);
    expect(calls).toEqual(['one']);
    // A provider was attempted, so the user's call stays reserved.
    expect(usage.users.get(`${USER_A}:cv_tailor`)).toBe(1);
  });

  it('judges "usable" on the listed providers only', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup([
      provider('one', ok('x'), calls),
      provider('two', ok('y'), calls),
    ]);
    await expect(
      gateway.generate({ userId: USER_A, request: cv(), providers: ['missing'] }),
    ).rejects.toBeInstanceOf(AIUnavailableError);
    expect(calls).toEqual([]);
    expect(usage.users.size).toBe(0);
  });

  it('does not reserve the user’s call when every budget is already used up', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup(
      [provider('one', ok('x'), calls), provider('two', ok('y'), calls)],
      { budgets: { one: 1, two: 1 } },
    );
    usage.providers.set('one', 1);
    usage.providers.set('two', 1);
    await expect(gateway.generate({ userId: USER_A, request: cv() })).rejects.toMatchObject({
      reason: 'exhausted',
    });
    expect(calls).toEqual([]);
    expect(usage.users.size).toBe(0);
  });

  it('checks the budget of the listed providers only', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup(
      [provider('one', ok('x'), calls), provider('two', ok('y'), calls)],
      { budgets: { one: 1, two: 5 } },
    );
    usage.providers.set('one', 1);
    await expect(
      gateway.generate({ userId: USER_A, request: cv(), providers: ['one'] }),
    ).rejects.toBeInstanceOf(AIUnavailableError);
    expect(usage.users.size).toBe(0);
    const res = await gateway.generate({ userId: USER_A, request: cv(), providers: ['two'] });
    expect(res.providerId).toBe('two');
  });

  it('does not reserve the user’s call when the turn deadline passed before any provider was tried', async () => {
    const calls: string[] = [];
    let ticks = 0;
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    // The first reading starts the turn; every later one is past the turn deadline (5000 ms).
    const now = () => new Date(ticks++ === 0 ? t0 : t0 + 6000);
    const { gateway, usage } = setup([provider('one', ok('x'), calls)], {}, { now });
    await expect(gateway.generate({ userId: USER_A, request: cv() })).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
    expect(calls).toEqual([]);
    expect(usage.users.size).toBe(0);
    expect(usage.providers.size).toBe(0);
  });

  it('still answers 429 at the user cap before any provider is reserved', async () => {
    const calls: string[] = [];
    const { gateway, usage } = setup([provider('one', ok('x'), calls)], {
      userCaps: { practice_message: 5, practice_feedback: 2, day_overview: 1, cv_tailor: 1 },
    });
    await gateway.generate({ userId: USER_A, request: cv() });
    await expect(gateway.generate({ userId: USER_A, request: cv() })).rejects.toBeInstanceOf(
      AIUserCapError,
    );
    expect(usage.providers.get('one')).toBe(1);
  });

  it('skips the check when the budget read fails (the user’s call is then reserved as before)', async () => {
    const { gateway, usage } = setup([provider('one', ok('x'))]);
    usage.store.providerUsage = async () => {
      throw new Error('read failed');
    };
    const res = await gateway.generate({ userId: USER_A, request: cv() });
    expect(res.text).toBe('x');
    expect(usage.users.get(`${USER_A}:cv_tailor`)).toBe(1);
  });
});

describe('buildSafeRequest with the tool-name allowance', () => {
  const parts = {
    purpose: 'cv_tailor' as const,
    system: 'Edit the CV.',
    messages: [{ role: 'user' as const, content: 'Built ASP.NET dashboards for monday.com.' }],
    maxOutputTokens: 100,
    json: false,
  };

  it('keeps catalog tool names as written, where the plain rules would change them', () => {
    const plain = buildSafeRequest(parts, []);
    expect(plain.messages[0]!.content).not.toContain('ASP.NET');
    const allowed = buildSafeRequest(parts, [], { allowToolNames: true });
    expect(allowed.messages[0]!.content).toBe('Built ASP.NET dashboards for monday.com.');
  });

  it('still removes an email or a URL that contains such a name', () => {
    for (const content of ['Write to me@monday.com now.', 'See https://monday.com/me please.']) {
      const out = buildSafeRequest({ ...parts, messages: [{ role: 'user', content }] }, [], {
        allowToolNames: true,
      });
      expect(out.messages[0]!.content).not.toMatch(/me@monday|https:/);
    }
  });
});
