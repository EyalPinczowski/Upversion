# End-to-end tests

Playwright tests of the core flows (spec section 9) against the **real stack**, with no Supabase, Render or Vercel and no outside network:

- throwaway Postgres, `rnd` schema built by the real migrations, random passwords;
- the built API (`apps/api/dist/server.js`);
- the web app built with `VITE_E2E=1` and served by `vite preview`;
- a local JWKS server and token issuer instead of Supabase Auth.

| File                                | Flow                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/flow-1-first-run.spec.ts`    | Sign in, accept the Terms, load the demo plan, see Today with blocks and the progress bar.                                                    |
| `tests/flow-2-daily-loop.spec.ts`   | Open the briefing, start the day from it, log time, "reached the estimate" prompt without auto-complete, mark done explicitly, end the day.                              |
| `tests/flow-3-review-adjust.spec.ts`| Two heavy-day reviews through the review screen, the suggestion (Accept disabled until Preview), accept, the finish date moves; API calls cross-check. |

| `tests/flow-4-practice-external.spec.ts` | Practice with another assistant: copy the prompt, paste a feedback block, finish, mark done on purpose.                                |
| `tests/flow-5-practice-in-app.spec.ts`   | In-app chat: broken feedback JSON is saved as plain text; a 429 on the first provider shows "Continuing on ...", then AI feedback and done. |
| `tests/flow-6-practice-no-ai.spec.ts`    | No AI provider: the chat is not offered; the AI going away mid-chat shows the fallbacks; a self-check (rubric) finishes the practice.       |
| `tests/flow-7-import-over-active.spec.ts` | Import a plan while another is active: the archive confirm names it, cancel sends nothing, confirm archives the old plan (read-only).      |

Every screen of every flow is also checked with axe-core (WCAG 2.x A and AA), and every test fails on a console error, an uncaught page error or a Content-Security-Policy violation.

## Run it locally

Needs Node 22, pnpm, `openssl`, PostgreSQL 16 binaries and a Chromium that matches Playwright's pinned version (CI downloads it; locally use the preinstalled one or run `pnpm --filter @upversion/e2e exec playwright install chromium` once).

```bash
# 1. Your own throwaway cluster (pick a free port and a directory of your own).
export TEST_PG_DIR=/tmp/my-e2e-pg TEST_PG_PORT=55777
bash packages/db/scripts/test-postgres.sh start
eval "$(bash packages/db/scripts/test-postgres.sh env)"   # sets TEST_DATABASE_URL, TEST_SUPERUSER_URL

# 2. Run (builds the API and the e2e web build itself; about 10 s of set-up).
pnpm install --frozen-lockfile
pnpm --filter @upversion/e2e e2e            # all flows
pnpm --filter @upversion/e2e e2e -- flow-2  # one file

# 3. Clean up (the same TEST_PG_DIR and TEST_PG_PORT must be set, or `stop` hits the default cluster).
bash packages/db/scripts/test-postgres.sh stop
```

The global setup **drops and recreates the `rnd` schema** of the database in `TEST_DATABASE_URL`, so it refuses any host that is not loopback. Ports default to 4310 (API), 4311 (web), 4312 (auth) and can be changed with `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_AUTH_PORT`.

Failures leave `e2e/test-results/` (screenshot, trace: `pnpm exec playwright show-trace <file>`) and, in CI, `e2e/playwright-report/`. Both are git-ignored.

## What is test-only, and how it stays out of production

| Seam                                                                           | Where                                              | Why it cannot reach production                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_E2E=1` swaps the Supabase sign-in for a token read from `localStorage`    | `apps/web/src/e2e/`, `main.tsx`, `vite.config.ts`  | `__E2E__` is a build-time constant, `false` unless `VITE_E2E=1`, so the branch and the module are removed from the bundle. `apps/web/src/build/e2e-bundle.test.ts` builds the real production bundle and fails if the e2e code is in it (and checks that the e2e build does contain it, so the test can fail). The build also refuses `VITE_E2E=1` together with `VITE_APP_ENV=operational`. |
| `E2E_NOW` fixes the API's clock                                                 | `apps/api/src/test-clock.ts`, `server.ts`          | Ignored when `NODE_ENV=production` (unit test `apps/api/test/test-clock.test.ts`); a malformed value stops the start-up. The API in the e2e run uses `NODE_ENV=test`.                                                                      |
| Local JWKS server and token issuer                                              | `support/auth-server.ts`, `support/tokens.ts`      | Live only in this folder. The ES256 key pair and the self-signed certificate (the API only accepts an `https` JWKS URL) are made on every run in a temporary folder and deleted afterwards. The API trusts the certificate through `NODE_EXTRA_CA_CERTS` for its own process only. |
| Database passwords                                                              | `support/db.ts`                                    | Random per run, passed in memory and through the API's environment. Nothing is written to disk. The CI password of the Postgres service container is a throwaway of that container.                                                          |

The tokens are verified by the real API code (signature, issuer, audience, expiry); only where the keys come from is different.

## AI in the practice flows

The API's own Groq and Cloudflare provider code runs (`AI_PROVIDERS=groq,cloudflare-ai`, made-up keys), but `support/ai-fetch-preload.mjs`, loaded into the e2e API process only, sends their two HTTPS addresses to `support/ai-stub.ts`, a scripted server on 127.0.0.1. By default it answers chat with one fixed line and feedback requests with valid JSON; a test queues a 429 or broken text with `scriptAi`. The fake provider (`AI_FAKE_PROVIDER`) is not used because it is a single provider with a fixed answer, so it cannot show a 429 or the switch to the next provider. A second API process of the same build has no provider at all ("AI off"); a test points the page at it with `switchToApiWithoutAi`. A provider that answered 429 stays in a cooldown for the rest of the run (the API's clock is fixed), so the 429 test is the last one that relies on the first provider.

## How a run works

1. `global-setup.ts` resets and migrates `rnd`, generates keys, starts the JWKS server, builds and starts the API, builds the e2e web app and starts `vite preview`, then waits until both answer.
2. Each test gets its own person (`fixtures.ts`): a new UUID and email, put on the allowlist as superuser, with a signed token. Tests therefore never share data and can be repeated without resetting.
3. The "now" of the API is Monday 2026-11-02, 10:00 in Jerusalem. The demo plan starts on Sunday 2026-11-01, so there are two consecutive study days for the review flow, and every run sees the same dates. `plans.created_at` comes from the database's real clock, so the throwaway database stamps every new plan as created on that Sunday (a trigger made in `support/db.ts`); without it the runs would depend on the real date.
4. The teardown stops the processes and deletes the temporary folder.
