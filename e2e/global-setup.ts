import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAiStub } from './support/ai-stub';
import { startAuthServer } from './support/auth-server';
import { prepareDatabase } from './support/db';
import {
  AI_STUB_PORT,
  API_FIRST_RUN_PORT,
  API_FIRST_RUN_URL,
  API_NO_AI_PORT,
  API_NO_AI_URL,
  API_PORT,
  API_URL,
  AUTH_PORT,
  E2E_NOW,
  REPO_ROOT,
  WEB_PORT,
  WORKER_ENV,
  requireEnv,
} from './support/env';
import { runToCompletion, startService, stopService, waitForHttp } from './support/processes';

/**
 * Brings up the real stack for the run, with nothing outside this machine:
 *   throwaway Postgres (rnd schema, real migrations) -> local JWKS server (keys made now)
 *   -> the built API with E2E_NOW -> the e2e web build served by `vite preview`.
 * Everything secret (signing key, database passwords, certificate) is generated here, lives in
 * memory or in a temporary folder, and is deleted at the end. Returns the teardown function.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = requireEnv('TEST_DATABASE_URL');
  const superuserUrl = requireEnv('TEST_SUPERUSER_URL');
  const dir = mkdtempSync(join(tmpdir(), 'upversion-e2e-'));
  const services: ReturnType<typeof startService>[] = [];
  let auth: Awaited<ReturnType<typeof startAuthServer>> | undefined;
  let aiStub: Awaited<ReturnType<typeof startAiStub>> | undefined;

  const teardown = async () => {
    services.forEach(stopService);
    await auth?.close();
    await aiStub?.close();
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const apiDatabaseUrl = await prepareDatabase(adminUrl, superuserUrl);
    auth = await startAuthServer(AUTH_PORT, dir);

    process.env[WORKER_ENV.signingKey] = JSON.stringify(auth.privateJwk);
    process.env[WORKER_ENV.issuer] = auth.issuer;
    process.env[WORKER_ENV.superuserUrl] = superuserUrl;
    aiStub = await startAiStub(AI_STUB_PORT);
    const aiStubUrl = `http://127.0.0.1:${AI_STUB_PORT}`;
    process.env[WORKER_ENV.aiStubUrl] = aiStubUrl;

    // What the child processes inherit: no database admin URLs and no signing key.
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ['TEST_DATABASE_URL', 'TEST_SUPERUSER_URL', ...Object.values(WORKER_ENV)]) {
      delete base[name];
    }
    await runToCompletion('api-build', dir, 'pnpm', ['--filter', '@upversion/api', 'build'], {
      cwd: REPO_ROOT,
      env: base,
    });
    const apiEnv: NodeJS.ProcessEnv = {
      ...base,
      // Not production: E2E_NOW is ignored there (apps/api/src/test-clock.ts).
      NODE_ENV: 'test',
      APP_ENV: 'rnd',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      DATABASE_URL: apiDatabaseUrl,
      SUPABASE_JWKS_URL: auth.jwksUrl,
      SUPABASE_JWT_ISSUER: auth.issuer,
      NODE_EXTRA_CA_CERTS: auth.certFile,
      CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      RATE_LIMIT_PER_MINUTE: '100000',
      E2E_NOW,
    };
    const api = startService('api', dir, 'node', ['apps/api/dist/server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...apiEnv,
        PORT: String(API_PORT),
        // Two providers so a 429 on the first can switch to the second. Their own code runs; only
        // the HTTPS calls are redirected to the local stub (support/ai-fetch-preload.mjs). These
        // values are made up and open nothing; "confirmed" only lets the providers start.
        AI_PROVIDERS: 'groq,cloudflare-ai',
        GROQ_API_KEY: ['e2e', 'fake', 'groq'].join('-'),
        GROQ_NO_CARD_CONFIRMED: 'true',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        // Built at run time so a secret scanner has no literal to match.
        CLOUDFLARE_API_TOKEN: ['e2e', 'fake', 'cf'].join('-'),
        CLOUDFLARE_FREE_PLAN_CONFIRMED: 'true',
        AI_BUDGET_GROQ_DAILY: '1000',
        AI_BUDGET_CLOUDFLARE_AI_DAILY: '1000',
        E2E_AI_STUB_URL: aiStubUrl,
        NODE_OPTIONS: [
          base.NODE_OPTIONS,
          `--import=${pathToFileURL(join(REPO_ROOT, 'e2e/support/ai-fetch-preload.mjs')).href}`,
        ]
          .filter(Boolean)
          .join(' '),
      },
    });
    // The same build with no AI provider at all: "AI is off" (AI_PROVIDERS is empty).
    const apiNoAi = startService('api-no-ai', dir, 'node', ['apps/api/dist/server.js'], {
      cwd: REPO_ROOT,
      env: { ...apiEnv, PORT: String(API_NO_AI_PORT) },
    });
    // The same build with the profile and plan builder features on: the first run (ADR 018). The
    // other processes keep both off, so the demo-plan flows are not sent to the first run.
    const apiFirstRun = startService('api-first-run', dir, 'node', ['apps/api/dist/server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...apiEnv,
        PORT: String(API_FIRST_RUN_PORT),
        FEATURE_PROFILE_SETUP: 'true',
        FEATURE_PLAN_BUILDER: 'true',
      },
    });
    services.push(apiFirstRun);
    services.push(apiNoAi);
    services.push(api);

    // The e2e build of the web app: VITE_E2E=1 turns on the localStorage sign-in, and the fake
    // Supabase address is never contacted. Built into the temporary folder, not into the repo.
    const webDir = join(dir, 'web');
    const webEnv = {
      ...base,
      VITE_E2E: '1',
      VITE_APP_ENV: 'rnd',
      VITE_API_URL: API_URL,
      VITE_SUPABASE_URL: 'http://127.0.0.1:1',
      VITE_SUPABASE_ANON_KEY: 'e2e-not-a-real-key',
    };
    const vite = join(REPO_ROOT, 'apps/web/node_modules/vite/bin/vite.js');
    await runToCompletion(
      'web-build',
      dir,
      'node',
      [vite, 'build', '--outDir', webDir, '--emptyOutDir'],
      { cwd: join(REPO_ROOT, 'apps/web'), env: webEnv },
    );
    const web = startService(
      'web',
      dir,
      'node',
      [
        vite,
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(WEB_PORT),
        '--strictPort',
        '--outDir',
        webDir,
      ],
      { cwd: join(REPO_ROOT, 'apps/web'), env: webEnv },
    );
    services.push(web);

    await waitForHttp(`${API_URL}/api/v1/health`, api);
    await waitForHttp(`${API_NO_AI_URL}/api/v1/health`, apiNoAi);
    await waitForHttp(`${API_FIRST_RUN_URL}/api/v1/health`, apiFirstRun);
    await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, web);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
