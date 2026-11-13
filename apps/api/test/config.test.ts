import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { featureNames } from '../src/features';

describe('loadConfig defaults', () => {
  it('are exactly the documented ones, with every feature flag off', () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: 'development',
      supabase: null,
      supabaseAdmin: null,
      databaseUrl: null,
      appEnv: 'operational',
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      corsOrigins: [],
      rateLimitPerMinute: 120,
      trustProxy: 0,
      features: {
        notifications: false,
        sharing: false,
        offline: false,
        pushNotifications: false,
        aiOverview: false,
        profileSetup: false,
        cvTailor: false,
      },
      calendar: { enabled: false, tokenKeys: [], google: null, cron: null },
      ai: {
        allowPaid: false,
        paidMonthlyCapUsd: null,
        providerOrder: [],
        fakeProvider: false,
        budgets: {},
        userCaps: { practice_message: 40, practice_feedback: 6, day_overview: 1, cv_tailor: 3 },
        timeoutMs: 15000,
        turnTimeoutMs: 25000,
        historyChars: 12000,
        cvTailorDailyTotal: 20,
      },
    });
    expect(featureNames).toHaveLength(7);
  });
});

describe('loadConfig', () => {
  it('parses a comma separated origin list', () => {
    const config = loadConfig({ CORS_ORIGINS: 'https://a.example.com, http://localhost:5173' });
    expect(config.corsOrigins).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });

  it('fails fast on a bad PORT and names the variable', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('lists every bad variable at once', () => {
    try {
      loadConfig({ PORT: 'x', APP_ENV: 'prod', RATE_LIMIT_PER_MINUTE: '0' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toHaveLength(3);
      expect((err as ConfigError).message).toMatch(/APP_ENV[\s\S]*PORT|PORT[\s\S]*APP_ENV/);
    }
  });

  it.each(['*', 'https://app.example.com/', 'https://app.example.com/path', 'app.example.com'])(
    'rejects %s as a CORS origin',
    (origin) => {
      expect(() => loadConfig({ CORS_ORIGINS: origin })).toThrow(/CORS_ORIGINS/);
    },
  );
});

describe('TRUST_PROXY', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['2', 2],
    ['5', 5],
  ])('accepts the hop count %s', (value, expected) => {
    expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toBe(expected);
  });

  it.each(['true', 'false', '-1', '1.5', 'abc', '', '01', '6', '99999999999999999999999'])(
    'rejects %j',
    (value) => {
      expect(() => loadConfig({ TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );
});

describe('boolean variables', () => {
  it('turns a feature flag on only with the literal "true"', () => {
    const config = loadConfig({
      FEATURE_SHARING: 'true',
      FEATURE_PUSH_NOTIFICATIONS: 'true',
      FEATURE_OFFLINE: 'false',
    });
    expect(config.features).toEqual({
      notifications: false,
      sharing: true,
      offline: false,
      pushNotifications: true,
      aiOverview: false,
      profileSetup: false,
      cvTailor: false,
    });
  });

  it.each(['1', 'yes', 'TRUE', 'True', 'on', ' true', ''])(
    'rejects %j and names the variable',
    (value) => {
      expect(() => loadConfig({ FEATURE_NOTIFICATIONS: value })).toThrow(
        /FEATURE_NOTIFICATIONS: must be exactly "true" or "false"/,
      );
    },
  );
});

describe('sign-in and database settings', () => {
  const full = {
    SUPABASE_JWKS_URL: 'https://abc.supabase.co/auth/v1/.well-known/jwks.json',
    SUPABASE_JWT_ISSUER: 'https://abc.supabase.co/auth/v1',
    DATABASE_URL: 'postgres://app_rnd:secret@db.example.com:5432/postgres',
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fake_key_for_tests_0000',
  };

  it('parses them', () => {
    const config = loadConfig(full);
    expect(config.supabase).toEqual({
      jwksUrl: full.SUPABASE_JWKS_URL,
      issuer: full.SUPABASE_JWT_ISSUER,
    });
    expect(config.databaseUrl).toBe(full.DATABASE_URL);
  });

  it('refuses to start in production without any of them, naming each', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toEqual([
        'SUPABASE_JWKS_URL: required when NODE_ENV=production',
        'SUPABASE_JWT_ISSUER: required when NODE_ENV=production',
        'DATABASE_URL: required when NODE_ENV=production',
      ]);
    }
    try {
      loadConfig({
        NODE_ENV: 'production',
        SUPABASE_JWKS_URL: full.SUPABASE_JWKS_URL,
        SUPABASE_JWT_ISSUER: full.SUPABASE_JWT_ISSUER,
        DATABASE_URL: full.DATABASE_URL,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toEqual([
        'SUPABASE_URL: required when NODE_ENV=production',
        'SUPABASE_SERVICE_ROLE_KEY: required when NODE_ENV=production',
      ]);
    }
    expect(() => loadConfig({ NODE_ENV: 'production', ...full })).not.toThrow();
    for (const name of Object.keys(full)) {
      const partial: Record<string, string> = { NODE_ENV: 'production', ...full };
      delete partial[name];
      expect(() => loadConfig(partial), name).toThrow(new RegExp(name));
    }
  });

  it('lets development and tests run without them', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
  });

  it('wants the JWKS URL and the issuer together', () => {
    expect(() => loadConfig({ SUPABASE_JWKS_URL: full.SUPABASE_JWKS_URL })).toThrow(/set both/);
    expect(() => loadConfig({ SUPABASE_JWT_ISSUER: full.SUPABASE_JWT_ISSUER })).toThrow(/set both/);
  });

  it('requires https URLs and a postgres connection string, without echoing the value', () => {
    expect(() => loadConfig({ ...full, SUPABASE_JWKS_URL: 'http://x.test/jwks' })).toThrow(
      /SUPABASE_JWKS_URL/,
    );
    try {
      loadConfig({ DATABASE_URL: 'mysql://user:hunter2@host/db' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/DATABASE_URL/);
      expect((err as ConfigError).message).not.toContain('hunter2');
    }
  });

  describe('R&D shares the Auth project, so it never holds the service key', () => {
    const withoutKey: Record<string, string> = { ...full };
    delete withoutKey.SUPABASE_SERVICE_ROLE_KEY;

    it('starts in production on rnd without the service key and has no admin access', () => {
      const config = loadConfig({ NODE_ENV: 'production', APP_ENV: 'rnd', ...withoutKey });
      expect(config.supabaseAdmin).toBeNull();
      // The project URL is not a secret and may stay (for example for the JWKS settings).
      const bare = { ...withoutKey };
      delete bare.SUPABASE_URL;
      expect(() => loadConfig({ NODE_ENV: 'production', APP_ENV: 'rnd', ...bare })).not.toThrow();
    });

    it.each(['production', 'development', 'test'])(
      'refuses a service key on rnd (NODE_ENV=%s) without echoing it',
      (nodeEnv) => {
        try {
          loadConfig({ NODE_ENV: nodeEnv, APP_ENV: 'rnd', ...full });
          expect.unreachable();
        } catch (err) {
          const message = (err as ConfigError).message;
          expect((err as ConfigError).problems).toEqual([
            'SUPABASE_SERVICE_ROLE_KEY: must not be set when APP_ENV=rnd (R&D shares Supabase Auth with the live app; only the operational API may hold the key)',
          ]);
          expect(message).not.toContain(full.SUPABASE_SERVICE_ROLE_KEY);
        }
      },
    );

    it('still requires the key on the operational API in production', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', APP_ENV: 'operational', ...withoutKey }),
      ).toThrow(/SUPABASE_SERVICE_ROLE_KEY: required/);
    });
  });

  it('parses the service key settings into supabaseAdmin', () => {
    expect(loadConfig(full).supabaseAdmin).toEqual({
      url: full.SUPABASE_URL,
      serviceRoleKey: full.SUPABASE_SERVICE_ROLE_KEY,
    });
  });

  it('wants the project URL and the service key together', () => {
    expect(() => loadConfig({ SUPABASE_URL: full.SUPABASE_URL })).toThrow(/set both/);
    expect(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: full.SUPABASE_SERVICE_ROLE_KEY })).toThrow(
      /set both/,
    );
  });

  it.each([
    'http://abc.supabase.co',
    'https://abc.supabase.co/',
    'https://abc.supabase.co/auth/v1',
    'abc',
  ])('rejects %j as SUPABASE_URL', (value) => {
    expect(() => loadConfig({ ...full, SUPABASE_URL: value })).toThrow(/SUPABASE_URL/);
  });

  it('rejects a malformed service key without echoing it', () => {
    const bad = [
      'tiny-k3y',
      'has a space in it, 1234567890',
      'x'.repeat(3000),
      'line\nbreak-0123456789abcdef',
    ];
    for (const value of bad) {
      try {
        loadConfig({ ...full, SUPABASE_SERVICE_ROLE_KEY: value });
        expect.unreachable();
      } catch (err) {
        expect((err as ConfigError).message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
        expect((err as ConfigError).message).not.toContain(value);
      }
    }
  });
});

describe('AI configuration', () => {
  it('has no provider by default and every user cap at its documented value', () => {
    const { ai } = loadConfig({});
    expect(ai.providerOrder).toEqual([]);
    expect(ai.budgets).toEqual({});
    expect(ai.userCaps).toEqual({
      practice_message: 40,
      practice_feedback: 6,
      day_overview: 1,
      cv_tailor: 3,
    });
    expect(ai.cvTailorDailyTotal).toBe(20);
  });

  it('refuses AI_ALLOW_PAID without a spending cap above zero', () => {
    expect(() => loadConfig({ AI_ALLOW_PAID: 'true' })).toThrow(/AI_PAID_MONTHLY_CAP_USD/);
    expect(() => loadConfig({ AI_ALLOW_PAID: 'true', AI_PAID_MONTHLY_CAP_USD: '0' })).toThrow(
      /AI_PAID_MONTHLY_CAP_USD/,
    );
    const ok = loadConfig({ AI_ALLOW_PAID: 'true', AI_PAID_MONTHLY_CAP_USD: '5' });
    expect(ok.ai).toMatchObject({ allowPaid: true, paidMonthlyCapUsd: 5 });
    // A cap alone does not switch paid providers on.
    expect(loadConfig({ AI_PAID_MONTHLY_CAP_USD: '5' }).ai.allowPaid).toBe(false);
  });

  it('refuses the fake provider on the operational environment', () => {
    expect(() => loadConfig({ APP_ENV: 'operational', AI_FAKE_PROVIDER: 'true' })).toThrow(
      /AI_FAKE_PROVIDER/,
    );
    expect(() => loadConfig({ APP_ENV: 'operational', AI_PROVIDERS: 'fake' })).toThrow(
      /AI_PROVIDERS/,
    );
    expect(() =>
      loadConfig({ APP_ENV: 'operational', AI_PROVIDERS: 'fake', AI_FAKE_PROVIDER: 'true' }),
    ).toThrow(ConfigError);
  });

  it('uses the fake provider on R&D only when explicitly enabled', () => {
    expect(loadConfig({ APP_ENV: 'rnd' }).ai.providerOrder).toEqual([]);
    expect(() => loadConfig({ APP_ENV: 'rnd', AI_PROVIDERS: 'fake' })).toThrow(/AI_FAKE_PROVIDER/);
    const ai = loadConfig({ APP_ENV: 'rnd', AI_FAKE_PROVIDER: 'true' }).ai;
    expect(ai.providerOrder).toEqual(['fake']);
    expect(ai.budgets).toEqual({ fake: 1000 });
  });

  it('refuses the fake flag when AI_PROVIDERS is set without fake', () => {
    expect(() =>
      loadConfig({ APP_ENV: 'rnd', AI_FAKE_PROVIDER: 'true', AI_PROVIDERS: 'groq' }),
    ).toThrow(/AI_FAKE_PROVIDER/);
  });

  it('reads one explicit budget per listed provider; none means the provider is not used', () => {
    const ai = loadConfig({ AI_PROVIDERS: 'groq,cloudflare-ai', AI_BUDGET_GROQ_DAILY: '200' }).ai;
    expect(ai.providerOrder).toEqual(['groq', 'cloudflare-ai']);
    expect(ai.budgets).toEqual({ groq: 200 });
    const cf = loadConfig({
      AI_PROVIDERS: 'cloudflare-ai',
      AI_BUDGET_CLOUDFLARE_AI_DAILY: '50',
    }).ai;
    expect(cf.budgets).toEqual({ 'cloudflare-ai': 50 });
    // A budget for a provider that is not listed is ignored.
    expect(loadConfig({ AI_BUDGET_GROQ_DAILY: '200' }).ai.budgets).toEqual({});
  });

  it('rejects bad budgets and unknown providers', () => {
    for (const bad of ['0', '-5', '1.5', 'many', '1000001']) {
      expect(() => loadConfig({ AI_PROVIDERS: 'groq', AI_BUDGET_GROQ_DAILY: bad })).toThrow(
        /AI_BUDGET_GROQ_DAILY: must be a whole number/,
      );
    }
    expect(() => loadConfig({ AI_PROVIDERS: 'groq,groq' })).toThrow(/repeat/);
    expect(() => loadConfig({ AI_PROVIDERS: 'openai' })).toThrow(/AI_PROVIDERS/);
  });

  it('reads timeouts and caps', () => {
    const ai = loadConfig({
      AI_TIMEOUT_MS: '5000',
      AI_TURN_TIMEOUT_MS: '9000',
      AI_USER_DAILY_PRACTICE_MESSAGES: '10',
      AI_USER_DAILY_PRACTICE_FEEDBACK: '0',
    }).ai;
    expect(ai).toMatchObject({ timeoutMs: 5000, turnTimeoutMs: 9000 });
    expect(ai.userCaps).toMatchObject({ practice_message: 10, practice_feedback: 0 });
    expect(() => loadConfig({ AI_TIMEOUT_MS: '10' })).toThrow(/AI_TIMEOUT_MS/);
  });
});
