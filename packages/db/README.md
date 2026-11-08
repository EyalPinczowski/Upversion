# @upversion/db

Database environments (`prod`, `rnd`) and the migration runner. Background: ADR 003 and SPEC sections 3.A, 5 and 6.

## Conventions

1. Only two environments exist: schemas `prod` and `rnd`. Every migration run names its schema explicitly; the runner refuses anything else (`public`, empty, `PROD`, injection text) before it connects.
2. Every table in an environment schema has **row-level security enabled** and a **SELECT policy for `backup_<schema>`** (`using (true)`). Policies for app users target `app_<schema>_user` and use `<schema>.current_user_id()` (ADR 010), never Supabase's `auth.uid()`. Without a user context it is NULL, so a query sees no rows.
3. Nothing has `BYPASSRLS`. Objects are created under `SET LOCAL ROLE {{owner}}` so `owner_<schema>` owns them.
4. Nothing is granted to `PUBLIC`, `anon`, `authenticated` or `service_role`. The shared Supabase `authenticated` role is not used.
5. Migrations are additive, named `NNNN_name.sql`, never edited after they were applied (the runner compares checksums and fails naming the file).
6. `findConventionViolations(client, schema)` (exported from `src/`) checks convention 2; call it in the tests of every migration branch.

## Data model (migrations 0002-0010)

`current_user_id()` (0002); `app_users`, `app_settings`, `legal_acceptances` (0003); `plans`, `week_patterns`, `day_overrides`, `tasks`, `logs` (0004); `events` (0005, append-only). Client-generated ids are unique per user (composite keys with `user_id`), and child rows reference `(user_id, plan_id)` so they cannot point at another user's plan. RLS is enabled, not forced: the NOLOGIN owner role is the admin/background path (creating users, changing `role`/`status`, account deletion). The app role cannot insert or delete `app_users` rows or write `app_settings`, and cannot update or delete `events` or `legal_acceptances`. Tests: `test/data-model.test.ts`.

Migration 0006 (ADR 011) adds `allowed_emails` (no app privilege) and two `SECURITY DEFINER` functions: `provision_user(id, email)` (allowlist and `user_cap` checked; `EXECUTE` only for `app_<s>`, which for this holds `USAGE` on its schema and nothing on any table) and `delete_account()` (deletes only the claimed user; `EXECUTE` only for `app_<s>_user`). Tests: `test/accounts-admin.test.ts`.

Migration 0007 adds `day_sessions` and `schedule_days` (frozen past days, append-only). Migration 0008 adds `day_reviews` (one per plan and date; the app may re-save only the ratings, note and outcomes, never delete) and `adjustments` (the user's accepted or rejected suggestions with their evidence; insert and select only). See `docs/api-reviews.md`.

Migration 0009 (practice): `practice_contexts` (job description per plan; no delete), `practice_sessions` (the app can change only `status`, `ended_at`, `pending_turn_id`, `pending_since`, `providers_used`; one active session per task), `practice_messages` and `practice_feedback` (append-only). Migration 0010 (AI usage): `ai_usage_daily` (per-user counters, atomic reserve with `ON CONFLICT ... WHERE requests < cap`), `ai_cache` (per user; the user may prune their own rows) and `ai_provider_usage` (environment-wide, no user, no app privilege and no policy for the app). Two more `SECURITY DEFINER` functions, both `EXECUTE` only for `app_<s>_user`, `search_path` pinned, no dynamic SQL, and both returning nothing without a signed-in user: `ai_reserve_provider(provider, budget)` (counts one call for the current UTC day, computed inside, and returns true while fewer than `budget` were counted; budget 1..1000000; call it in its own short committed transaction before the network call) and `ai_provider_usage_today()` (today's counters, read only). No provider name appears in any constraint: provider ids are free-text slugs checked in the API. Tests: `test/practice-schema.test.ts` (both schemas) and the parametrised cases in `test/data-model.test.ts`. The account export and deletion cover every table with a `user_id` column; `apps/api/test/accounts.test.ts` fails if one is missing.

Migration 0011 (calendar, spec 3.8): `calendar_connections` (one per user; the refresh token only as ciphertext), `calendar_oauth_states` (short-lived, no update, `state_hash` unique), `calendar_event_links` and `calendar_locked_blocks` (per plan block, cascade with the plan), `calendar_busy` (minutes of a local date; title only, never descriptions or attendees) and `calendar_sources`. All have `user_id` with RLS; the app can delete its own rows and update only working columns. The account export omits the ciphertext column and `calendar_oauth_states`. Tests: `test/calendar-schema.test.ts` (both schemas) and the parametrised cases in `test/data-model.test.ts`.

Migration 0013 (calendar sync, additive): `calendar_sources.sync_token`, `window_start`, `window_end` (Google's incremental-sync token and the dates it covers), `calendar_connections.sync_timezone` (the zone the busy rows were computed in) and `calendar_event_links.last_summary`. All nullable; the app login may update them.

Migration 0014 (calendar event colours, additive): `calendar_event_links.last_color` (the Google `colorId` '1'..'11' last written to the event; nullable, the app login may update it). A null or different value makes the next sync patch the event.

Migration 0015 (calendar event details, additive): `calendar_event_links.last_detail_hash` (SHA-256 hex of the description last written to the event; nullable, the app login may update it). The description itself is not stored. `test/migrate.test.ts` renames its copied migration to a high number (9002) so new real migrations never collide with it.

Migration 0016 (user profiles, ADR 015): `user_profiles`, one row per user (a missing row means setup not started): setup `answers`, CV-confirmed or manual `skills`, `roles_held`, `years_experience`, `cv_imported_at`, `setup_status` and `setup_step`. No column for raw CV text, files or evidence (the CV is read in the browser only); `pg_column_size` caps on the three jsonb columns; the app can add, read, change and delete its own row and update every column except `user_id` and `created_at`; cascade on account delete. Tests: `test/profile-schema.test.ts` (both schemas) and the parametrised cases in `test/data-model.test.ts`.

SQL tokens: `{{schema}} {{owner}} {{app}} {{app_user}} {{backup}}`. Anything else in `{{ }}` is an error.

## How the roles fit together (per schema `s`)

| Role             | Login | Purpose                                                                                                                 |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `owner_<s>`      | no    | Owns the schema and every object in it.                                                                                 |
| `app_<s>`        | yes   | The backend connects as this. NOINHERIT, so it has no privileges until it switches role. No password in any file.      |
| `app_<s>_user`   | no    | The backend runs `SET LOCAL ROLE app_<s>_user` and `set_config('request.jwt.claims', <json>, true)` in each request transaction. Holds the table privileges; RLS applies to it. |
| `backup_<s>`     | yes   | Read-only; sees rows only through explicit SELECT policies.                                                             |

`app_<s>` is a member of `app_<s>_user`. No role of one environment is a member of, or has USAGE on, anything of the other. All roles: NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, NOINHERIT.

## Commands

```bash
DATABASE_URL=... pnpm --filter @upversion/db migrate migrate --schema rnd --dry-run
pnpm --filter @upversion/db migrate migrate --schema rnd
pnpm --filter @upversion/db migrate status --schema rnd
APP_PASSWORD=... BACKUP_PASSWORD=... pnpm --filter @upversion/db migrate set-passwords --schema rnd
pnpm --filter @upversion/db migrate promote-admin --schema rnd --email you@example.com   # the only way to become admin
```

`DATABASE_URL` is the admin connection (from a secret). Passwords must be at least 24 characters. Missing `--schema` or `DATABASE_URL` exits with code 2. The connection string and passwords are never printed.

## Running the tests locally

```bash
packages/db/scripts/test-postgres.sh start        # throwaway cluster on port 55432 (needs PG 16 binaries)
export TEST_DATABASE_URL=postgres://migrator@127.0.0.1:55432/upversion_test
export TEST_SUPERUSER_URL=postgres://postgres@127.0.0.1:55432/upversion_test   # same as: scripts/test-postgres.sh env
pnpm --filter @upversion/db test
packages/db/scripts/test-postgres.sh stop         # stops the cluster and deletes its directory
```

Without `TEST_DATABASE_URL` the database tests are skipped with a warning; when `CI` is set they fail instead. The tests use a non-superuser admin (`migrator`) and no stub of Supabase's `auth` schema: the policies depend only on `current_user_id()` from the migrations.

## Needs check (not provable with the local tests)

- Whether Supabase's default admin role (`postgres`) can do what `migrator` does here: CREATE ROLE, `GRANT owner_<s> TO current_user`, `ALTER ROLE ... NOBYPASSRLS`, `CREATE SCHEMA ... AUTHORIZATION owner_<s>`, `ALTER DEFAULT PRIVILEGES FOR ROLE owner_<s>`.
- That Supabase's role has the BYPASSRLS attribute (needed on PG16 to run `ALTER ROLE ... NOBYPASSRLS`). Finding from the tests: a non-superuser cannot run `NOSUPERUSER` or `NOREPLICATION` in `ALTER ROLE` (permission denied), so bootstrap omits them and fails the run if either attribute is present.
- Supabase's Postgres major version (tests use 16; the SQL avoids PG16-only syntax, but PG15 was not run).
- Whether Supabase has extra default privileges for new objects in other schemas, or grants on the `public` schema, that give `app_<s>` more than intended.
- The pooler: transaction mode keeps no session state, so `SET LOCAL ROLE` must be inside each request transaction; custom role names may need the `role.project-ref` form (ADR 003).
- Password authentication for the new login roles from the backend hosts (connection string flavour and IPv6/pooler question: see `docs/setup/database.md`).
