import { z } from 'zod';
import type { AIPurpose, AISettings } from './ai/provider';
import { parseCalendarTokenKeys, type CalendarKey } from './calendar-crypto';
import { booleanString, featureEnvShape, toFeatures, type Features } from './features';

const isBareOrigin = (value: string) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

const originSchema = z
  .string()
  .refine(isBareOrigin, 'must be a bare origin such as https://app.example.com');

const MAX_TRUST_PROXY = 5;

const httpsOrigin = z
  .string()
  .refine(
    (v) => v.startsWith('https://') && isBareOrigin(v),
    'must be a bare https origin such as https://<project-ref>.supabase.co',
  );

// Header-safe token characters only (linear check). The messages never echo the value.
const serviceKey = z
  .string()
  .min(20, 'is too short to be a service key')
  .max(2048, 'is too long to be a service key')
  .regex(/^[A-Za-z0-9._~+/=-]+$/, 'contains characters a key never has');

/** The provider ids the app can name in AI_PROVIDERS. A provider is one file plus one entry here. */
export const PROVIDER_IDS = ['groq', 'cloudflare-ai', 'fake'] as const;

const MAX_BUDGET = 1_000_000;
const intBetween = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const providerList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.enum(PROVIDER_IDS, { error: `must list only: ${PROVIDER_IDS.join(', ')}` }))
      .refine((ids) => new Set(ids).size === ids.length, 'must not repeat a provider'),
  );

/** `cloudflare-ai` reads its budget from AI_BUDGET_CLOUDFLARE_AI_DAILY. */
const budgetVariable = (id: string) => `AI_BUDGET_${id.toUpperCase().replace(/-/g, '_')}_DAILY`;

const httpsUrl = z.url().refine((v) => v.startsWith('https://'), 'must be an https URL');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['operational', 'rnd']).default('operational'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Exact origins only. Empty means no cross-origin access; "*" fails the origin check.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(originSchema)),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  // Number of reverse proxies in front of the API. 0 trusts nothing, so X-Forwarded-For is ignored.
  // Capped: a value above the real hop count lets clients spoof their IP and defeats the rate limit.
  TRUST_PROXY: z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative whole number of proxy hops, e.g. 0 or 1')
    .refine((v) => Number(v) <= MAX_TRUST_PROXY, `must be at most ${MAX_TRUST_PROXY}`)
    .default('0')
    .transform(Number),
  // Accounts (spec 3.A). The first three are required when NODE_ENV=production (see loadConfig).
  // Supabase Auth's JWKS endpoint, e.g. https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
  SUPABASE_JWKS_URL: httpsUrl.optional(),
  // The `iss` of access tokens, e.g. https://<project-ref>.supabase.co/auth/v1
  SUPABASE_JWT_ISSUER: httpsUrl.optional(),
  // Project URL and the service-role (secret) key, used to delete the Supabase Auth user on
  // "Delete my account". The key is a server-only secret: never logged, returned or sent to the web.
  // Operational API only (APP_ENV=operational): R&D shares the Auth project and must not hold it.
  SUPABASE_URL: httpsOrigin.optional(),
  SUPABASE_SERVICE_ROLE_KEY: serviceKey.optional(),
  // Connection string of the app_<schema> login (not the admin). Never logged.
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string')
    .optional(),
  // Lets paid AI providers register (spec 12.2). Off unless the owner sets it; no paid provider exists yet.
  AI_ALLOW_PAID: booleanString('false'),
  // Required (greater than 0) when AI_ALLOW_PAID=true, or the API refuses to start. Startup check
  // only: no paid provider exists, so nothing enforces or spends against this cap yet.
  AI_PAID_MONTHLY_CAP_USD: z.coerce.number().min(0).max(100_000).optional(),
  // The order providers are tried in. Empty (the default) means no provider: AI is off everywhere.
  AI_PROVIDERS: providerList,
  // Explicit opt-in for the offline fake provider. R&D only; the operational API refuses to start with it.
  AI_FAKE_PROVIDER: booleanString('false'),
  AI_TIMEOUT_MS: intBetween(1000, 60_000, 15_000),
  AI_TURN_TIMEOUT_MS: intBetween(1000, 120_000, 25_000),
  AI_HISTORY_CHARS: intBetween(1000, 100_000, 12_000),
  AI_USER_DAILY_PRACTICE_MESSAGES: intBetween(0, 1000, 40),
  AI_USER_DAILY_PRACTICE_FEEDBACK: intBetween(0, 1000, 6),
  AI_USER_DAILY_OVERVIEW: intBetween(0, 1000, 1),
  // CV tailoring (ADR 016): runs per user per UTC day, and across all users (counted in the database).
  AI_USER_DAILY_CV_TAILOR: intBetween(0, 1000, 3),
  AI_CV_TAILOR_DAILY_TOTAL: intBetween(0, 100_000, 20),
  // Google Calendar (v0.3b). Off unless the owner sets it; needs token keys when on.
  FEATURE_CALENDAR: booleanString('false'),
  // Newest first, "v2:<base64>,v1:<base64>", each key 32 bytes. Server-only secret: never logged.
  CALENDAR_TOKEN_KEYS: z.string().optional(),
  // Google OAuth client. Required when FEATURE_CALENDAR=true. The secret is server-only: never logged.
  GOOGLE_CLIENT_ID: z.string().min(1).max(512).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).max(512).optional(),
  // Where Google sends the user back after consent: the web app's /calendar/callback page. Must match
  // an authorised redirect URI of the OAuth client exactly. Required when FEATURE_CALENDAR=true.
  GOOGLE_REDIRECT_URI: z.url().max(1000).optional(),
  // Overridable so e2e can point at a local stub. Defaults are Google's (needs check against docs).
  // Scheduled calendar sync (docs/calendar-cron.md). The endpoint exists only with the flag on AND a
  // secret of at least 32 characters. The secret is server-only: never logged or serialised.
  FEATURE_CALENDAR_CRON: booleanString('false'),
  CALENDAR_CRON_SECRET: z.string().min(32).max(512).optional(),
  CALENDAR_CRON_MAX_USERS: intBetween(1, 100, 20),
  GOOGLE_CALENDAR_API_BASE: z.url().default('https://www.googleapis.com/calendar/v3'),
  GOOGLE_OAUTH_BASE: z.url().default('https://oauth2.googleapis.com'),
  ...featureEnvShape,
});

/** AI settings; every one is off by default (ADR 012). */
export interface AIConfig extends AISettings {
  /** Must be greater than 0 whenever allowPaid is true. */
  paidMonthlyCapUsd: number | null;
  /** The providers to try, in order. Empty means AI is off. */
  providerOrder: string[];
  fakeProvider: boolean;
  /** Calls per UTC day per provider id for this environment. No entry means the provider is not used. */
  budgets: Record<string, number>;
  /** Calls per user per UTC day. */
  userCaps: Record<AIPurpose, number>;
  /** CV tailoring runs per UTC day across all users (counted from ai_usage_daily). */
  cvTailorDailyTotal: number;
  /** One provider attempt. */
  timeoutMs: number;
  /** A whole turn, across fallbacks. */
  turnTimeoutMs: number;
  historyChars: number;
}

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  /** The web app page Google redirects to after consent (an authorised redirect URI of the client). */
  redirectUri: string;
  /** No trailing slash, e.g. https://www.googleapis.com/calendar/v3 */
  apiBase: string;
  /** No trailing slash; the token endpoint is `${oauthBase}/token`. */
  oauthBase: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  /** Null when not configured: sign-in then rejects every token (fail closed). */
  supabase: { jwksUrl: string; issuer: string } | null;
  /**
   * Operational only. Null when not configured (development, tests): account deletion then fails
   * closed (502) because the Auth user could not be removed. Always null on R&D, where deletion
   * touches only R&D data. Holds a secret: never log or serialise `serviceRoleKey`.
   */
  supabaseAdmin: { url: string; serviceRoleKey: string } | null;
  /** Null when not configured: account routes answer 503. */
  databaseUrl: string | null;
  appEnv: 'operational' | 'rnd';
  port: number;
  host: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  corsOrigins: string[];
  rateLimitPerMinute: number;
  trustProxy: number;
  features: Features;
  /** Holds key material: never log or serialise `tokenKeys`. */
  calendar: {
    enabled: boolean;
    tokenKeys: CalendarKey[];
    /** Null until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. Holds a secret: never log it. */
    google: GoogleCalendarConfig | null;
    /**
     * Null unless FEATURE_CALENDAR_CRON is on and CALENDAR_CRON_SECRET is set: the scheduled-sync
     * endpoint then does not exist (404). Holds a secret: never log or serialise it.
     */
    cron?: { secret: string; maxUsers: number } | null;
  };
  ai: AIConfig;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const missing = (['SUPABASE_JWKS_URL', 'SUPABASE_JWT_ISSUER', 'DATABASE_URL'] as const).filter(
      (name) => !e[name],
    );
    if (missing.length > 0) {
      throw new ConfigError(missing.map((name) => `${name}: required when NODE_ENV=production`));
    }
  }
  // R&D and Operational share ONE Supabase Auth project. Only the operational API may hold the
  // service key and delete the Auth user; R&D deletes only its own data. A key on an R&D service
  // is refused at startup so a misconfigured deploy fails loudly and the key cannot leak there.
  const holdsAdminKey = e.APP_ENV === 'operational';
  if (!holdsAdminKey && e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ConfigError([
      'SUPABASE_SERVICE_ROLE_KEY: must not be set when APP_ENV=rnd (R&D shares Supabase Auth with the live app; only the operational API may hold the key)',
    ]);
  }
  // Production operational always has sign-in verification (checked above), so deleting an
  // account must be able to remove the Auth user too: refuse to start without the key.
  if (e.NODE_ENV === 'production' && holdsAdminKey) {
    const missing = (['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const).filter(
      (name) => !e[name],
    );
    if (missing.length > 0) {
      throw new ConfigError(missing.map((name) => `${name}: required when NODE_ENV=production`));
    }
  }
  if (holdsAdminKey && Boolean(e.SUPABASE_URL) !== Boolean(e.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new ConfigError(['SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: set both or neither']);
  }
  if (Boolean(e.SUPABASE_JWKS_URL) !== Boolean(e.SUPABASE_JWT_ISSUER)) {
    throw new ConfigError(['SUPABASE_JWKS_URL and SUPABASE_JWT_ISSUER: set both or neither']);
  }
  const calendarKeys = loadCalendarKeys(e);
  const ai = loadAIConfig(e, env);
  return {
    nodeEnv: e.NODE_ENV,
    supabase:
      e.SUPABASE_JWKS_URL && e.SUPABASE_JWT_ISSUER
        ? { jwksUrl: e.SUPABASE_JWKS_URL, issuer: e.SUPABASE_JWT_ISSUER }
        : null,
    supabaseAdmin:
      holdsAdminKey && e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY
        ? { url: e.SUPABASE_URL, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY }
        : null,
    databaseUrl: e.DATABASE_URL ?? null,
    appEnv: e.APP_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    trustProxy: e.TRUST_PROXY,
    features: toFeatures(e),
    calendar: {
      enabled: e.FEATURE_CALENDAR,
      tokenKeys: calendarKeys,
      google: loadGoogle(e),
      cron:
        e.FEATURE_CALENDAR_CRON && e.CALENDAR_CRON_SECRET
          ? { secret: e.CALENDAR_CRON_SECRET, maxUsers: e.CALENDAR_CRON_MAX_USERS }
          : null,
    },
    ai,
  };
}

function loadGoogle(e: z.infer<typeof envSchema>): GoogleCalendarConfig | null {
  if (e.FEATURE_CALENDAR) {
    const missing = (
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const
    ).filter((n) => !e[n]);
    if (missing.length > 0) {
      throw new ConfigError(missing.map((n) => `${n}: required when FEATURE_CALENDAR=true`));
    }
  }
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET || !e.GOOGLE_REDIRECT_URI) return null;
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    redirectUri: e.GOOGLE_REDIRECT_URI,
    apiBase: e.GOOGLE_CALENDAR_API_BASE.replace(/\/+$/, ''),
    oauthBase: e.GOOGLE_OAUTH_BASE.replace(/\/+$/, ''),
  };
}

function loadCalendarKeys(e: z.infer<typeof envSchema>): CalendarKey[] {
  const raw = e.CALENDAR_TOKEN_KEYS?.trim();
  if (!raw) {
    if (e.FEATURE_CALENDAR) {
      throw new ConfigError(['CALENDAR_TOKEN_KEYS: required when FEATURE_CALENDAR=true']);
    }
    return [];
  }
  // Validated whenever set, so a bad key is caught before the flag is turned on.
  const result = parseCalendarTokenKeys(raw);
  if (result.problems.length > 0) {
    throw new ConfigError(result.problems.map((p) => `CALENDAR_TOKEN_KEYS: ${p}`));
  }
  return result.keys;
}

function loadAIConfig(e: z.infer<typeof envSchema>, env: NodeJS.ProcessEnv): AIConfig {
  const problems: string[] = [];
  if (
    e.AI_ALLOW_PAID &&
    !(e.AI_PAID_MONTHLY_CAP_USD !== undefined && e.AI_PAID_MONTHLY_CAP_USD > 0)
  ) {
    problems.push(
      'AI_PAID_MONTHLY_CAP_USD: must be greater than 0 when AI_ALLOW_PAID=true (a spending cap is required)',
    );
  }
  if (e.AI_FAKE_PROVIDER && e.APP_ENV === 'operational') {
    problems.push('AI_FAKE_PROVIDER: must not be true when APP_ENV=operational (R&D only)');
  }
  if (e.AI_FAKE_PROVIDER && e.AI_PROVIDERS.length > 0 && !e.AI_PROVIDERS.includes('fake')) {
    problems.push(
      'AI_FAKE_PROVIDER: true but AI_PROVIDERS does not list "fake" (add it or unset the flag)',
    );
  }
  if (e.AI_PROVIDERS.includes('fake') && !e.AI_FAKE_PROVIDER) {
    problems.push('AI_PROVIDERS: "fake" needs AI_FAKE_PROVIDER=true (and APP_ENV=rnd)');
  }
  // The fake provider is on only when explicitly enabled; with no list it is the only provider.
  const providerOrder =
    e.AI_FAKE_PROVIDER && e.APP_ENV === 'rnd' && e.AI_PROVIDERS.length === 0
      ? ['fake']
      : e.AI_PROVIDERS.filter((id) => id !== 'fake' || e.APP_ENV === 'rnd');
  // Budgets are explicit and fail closed: a provider with no budget is never called.
  const budgets: Record<string, number> = {};
  for (const id of providerOrder) {
    const name = budgetVariable(id);
    const raw = env[name]?.trim();
    if (!raw) {
      if (id === 'fake') budgets[id] = 1000; // offline, costs nothing
      continue;
    }
    const value = Number(raw);
    if (!/^[1-9]\d{0,6}$/.test(raw) || value > MAX_BUDGET) {
      problems.push(`${name}: must be a whole number from 1 to ${MAX_BUDGET}`);
    } else {
      budgets[id] = value;
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    allowPaid: e.AI_ALLOW_PAID,
    paidMonthlyCapUsd: e.AI_PAID_MONTHLY_CAP_USD ?? null,
    providerOrder,
    fakeProvider: e.AI_FAKE_PROVIDER,
    budgets,
    userCaps: {
      practice_message: e.AI_USER_DAILY_PRACTICE_MESSAGES,
      practice_feedback: e.AI_USER_DAILY_PRACTICE_FEEDBACK,
      day_overview: e.AI_USER_DAILY_OVERVIEW,
      cv_tailor: e.AI_USER_DAILY_CV_TAILOR,
    },
    cvTailorDailyTotal: e.AI_CV_TAILOR_DAILY_TOTAL,
    timeoutMs: e.AI_TIMEOUT_MS,
    turnTimeoutMs: e.AI_TURN_TIMEOUT_MS,
    historyChars: e.AI_HISTORY_CHARS,
  };
}
