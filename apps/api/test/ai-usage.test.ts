import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAIUsageStore, reserveProviderBudget } from '../src/ai/budget';
import { cacheKey, createAICache } from '../src/ai/cache';
import { AIUnavailableError, AIUserCapError, createAIGateway } from '../src/ai/gateway';
import { ProviderUnavailableError, type AIProvider } from '../src/ai/provider';
import { createAIRegistry } from '../src/ai/registry';
import { buildSafeRequest } from '../src/ai/safe-request';
import { loadConfig } from '../src/config';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const chat = (text = 'Ask me about caching.') =>
  buildSafeRequest(
    {
      purpose: 'practice_message',
      system: 'Coach.',
      messages: [{ role: 'user', content: text }],
      maxOutputTokens: 200,
      json: false,
    },
    [],
  );
const overview = (text = 'Overview for today.') =>
  buildSafeRequest(
    {
      purpose: 'day_overview',
      system: 'Coach.',
      messages: [{ role: 'user', content: text }],
      maxOutputTokens: 200,
      json: false,
    },
    [],
  );

describe.skipIf(!dbAvailable)('AI usage, budgets and cache (real Postgres)', () => {
  let testDb: TestDb;
  let db: Database;
  let keys: TestKeys;
  let app: ReturnType<typeof buildApp>;
  let clock = new Date();
  const now = () => clock;

  const aiConfig = loadConfig({
    APP_ENV: 'rnd',
    AI_FAKE_PROVIDER: 'true',
    AI_BUDGET_FAKE_DAILY: '3',
    AI_USER_DAILY_PRACTICE_MESSAGES: '5',
  }).ai;

  const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);
  const providerRequests = async (id = 'fake') =>
    (
      await rows<{ requests: number }>(
        `select requests from rnd.ai_provider_usage where provider_id = $1`,
        [id],
      )
    )[0]?.requests ?? 0;
  const as = async (sub: string, email: string) => ({
    authorization: `Bearer ${await keys.sign({ sub, email })}`,
  });

  beforeAll(async () => {
    testDb = await prepareDatabase();
    keys = await makeTestKeys();
    db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
    app = buildApp(testConfig({ appEnv: 'rnd', ai: aiConfig, rateLimitPerMinute: 100_000 }), {
      verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
      db,
      now,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  beforeEach(async () => {
    clock = new Date();
    await testDb.admin(async (c) => {
      await c.query('delete from rnd.app_users');
      await c.query('delete from rnd.allowed_emails');
      await c.query('delete from rnd.ai_provider_usage');
      await c.query(
        `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com'), ('c@example.com')`,
      );
      await c.query(
        `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com'), ($3, 'c@example.com')`,
        [A, B, C],
      );
      await acceptCurrentLegal(c, [A, B]);
    });
  });

  describe('the user cap', () => {
    it('is atomic: 20 concurrent reserves against a cap of 5 succeed exactly 5 times', async () => {
      const usage = createAIUsageStore(db, now);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => usage.reserveUser(A, 'practice_message', 5)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      const [row] = await rows<{ requests: number }>(
        `select requests from rnd.ai_usage_daily where user_id = $1 and purpose = 'practice_message'`,
        [A],
      );
      expect(row!.requests).toBe(5);
    });

    it('is per user and per purpose', async () => {
      const usage = createAIUsageStore(db, now);
      for (let i = 0; i < 2; i += 1) await usage.reserveUser(A, 'day_overview', 2);
      expect((await usage.reserveUser(A, 'day_overview', 2)).ok).toBe(false);
      expect((await usage.reserveUser(B, 'day_overview', 2)).ok).toBe(true);
      expect((await usage.reserveUser(A, 'practice_feedback', 2)).ok).toBe(true);
    });

    it('a cap of 0 allows nothing and leaves no row', async () => {
      const usage = createAIUsageStore(db, now);
      expect((await usage.reserveUser(A, 'practice_message', 0)).ok).toBe(false);
      expect(await rows(`select 1 from rnd.ai_usage_daily`)).toHaveLength(0);
    });

    it('counts a new UTC day from zero', async () => {
      const usage = createAIUsageStore(db, now);
      clock = new Date('2026-11-01T23:59:00Z');
      expect((await usage.reserveUser(A, 'day_overview', 1)).ok).toBe(true);
      expect((await usage.reserveUser(A, 'day_overview', 1)).ok).toBe(false);
      clock = new Date('2026-11-02T00:01:00Z');
      expect((await usage.reserveUser(A, 'day_overview', 1)).ok).toBe(true);
    });
  });

  describe('the provider budget (same SQL function, shared helper)', () => {
    it('never exceeds the budget under 20 concurrent reserves from several users', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          db.withUser([A, B, C][i % 3]!, (ctx) => reserveProviderBudget(ctx, 'groq', 7)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(7);
      expect(await providerRequests('groq')).toBe(7);
    });

    it('refuses a budget of 0 and a bad provider id', async () => {
      await db.withUser(A, async (ctx) => {
        expect(await reserveProviderBudget(ctx, 'groq', 0)).toBe(false);
        expect(await reserveProviderBudget(ctx, 'Bad Id', 5)).toBe(false);
      });
      expect(await rows(`select 1 from rnd.ai_provider_usage`)).toHaveLength(0);
    });
  });

  describe('the gateway on a real database', () => {
    const failing = (during?: () => Promise<void>): AIProvider => ({
      id: 'groq',
      label: 'Groq',
      costTier: 'free',
      maxContextChars: 1000,
      async generate() {
        await during?.();
        throw new ProviderUnavailableError();
      },
    });
    const gatewayFor = (provider: AIProvider, over: { budget?: number } = {}) => {
      const registry = createAIRegistry();
      registry.register(provider);
      return createAIGateway({
        registry,
        config: {
          providerOrder: [provider.id],
          budgets: { [provider.id]: over.budget ?? 10 },
          userCaps: { practice_message: 5, practice_feedback: 2, day_overview: 1, cv_tailor: 3 },
          timeoutMs: 1000,
          turnTimeoutMs: 3000,
          historyChars: 12000,
        },
        usage: createAIUsageStore(db, now),
        cache: createAICache(db, now),
        now,
      });
    };

    it('commits the reservations before the call and holds no transaction during it', async () => {
      let duringBudget = -1;
      let openTransactions = -1;
      const gateway = gatewayFor(
        failing(async () => {
          duringBudget = await providerRequests('groq');
          openTransactions = (
            await rows<{ n: number }>(
              `select count(*)::int as n from pg_stat_activity
                where datname = current_database() and usename like 'app\\_%'
                  and state like 'idle in transaction%'`,
            )
          )[0]!.n;
        }),
      );
      await expect(gateway.generate({ userId: A, request: chat() })).rejects.toBeInstanceOf(
        AIUnavailableError,
      );
      expect(duringBudget).toBe(1); // committed before the network call
      expect(openTransactions).toBe(0); // and nothing left open while it ran
      expect(await providerRequests('groq')).toBe(1); // the failed call still counts
      const [user] = await rows<{ requests: number }>(
        `select requests from rnd.ai_usage_daily where user_id = $1`,
        [A],
      );
      expect(user!.requests).toBe(1);
    });

    it('stops calling a provider when its budget is used up', async () => {
      const gateway = gatewayFor(failing(), { budget: 1 });
      await gateway.generate({ userId: A, request: chat() }).catch(() => undefined);
      // The provider is now cooling down, so a second turn never reaches it or the budget.
      await expect(gateway.generate({ userId: A, request: chat() })).rejects.toBeInstanceOf(
        AIUnavailableError,
      );
      expect(await providerRequests('groq')).toBe(1);
    });

    it('enforces the user cap against the database, and another user still succeeds', async () => {
      const ok: AIProvider = {
        ...failing(),
        async generate() {
          return { text: 'hi' };
        },
      };
      const gateway = gatewayFor(ok);
      for (let i = 0; i < 5; i += 1) await gateway.generate({ userId: A, request: chat() });
      await expect(gateway.generate({ userId: A, request: chat() })).rejects.toBeInstanceOf(
        AIUserCapError,
      );
      await expect(gateway.generate({ userId: B, request: chat() })).resolves.toMatchObject({
        text: 'hi',
      });
    });

    it('a cache hit makes no call, spends no budget and counts as avoided', async () => {
      let calls = 0;
      const counting: AIProvider = {
        ...failing(),
        async generate() {
          calls += 1;
          return { text: 'the overview' };
        },
      };
      const gateway = gatewayFor(counting);
      await gateway.generate({ userId: A, request: overview() });
      const hit = await gateway.generate({ userId: A, request: overview() });
      expect(hit).toMatchObject({ cached: true, text: 'the overview' });
      expect(calls).toBe(1);
      expect(await providerRequests('groq')).toBe(1);
      const [row] = await rows<{ requests: number; avoided: number }>(
        `select requests, avoided from rnd.ai_usage_daily where user_id = $1 and purpose = 'day_overview'`,
        [A],
      );
      expect(row).toEqual({ requests: 1, avoided: 1 });
    });
  });

  describe('the cache', () => {
    it('stores per user, ignores expired rows and prunes them on write', async () => {
      const cache = createAICache(db, now);
      const key = cacheKey(overview());
      clock = new Date('2026-11-01T10:00:00Z');
      await cache.put(A, key, 'day_overview', 'text', 3600_000);
      expect(await cache.get(A, key)).toBe('text');
      // Another user sees nothing under the same key (row-level security).
      expect(await cache.get(B, key)).toBeNull();
      // Expired: ignored on read.
      clock = new Date('2026-11-01T12:00:00Z');
      expect(await cache.get(A, key)).toBeNull();
      expect(await rows(`select 1 from rnd.ai_cache`)).toHaveLength(1);
      // Pruned on the next write.
      await cache.put(A, cacheKey(overview('other')), 'day_overview', 'newer', 3600_000);
      const left = await rows<{ text: string }>(`select text from rnd.ai_cache`);
      expect(left.map((r) => r.text)).toEqual(['newer']);
    });

    it('overwrites the same key and skips text over the database limit', async () => {
      const cache = createAICache(db, now);
      const key = cacheKey(overview());
      await cache.put(A, key, 'day_overview', 'one', 3600_000);
      await cache.put(A, key, 'day_overview', 'two', 3600_000);
      expect(await cache.get(A, key)).toBe('two');
      await cache.put(A, cacheKey(overview('big')), 'day_overview', 'x'.repeat(8001), 3600_000);
      expect(await rows(`select 1 from rnd.ai_cache`)).toHaveLength(1);
    });

    it('the key does not depend on the provider and changes with any part of the request', () => {
      expect(cacheKey(overview())).toBe(cacheKey(overview()));
      expect(cacheKey(overview())).not.toBe(cacheKey(overview('different')));
      expect(cacheKey(overview())).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('GET /api/v1/ai/usage', () => {
    const usage = async (who: 'a' | 'b' = 'a') =>
      app.inject({
        method: 'GET',
        url: '/api/v1/ai/usage',
        headers: who === 'a' ? await as(A, 'a@example.com') : await as(B, 'b@example.com'),
      });

    it('needs a signed-in user who accepted the terms', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/v1/ai/usage' })).statusCode).toBe(401);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/ai/usage',
        headers: await as(C, 'c@example.com'),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('terms_not_accepted');
    });

    it('shows the caps, the environment budget and what was used', async () => {
      clock = new Date('2026-11-01T10:00:00Z');
      const before = await usage();
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        day: '2026-11-01',
        resetsAt: '2026-11-02T00:00:00.000Z',
        configured: true,
        user: {
          practiceMessages: { used: 0, cap: 5 },
          practiceFeedback: { used: 0, cap: 6 },
          dayOverview: { used: 0, cap: 1 },
          cvTailor: { used: 0, cap: 3 },
        },
        features: { cvTailor: false },
        avoidedToday: 0,
        providers: [
          {
            id: 'fake',
            label: 'Fake provider (R&D)',
            configured: true,
            available: true,
            cooldownUntil: null,
            usedToday: 0,
            budget: 3,
          },
        ],
      });

      await app.aiGateway.generate({ userId: A, request: chat() });
      await app.aiGateway.generate({ userId: A, request: overview() });
      await app.aiGateway.generate({ userId: A, request: overview() }); // cache hit
      const after = (await usage()).json();
      expect(after.user.practiceMessages.used).toBe(1);
      expect(after.user.dayOverview.used).toBe(1);
      expect(after.avoidedToday).toBe(1);
      expect(after.providers[0]).toMatchObject({ usedToday: 2, budget: 3, available: true });

      // The provider budget is shared by the whole environment; the user counters are not.
      const other = (await usage('b')).json();
      expect(other.providers[0].usedToday).toBe(2);
      expect(other.user.practiceMessages.used).toBe(0);

      await app.aiGateway.generate({ userId: B, request: chat('another turn') });
      const full = (await usage()).json();
      expect(full.providers[0]).toMatchObject({ usedToday: 3, available: false });
      await expect(
        app.aiGateway.generate({ userId: B, request: chat('one more') }),
      ).rejects.toBeInstanceOf(AIUnavailableError);
      expect(await providerRequests('fake')).toBe(3);
    });

    it('reports configured: false everywhere when no provider is configured', async () => {
      const bare = buildApp(testConfig({ appEnv: 'rnd', rateLimitPerMinute: 100_000 }), {
        verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
        db,
        now,
      });
      await bare.ready();
      const res = await bare.inject({
        method: 'GET',
        url: '/api/v1/ai/usage',
        headers: await as(A, 'a@example.com'),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ configured: false, providers: [] });
      await bare.close();
    });
  });
});
