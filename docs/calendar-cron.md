# Scheduled calendar sync (while the app is closed)

Status: built on branch `feature/api-calendar-cron-sync`; **off until the owner turns it on** (steps below). Cost: $0, no card.

## What it does

Every 15 minutes a small Cloudflare Worker (`apps/cron`, cron trigger) calls one protected API endpoint. The API syncs the calendars that are due, so the calendar updates by itself even when nobody has the app open. Before this, a sync only happened when the user asked for it (`POST /api/v1/calendar/sync`) or while a web tab was open (PR #112).

```
Cloudflare Cron Trigger (*/15, UTC)
  -> Worker upversion-cron-rnd  scheduled()
       POST {API_BASE_URL}/api/v1/internal/calendar/sync-due
       Authorization: Bearer <CALENDAR_CRON_SECRET>
  -> Render API (may need about a minute to wake up)
       1. checks the secret (constant time) and the rate limits
       2. single-flight lock (a second call while one runs: 409 already_running)
       3. calendar_users_due(10 minutes, CALENDAR_CRON_MAX_USERS)  -> user ids only
       4. for each id, one after the other: CalendarSync.syncNow(userId)   (the user's own code path)
       5. answers {due, synced, cached, failed, skipped}  (counts only)
```

## Design

- **Same code as the user path.** Each user is synced with `CalendarSync.syncNow`, inside that user's normal row-level-security context (`db.withUser`). So the write guard (spec 3.8, only events the app created in its own calendar), the scopes (`calendar.app.created` + `calendar.readonly`, no new scopes) and the 5-minute cache are unchanged. The cron code never reads or writes calendar rows itself.
- **Finding due users across users.** RLS shows a connection only to its owner, and the cron has no signed-in user. Migration `0018_calendar_auto_sync.sql` adds one narrow `SECURITY DEFINER` function, `calendar_users_due(p_older_than interval, p_limit integer)`. It returns **user ids only**, never a token, e-mail or title. A user is due when the connection is `connected`, has a stored token and app calendar, `auto_sync` is on, the account is `active`, and the last sync is missing or older than 10 minutes. Never-synced first, then oldest first; the limit is clamped to 1..100. `search_path` is pinned, no dynamic SQL, `PUBLIC` has no `EXECUTE`, only the app role may call it. It is listed in the database convention test.
- **Per-user switch.** `calendar_connections.auto_sync boolean not null default true` (additive; RLS unchanged). It is in the calendar view (`GET /api/v1/calendar` returns `autoSync`) and is changed with `PUT /api/v1/calendar/settings` `{ "autoSync": true|false }` (strict body, the user id comes from the token only, 409 `calendar_not_connected` when nothing is connected). **The web checkbox is not changed in this PR**; a follow-up switches it to the server setting.
- **Isolation of failures.** One failing user never stops the rest. A user whose Google credentials no longer work is flagged `needs_reconnect` by the sync code (409 `calendar_reconnect_required`) and the cron skips them until they reconnect. Google 503 / timeouts do not mark the user as synced, so the user is due again on the next run.
- **Budgets.** At most `CALENDAR_CRON_MAX_USERS` users per call (default 20). 45 seconds per user (the run moves on; the underlying sync is not aborted and still holds that user's per-user lock until it ends), 120 seconds per run (remaining users count as `skipped` and are due next time). The Worker waits up to 300 seconds per attempt, with one retry only on a network error, 429, 502 or 503, so the worst case (about 60 s Render wake-up, then a run of up to about 120 s plus the last user's 45 s) fits in one attempt, and two attempts (about 10 minutes) fit in the 15-minute wall time of a scheduled Worker.
- **Counts only.** The response is `{due, synced, cached, failed, skipped}`. Logs carry the same counts and error codes (for example `calendar_unavailable`), never user ids, e-mails, event titles or tokens. The Worker logs only the HTTP status and the counts.

## Security model

| Concern | Control |
| --- | --- |
| Endpoint exposure | Registered only with `FEATURE_CALENDAR_CRON=true` **and** `CALENDAR_CRON_SECRET` set (and `FEATURE_CALENDAR=true`); otherwise 404 (the route does not exist). Hidden from the OpenAPI document. |
| Secret | At least 32 characters (the API refuses to start with a shorter one, without echoing it). Sent as `Authorization: Bearer`. Compared with `crypto.timingSafeEqual` on SHA-256 digests (equal length, so the length of the secret does not leak). Missing, malformed, short and wrong secrets all get the same generic 401. A user JWT is not accepted. |
| Client data | Strict empty body: `userId`, `force` or any other field is a 400. No query values are read. The set of users comes from the database only. |
| Rate limits | The secret is checked first (constant time). Per IP, only FAILED attempts are counted (6 a minute, then 429), so a flood of wrong guesses, even from the one shared proxy address Render shows when `TRUST_PROXY=0`, can never make the real Worker's valid call answer 429; a valid secret skips that counter. Valid calls are limited globally to 6 runs a minute. In memory, one API process (free plan). 429 with `Retry-After`; the Worker retries a 429 once. |
| Overlap | Global single-flight lock: a second call while one runs answers 409 `already_running`. The cron Worker treats 409 as fine. |
| Data access | Each user's sync runs under that user's RLS context; the due function is the only cross-user read and returns ids. |
| Secrets in the repo | None. `.env.example` has names only; `wrangler.jsonc` has a placeholder `API_BASE_URL`; the Worker secret is set by the owner. |
| Worker exposure | `workers_dev: false` and `preview_urls: false`: the Worker has no public URL, it only runs on its schedule. |

## Environment variables

API (Render), names only (see `.env.example`):

| Name | Meaning |
| --- | --- |
| `FEATURE_CALENDAR_CRON` | `true` turns the endpoint on. Default off. |
| `CALENDAR_CRON_SECRET` | The shared secret, at least 32 characters. Server-only. |
| `CALENDAR_CRON_MAX_USERS` | Users per call, 1 to 100, default 20. |

Cron Worker (Cloudflare): `API_BASE_URL` (plain variable, https origin of the API, no real value in the repo), `CALENDAR_CRON_SECRET` (Worker secret).

## Owner steps (R&D first)

Do these in order. Nothing here costs money. If any screen asks for a card or payment method, stop.

1. **Generate the secret** (the same command works in PowerShell and bash, needs Node 22 which you already have):

   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   Copy the output once. It is 64 characters. Do not paste it in chat, an issue or a commit.

2. **Run the database migration for `rnd`.** GitHub > Actions > "DB migrate" > Run workflow: schema `rnd`, action `migrate`, `dry_run` on first (it lists `0018_calendar_auto_sync.sql`), then again with `dry_run` off. Do not run it for `prod` until the release.

3. **Render (R&D API service `upversion-api-rnd`)** > Environment: add `FEATURE_CALENDAR_CRON` = `true` and `CALENDAR_CRON_SECRET` = the value from step 1 (mark it secret). Save; Render redeploys. (`FEATURE_CALENDAR=true` must already be set there.)

4. **Cloudflare: create the cron Worker from this repo.** Either from your computer:

   ```
   cd apps/cron
   npx wrangler login
   npx wrangler deploy
   ```

   or with Workers Builds: Workers & Pages > Create application > connect the repo > name `upversion-cron-rnd`, **root directory `apps/cron`**, production branch `rnd`, deploy command `npx wrangler deploy`. Whether Workers Builds installs and builds correctly with root `apps/cron` in this pnpm workspace, and which Wrangler version `npx wrangler` then uses (it is not pinned: `apps/cron` has no `wrangler` dependency), are both **needs check**; if the build fails, deploy from your computer instead (`npx wrangler deploy` in `apps/cron`) and report it. It must not use the repo root (the root `wrangler.jsonc` is the web app, `upversion-web`). The Worker name must equal `name` in `apps/cron/wrangler.jsonc`.

5. **Set the API address** (not a secret): in Cloudflare > the Worker > Settings > Variables and Secrets > add variable `API_BASE_URL` = the https origin of the R&D API, no trailing slash. The value lives only in the dashboard: `apps/cron/wrangler.jsonc` has no `vars` block and sets `"keep_vars": true`, so a deploy does not remove it (the Wrangler docs behaviour for `keep_vars` is **needs check**). Until it is set, every run fails with `outcome: "misconfigured"` in the log and shows as a failed cron event. If the first deploy happens before the Worker exists in the dashboard, deploy once, then add the variable and the secret.

6. **Set the Worker secret:** in `apps/cron` run `npx wrangler secret put CALENDAR_CRON_SECRET` and paste the value from step 1, or use the dashboard (Settings > Variables and Secrets > Add > type Secret).

7. **Check it ran.** Cron changes can take several minutes (docs say up to 15) to propagate. Then: Cloudflare > Worker > Observability / Logs, or the Cron Events list (it keeps the 100 most recent invocations): you should see a log line `{"event":"calendar_sync_due","attempt":1,"status":200,"due":..,"synced":..,...}`. On the API side, the Render log shows `scheduled calendar sync finished` with the same counts. In the app, the calendar's "last synced" time moves forward without opening it. To start a run now without waiting: a "run now" / test button for cron triggers in the Cloudflare dashboard is **needs check** (not verified in the docs read), otherwise wait for the next quarter hour. From your own machine you can call the API directly. In PowerShell use `curl.exe` (plain `curl` is an alias of `Invoke-WebRequest` there): `curl.exe -X POST -H "Authorization: Bearer <secret>" <API_BASE_URL>/api/v1/internal/calendar/sync-due`; in bash the same with `curl`. The secret then ends up in your shell history, so clear it afterwards or rotate the secret.

8. **Turn it off.** Fastest: Cloudflare > Worker > Settings > Triggers > delete the cron trigger (or set `"crons": []` in `apps/cron/wrangler.jsonc` and deploy). Full stop on the API side: set `FEATURE_CALENDAR_CRON=false` (the endpoint answers 404). Rotating the secret: set a new value in both places. A single user turns their own off with `PUT /api/v1/calendar/settings` `{"autoSync": false}` (web switch comes in a follow-up).

Production later: a second Worker (for example `upversion-cron`, its own name and variables) and the `prod` migration, after you approve the release. Not part of this PR.

## Verified facts (read from official docs on 2026-11-12)

Cloudflare:

- Cron trigger limit: the Workers limits page lists **5 Cron Triggers per account** on the Free plan (250 on Paid). One trigger is used here. https://developers.cloudflare.com/workers/platform/limits/ (a web search also showed third-party pages claiming 3 per Worker; they disagree with the official page, so they were not used).
- Free plan limits from the same page: 100,000 requests per day (cron invocations count as Worker invocations: **needs check**, the page does not say so explicitly; 96 runs a day is far below it either way), **10 ms CPU time per Cron Trigger invocation** (waiting on `fetch` is not CPU time: **needs check** against the CPU-time definition), 50 subrequests per invocation (this Worker makes 1 or 2), 100 Workers per account, and "Scheduled Workers have a maximum wall time of 15 minutes per invocation".
- Cron syntax and config: schedules go in `triggers.crons` of the Wrangler file; times are UTC; a deploy replaces the previous triggers; changes can take up to 15 minutes to propagate. The handler is `scheduled(controller, env, ctx)`. https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Timing: the page does not promise exact start times; it says scheduled Workers "run on underutilized machines". So timing is best effort (see the ADR section).
- **Cron Triggers on the Free plan:** the pricing page does not say it in words. The limits page gives a Free-plan number for Cron Triggers (5), which implies they exist on Free. **needs check** by creating the trigger: if the dashboard asks for a plan upgrade or a card, stop and tell the owner.
- Deploying a second Worker from this repo: Workers Builds can connect the same repository to several Workers; "Set the root directory for each Worker to specify the location of its `wrangler.jsonc`"; optional build watch paths per Worker. https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/ and https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ (default deploy command `npx wrangler deploy`). That the Worker's dashboard name must equal `name` in the config is from the project's earlier setup notes (docs/setup/deployments.md), **needs check** against the Cloudflare page, which did not state it. The existing web Worker keeps the repo root and its own `wrangler.jsonc`, so it keeps building only the web.

Render (https://render.com/docs/free, same facts as `docs/setup/deployments.md`):

- A free web service "goes 15 minutes without receiving any inbound traffic" and then spins down; spinning up "takes about one minute". That is why the Worker allows a long fetch timeout (300 s) and retries once on a network failure, 429, 502 or 503.
- 750 free instance hours per workspace per calendar month; spun-down services do not use hours; unused hours do not roll over; when they run out, all free web services are suspended until the next month.
- **Consequence (design check for the owner):** a call every 15 minutes keeps the API awake most of the day. One always-on service is about 720 to 744 hours a month, so R&D and production together do not fit in 750 hours if both are kept awake (the existing note in `docs/setup/deployments.md` says the same). Run the cron against R&D only while testing, delete the trigger when done, and for production decide on the hours (for example only 05:00-18:59 UTC like the wake-up workflow: `*/15 5-18 * * *`).

Not verified: whether a Render free service that is woken by a request is counted from wake-up or from the first request for the monthly hours (needs check); Cloudflare's wording of the card requirement for Workers Free (see `docs/setup/deployments.md`).

## Known limits

- **Starvation.** Users that keep failing (for example Google keeps answering 503 for one user) never get a new `last_synced_at`, so they stay first in the "oldest first" order. With more than `CALENDAR_CRON_MAX_USERS` such users, the others would wait. Fine at personal scale; the later fix is a `last_attempt_at` column that the order and the due check use.
- **The due function is executable by the app role.** `calendar_users_due` is `SECURITY DEFINER` and the app login (`app_<env>_user`) may execute it, so code running as the API can list due user ids (ids only). No user route calls it, and no request field reaches it; the only caller is the cron service, behind the secret. Nobody else (PUBLIC, the backup role, the other environment's role) can execute it.
- **Best-effort timing, in-memory locks and limits, no abort of a sync that exceeded its per-user budget** (see above).

## Why a Cloudflare cron trigger (and not a GitHub Actions cron)

- **Decision (owner):** Cloudflare cron trigger, free, no card (needs check, above).
- **GitHub Actions cron** is also free, but the schedule can be delayed under load, runs only on the default branch (`main`, so R&D could not be tested on `rnd`), the shortest interval is 5 minutes, and scheduled workflows are disabled after 60 days without repository activity in public repos (see `docs/setup/deployments.md`). Every run also burns Actions minutes if the repo is private.
- **Cloudflare cron** runs from the deployed Worker, per environment, independent of repository activity, and is configured in a file in the repo. The Worker is tiny and has no dependencies.
- **Limits we accept:** timing is best effort (a run may start a few minutes late or, rarely, be skipped; the next run catches up because "due" is decided by `last_synced_at`, not by the clock); the Render free API has a cold start of about a minute, so the first call after idle is slow and may need the one retry; the cron secret is a shared secret (rotate it by changing both places); in-memory locks and limits assume one API process (the free plan).

## Tests

- `apps/api/test/calendar-cron.test.ts` (database): 404 when off, 401 variants, strict body, due selection, batch limit and order, failure isolation, reconnect marking, single flight (409), rate limits, RLS isolation, canary scan of responses and logs, write guard, the `autoSync` setting.
- `apps/api/test/calendar-cron-auth.test.ts`: `timingSafeEqual` on equal-length digests.
- `packages/db/test/calendar-cron-schema.test.ts` and `convention.test.ts`: the migration, the function and its grants.
- `apps/cron/test/sync-due.test.ts`: URL, header, retry, no secret in logs.
