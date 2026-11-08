# 015 – First-time setup and in-browser CV import

**Status:** Accepted

Approved by the owner on 2026-11-08 with one change to the question list (`language` and `formats` replaced by `target_role` and `target_skills`). The two new questions break two build rules as first written; the owner also confirmed on 2026-11-08 the rule change that resolves it (see "Check on the new questions").

Background: the owner approved building "Profile import from CV" (spec 12.1) as part of a first-time setup; this record decides how. LinkedIn import stays deferred. Builds on ADR 002/014 (calendar), 004/012 (AI optional), 010 (`current_user_id()`), 007 (catalog-grounded plans).

## Context
- Spec 3.0 (plan builder, not built yet) runs a 28-question intake from `data/catalog/questions.json`. Spec 12.3 already defines the `ProfileSource` seam and a structured `UserProfile` (skills with levels, roles held, years, education).
- Spec 12.3 plans CV parsing **in the backend**, deleting the file after extraction. **This record replaces that with a stricter design: the CV never leaves the browser.** That disagreed with 12.3 as written, so the spec change in "Spec edit (applied)" below is part of the decision.
- Some intake answers are about the person, not about one goal (situation, education, tools, weekly time, learning preferences). Asking them once, before the first plan, makes the calendar step and the later plan builder better and shorter.

## Decision

### 1. The 8 setup questions (from `questions.json`, never hard-coded)
| Order | id | stage | type | required in setup | `maps_to` | why it belongs in setup |
|---|---|---|---|---|---|---|
| 1 | `current_status` | background | single | yes | `profile.status` | person-level; drives the hours hint |
| 2 | `education` | background | single | no | `profile.education` | person-level; CV can pre-fill |
| 3 | `tools_known` | background | multi | no | `profile.tools` | person-level; CV can pre-fill |
| 4 | `days_per_week` | time | weekdays | yes | `week_pattern.study_weekdays` | defaults for the calendar step and every plan |
| 5 | `hours_per_day` | time | number | yes | `week_pattern.default_hours` | same; `hint_if` uses answer 1 |
| 6 | `time_of_day` | time | single | no | `week_pattern.preferred_window` | places blocks in the calendar |
| 7 | `target_role` | goal | multi_role (max 2) | yes in `questions.json`; see check below | `goal.target_roles` | the roles the person is aiming for, stored as a profile default; pre-fills the first plan |
| 8 | `target_skills` | goal | multi_skill (max 5) | yes in `questions.json`; see check below | `goal.target_skills` | the skills the person wants to learn, stored as a profile default; pre-fills the first plan |

Left out on purpose: the other goal questions (`goal_type`, `goal_why`, per plan), `language` and `formats` (asked in the plan builder), `skill_levels` (needs a target role), `budget`/`certificates` (per plan), and every free-text question (`background`, `goal_why`, `concerns`, `job_posting`) so setup collects no free text that could hold personal details.

**Flag:** each of the 8 entries in `data/catalog/build/questions.py` gets `"setup": {"order": n}`; `target_role` and `target_skills` also carry `ignore_show_if`, `choices_only` and `optional` (see "Check on the new questions"). `build.py` validates: exactly 8 setup questions, orders 1..8 unique, no `show_if` unless the setup flag has `ignore_show_if: true`, no `allow_other` unless `choices_only: true`, no `privacy`, and the question `type` must be on the **allowlist** of setup types: `single`, `multi`, `weekdays`, `number`, `yes_no`, `multi_role`, `multi_skill` (any other type fails the build, so a new free-text type cannot slip in). `questions.json` is regenerated; the catalog-drift CI rule applies. The web reads setup questions with a shared selector (`setupQuestions()`), sorted by `setup.order`. Changing the set is a data change, not a code change. **Added in WP-C (small, drift-free):** the `setup` flag may also carry `why` (a string) which replaces the question's `why` in setup only; `target_skills` uses it (`"Pick up to 5."`) because its plan-builder text says "You can type ones that aren't listed", which setup does not allow. `setupQuestions()` prefers `setup.why`; `lint.py` validates it; the plan-builder text is unchanged.

Answers to `goal.*` and `week_pattern.*` questions are stored in the profile as **defaults**; the plan builder copies them into the plan's `Goal`/`WeekPattern` (the question's `maps_to` is unchanged).

### 2. Flow, skip and resume
Steps: **Welcome** (one screen: what setup is, ~3 minutes, "Skip for now") → **8 questions** (one per screen, progress "Question n of 8", Back/Next) → **CV (optional)** → **CV review** (only if a CV was read) → **Calendar (optional)** → **Done** (summary, each item editable).

- **Nothing in setup is necessary to use the app.** "Necessary" means only: a question that is `required` and not `setup.optional` must be answered to press Next on that screen (`target_role` and `target_skills` are `optional`); the whole setup can be skipped at any step ("Skip setup for now"). The plan builder asks any missing answer later.
- **Status** (per user, server-side): `not_started` → `in_progress` → `completed`, or `dismissed` (skipped). `completed` = the 8 screens passed (answered or optional-skipped), the CV step done or skipped, and the calendar step done or skipped.
- **Redirect rule (as built, WP-C):** after sign-in and Terms acceptance, the app routes to `/setup` once per page load, and only when the profile API answered 200, the status is `not_started`, **the user has no plan yet**, the welcome dialog and tour have been seen and are closed, and the current page is not `/setup` or the calendar callback. `in_progress` is **not** redirected (this narrows the first draft of this record: someone who started and left finds "Finish setup" in Settings, so setup never pulls them back). Users who already have a plan (everyone today) are never redirected; Settings > Profile setup offers Set up / Finish setup / Run setup again, and "Clear my profile" (hidden before setup has started). `dismissed` never redirects again; "Run setup again" sets `in_progress`. "Clear my profile" (DELETE) clears answers, skills, roles held, years and `cv_imported_at` but sets `setup_status` to `dismissed`, so clearing never sends the user back into the setup redirect.
- **Resume:** answers are saved after every question screen (idempotent PUT); the server keeps `setup_step`. Reopening resumes at that step with answers pre-filled. The CV step is **not** resumable: raw text lives only in memory and is gone on reload (by design).
- **Calendar step** reuses the existing connect flow (`POST /api/v1/calendar/connect` → Google → `/calendar/callback`). The callback page returns to `/setup` when the flow started there (an allowlisted return path kept in `sessionStorage`, not a URL parameter). Hidden when `FEATURE_CALENDAR` is off. No sync runs until a plan exists.
- Behind a feature flag `FEATURE_PROFILE_SETUP` (default off, spec 12.3); when off, profile routes are not registered and the web never shows setup.

### 3. CV handling (privacy-preserving, no AI)
- **Read only in the browser.** The user picks or drops a `.pdf` or `.docx` (≤ 5 MB, PDF ≤ 10 pages), or pastes text. The file is never uploaded, never stored (no server, no `localStorage`/`sessionStorage`/IndexedDB, no service-worker cache). Text is held in component state and cleared when the user leaves the CV steps.
- **Extraction libraries** (lazy-loaded only on the CV step, separate chunk, main bundle unchanged):
  - PDF: `pdfjs-dist` (Mozilla pdf.js, **Apache-2.0**), an exact pinned version at least two weeks old and **≥ 4.2.67** (fixes CVE-2024-4367, script execution through a crafted font). Options: `isEvalSupported: false`, `disableFontFace: true`, data passed as an `ArrayBuffer` (no URL fetch), worker served from our own origin. Only `getTextContent()` is used; nothing is rendered.
  - DOCX: `fflate` (**MIT**, ~8 KB gzip, needs check) to unzip, read `word/document.xml` with the browser `DOMParser` (`w:p` → line, `w:t` → text). Cap: uncompressed size ≤ 20 MB (zip-bomb guard). Rejected: `mammoth` (BSD-2-Clause, larger, HTML conversion not needed). Legacy `.doc` is not supported (message: save as PDF or DOCX, or paste the text).
  - Bundle cost (measured in WP-C, `vite build`, minified): the wizard is a lazy route chunk (122 kB, 37 kB gzip); the entry chunk is not larger than before (919 kB against 1,005 kB on `rnd`, thanks to `"sideEffects": false` in `packages/shared/package.json`, which lets the bundler drop unused shared code from the entry). pdf.js `pdfjs-dist` 6.4.299 legacy build is **487 kB main (148 kB gzip) + 1,321 kB worker (about 392 kB gzip), about 1.81 MB**, loaded only when a PDF is picked. This is over the 1.6 MB budget above; the newest 4.x (4.10.38) is no smaller (373 kB + 1,418 kB). **Revised budget: 1.85 MB for the lazy pdf chunk plus worker, +0 KB to the entry chunk. This needs the owner's approval.**
- **Contact details dropped first, on the device:** matching runs on the **raw text held in memory**, because redaction would break real signals (`03/2018 - 06/2021` as a digit run, `ASP.NET` and `monday.com` as hosts). The shared `redactPii()` (`packages/shared/src/practice/redact.ts`: emails, URLs, hosts, `@handles`, long digit runs) is applied only to **evidence snippets** and to **free-text title values** before they are shown or put in a payload. Name and contact block: if the text has a section heading (Experience, Education, Skills, ...), lines before the first heading are dropped from evidence and title candidates; if it has no section heading, only the first 2 non-empty lines are dropped. Nothing of the raw text is ever sent; this protects the review screen and the evidence snippets.
- **Deterministic matching (no AI)** in a pure shared function `extractProfileFromText(text, options?)` (`options`: `taxonomy`, `tools`, `now`; each defaults to the bundled catalog and the current time):
  - **Skills:** NFKC, case-insensitive, whole-word match of each `skills.json` `name` and `keywords` entry (aliases that contain " / " are split first, so `Zapier / Make` and `ChatGPT / Claude` become separate aliases). A multi-word keyword is a strong hit; a single-word keyword is weak. A skill is suggested with ≥ 1 strong hit, ≥ 2 weak hits, or any hit inside a "Skills" section.
  - **Level guess** (the `skill_levels` scale 0–3): only in a Skills section or one weak mention → 1 Basic; mentioned in an experience entry whose date range totals ≥ 2 years → 2 Comfortable. Never 3 automatically; never 0 (absence is not evidence).
  - **Roles held:** experience-section lines matched against `roles.json` `aliases`/`title` give `{roleId, title}`; date ranges on the same or next line (`2019 – 2023`, `Jan 2020 – Present`, `03/2018 - 06/2021`) give years (rounded to 0.5, "Present" = `now`). Unmatched title lines are offered only as editable text, unchecked by default.
  - **Years of experience:** union of experience date ranges (overlaps counted once), capped at 50.
  - **Education level:** keyword rules to the `education` option values (`PhD`, `M.Sc`, `MA`, `MBA`, `Master` → `master`; `B.Sc`, `BA`, `B.A.`, `Bachelor` → `bachelor`; abbreviations such as `BA` and `MA` are matched **case-sensitively**, full words case-insensitively; `courses`, `bootcamp`, `diploma`, `certificate program` → `some_college`; `high school`, `Bagrut` → `high_school`); highest wins.
  - **Tools:** whole-word match of the `tools_known` option labels from `questions.json`, with " / " labels split into separate aliases (e.g. `Zapier / Make` gives `Zapier` and `Make`, each mapping to the option).
  - Each suggestion carries an `evidence` snippet (≤ 80 chars, passed through `redactPii()`) shown only on the review screen.
- **Review screen:** every suggested item is a row with a checkbox (default checked for strong matches and for any match inside a Skills section, unchecked for other weak ones), an editable level/years/title, and its evidence. Nothing is sent until the user presses "Save these to my profile". A pure `toImportPayload(confirmed)` builds the request from an allowlist of fields: `skills[{skillId, level}]`, `rolesHeld[{roleId|null, title, years|null}]`, `yearsExperience`, `education`, `tools[]`. No `evidence`, no raw text, no file name.
- **Enforcement tests:** (a) shared: `toImportPayload` output has exactly the allowlisted keys, contains no evidence text; (b) web: a fictional CV fixture with a canary sentence, an email, a phone number and a URL is run through the whole wizard with the API client mocked; the test asserts that no request URL, header or body contains the canary, the contact details, or any 30-character substring of the raw text outside the confirmed values, and that no web storage holds them; (c) API: free-text `title` fields are rejected (400) if the shared detector finds an email, URL, handle or phone-like run (defence in depth).

### 4. Data model (additive migration `0016_user_profiles.sql`)
One row per user, Tier 2 data (like calendar; **owner to confirm the tier in 3.B**). No column for raw CV text, file, file name or evidence; free-text content (role `title`) is validated by the API, and `pg_column_size` checks cap the size of `answers`, `skills` and `roles_held`.

```sql
create table {{schema}}.user_profiles (
  user_id uuid primary key references {{schema}}.app_users (id) on delete cascade,
  -- Setup answers keyed by questions.json id (only setup-flagged ids); validated in the API against the question definitions.
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  -- [{skillId, level 0..3, source 'cv'|'setup'|'manual'}], <= 60 items; skillId must be a taxonomy id (API).
  skills jsonb not null default '[]' check (jsonb_typeof(skills) = 'array' and jsonb_array_length(skills) <= 60),
  -- [{roleId|null, title <= 80 chars, years 0..50|null}], <= 15 items.
  roles_held jsonb not null default '[]' check (jsonb_typeof(roles_held) = 'array' and jsonb_array_length(roles_held) <= 15),
  years_experience numeric check (years_experience is null or years_experience between 0 and 50),
  cv_imported_at timestamptz,
  setup_status text not null default 'not_started'
    check (setup_status in ('not_started', 'in_progress', 'completed', 'dismissed')),
  setup_step text check (setup_step is null or char_length(setup_step) <= 40),
  setup_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pg_column_size(answers) <= 8192 and pg_column_size(skills) <= 16384 and pg_column_size(roles_held) <= 8192)
);
```
- **RLS:** enabled; `app_user_select/insert/update/delete` policies `using/with check (user_id = (select {{schema}}.current_user_id()))`; `backup_select` for `{{backup}}`. Column grants (per column, as in 0011 and 0013): the app role may update every column except `user_id` and `created_at`; `updated_at` is set by the API on each write, not by a trigger. Missing row = `not_started` (no backfill).
- Account export includes the row; account delete removes it (cascade). Migration runs on `rnd` first, then `prod`, through the existing migrator (explicit target schema).

**API** (`apps/api/src/modules/profile`, all under the Terms guard, user from `request.accountId`, never a `user_id` in the input; strict zod; idempotency plugin on writes):
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/v1/me/profile` | – | `UserProfileView` (defaults when no row) |
| PUT | `/api/v1/me/profile/answers` | `{answers: {[setupQuestionId]: value}}` | partial merge; unknown id, non-setup id or invalid value → 400 |
| PUT | `/api/v1/me/profile/import` | `ProfileImport` (allowlist above) | **replaces** all `skills` items with `source: 'cv'` by the confirmed ones; items with `source: 'manual'` or `'setup'` are kept, and a confirmed CV skill that already exists as `manual`/`setup` leaves the existing item unchanged (the user's own level wins). Sets `roles_held`, `years_experience`, `cv_imported_at`; pre-fills `education`/`tools_known` answers only where empty |
| PATCH | `/api/v1/me/profile/setup` | `{status, step?}` | `completed` sets `setup_completed_at` |
| DELETE | `/api/v1/me/profile` | – | "Clear my profile": clears answers/skills/roles_held/years/`cv_imported_at`, keeps the row with `setup_status = 'dismissed'` (no redirect back to setup) |

**Shared** (`packages/shared/src/profile/`): `UserProfile`, `ProfileSkill`, `RoleHeld`, `SetupStatus`, `ProfileImport` zod schemas (`.strict()`), `setupQuestions()` (returns the 8 setup questions sorted by `setup.order`; for each it strips `show_if` and `allow_other` according to the flags and treats `required` as false when `setup.optional`; the wizard renders only this output), `validateAnswer(question, value)` (for `multi_role`/`multi_skill`: every value is a `roles.json`/`skills.json` id, count <= `max`, "Other" or a typed value is rejected, an unknown role id is rejected) (generic per question `type`/`options`/`min`/`max`), `extractProfileFromText`, `toImportPayload`. This is the `ProfileSource` seam: implementations `manual` (setup answers) and `cv-browser`.

**Consumers**
- **Welcome guide** (`feature/web-welcome-guide`, `localStorage` "seen" flag): unchanged storage; it shows only after setup is `completed` or `dismissed` (never on top of `/setup`), and may read the profile to tailor tips (e.g. a calendar tip when not connected). Setup state is per user on the server; the guide's flag stays per device.
- **Plan builder (3.0):** pre-fills intake answers with the same question ids from `profile.answers` (shown pre-filled, still editable), pre-fills the `skill_levels` matrix from `profile.skills` for the target role's skills, copies time answers into the new plan's `WeekPattern`, and uses `years_experience`/`roles_held.roleId` in the rule-based fallback. **AI prompts** may receive skill ids, levels, years, education level, tools and `roleId`s only, never the free-text `title`.

## Check on the new questions
Read from `data/catalog/questions.json` and `data/catalog/build/questions.py` (2026-11-08):

| Rule | `target_role` | `target_skills` |
|---|---|---|
| Type | `multi_role`, `max: 2`, `options_source: "roles"` (choice from `roles.json`) | `multi_skill`, `max: 5`, `options_source: "skills"` (choice from `skills.json`) |
| `show_if` | **Yes:** `goal_type` in `new_role`, `grow_in_role`. Breaks "no `show_if`". | **Yes:** `goal_type` in `specific_skill`. Breaks "no `show_if`". |
| Free text | **Yes:** `allow_other: true` lets the user type a role not in the list. Breaks "no free text". | **Yes:** `allow_other: true`, and its `why` says "You can type ones that aren't listed". Breaks "no free text". |
| `required` | `true` | `true` |

Neither question is a `text` or `text_or_url` type, and neither has `privacy`, but both break the `show_if` and free-text rules, and both are `required: true` (which would force an answer in a setup that must be fully skippable). `goal_type` is not a setup question, so a `show_if` on it can never be evaluated in setup: left as is, the screens would be hidden.

**Rule change, confirmed by the owner on 2026-11-08:** keep "no free text" and keep the 8-question rule, and change only how the flag overrides the plan-builder definition. The `setup` object gets two optional fields, used only by setup:
- `"setup": {"order": n, "ignore_show_if": true, "choices_only": true, "optional": true}`. In setup, `ignore_show_if` shows the question regardless of `goal_type`; `choices_only` removes the "Other" entry and the typed-value field, so only ids from `roles.json` / `skills.json` can be stored; `optional` means setup never blocks on it (the plan builder still treats it as `required`). The plan-builder definition of both questions (with `show_if`, `allow_other`, `required`) is unchanged.
- Build rules become: exactly 8 setup questions; orders 1..8 unique; a setup question has no `show_if` **unless** it carries `ignore_show_if: true`; no `allow_other` unless `choices_only: true`; none has `privacy`; the type is on the allowlist (`single`, `multi`, `weekdays`, `number`, `yes_no`, `multi_role`, `multi_skill`), replacing the earlier free-text denylist. The build fails otherwise, so a future question cannot slip free text into setup.
- `validateAnswer` gains `multi_role` and `multi_skill` (ids must exist in the taxonomy, count within `max`). The "Other" entry is not a way to store anything in `user_profiles.answers`.

Alternatives considered and not chosen: dropping the two questions (ask them only in the plan builder), and allowing `allow_other` in setup with typed text screened by the PII check (weakens "setup collects no free text"). The owner confirmed the change above: both questions are always shown in setup, choices only (no "Other" or typed text), optional, up to 2 roles and 5 skills; plan-builder definitions are unchanged. A role or skill picked in setup is a standing default, not a plan goal, so the plan builder shows it pre-filled and editable and does not skip `goal_type`.

## Spec edit (applied to `docs/SPEC.md` in the same change, as approved)
```diff
@@ 3.0 Plan builder
+**Step 0 – First-time setup (once per user, skippable):** before the first plan, the app asks the
+8 questions flagged `setup` in `questions.json`, offers an optional CV import (read only in the
+browser, see 12.3), then offers Google Calendar connect. Answers are saved to the `UserProfile`
+after every screen and pre-fill the intake; nothing in setup blocks using the app.
@@ 3.0 Step 1 – Guided intake
-- **Adaptive:** questions that don't apply are skipped (`show_if`), and pre-filled answers come from earlier plans when they exist.
+- **Adaptive:** questions that don't apply are skipped (`show_if`), and pre-filled answers come from the profile (setup) and earlier plans when they exist.
@@ 12.1 Deferred features
-| **Profile import from CV / LinkedIn** – read the user's CV and LinkedIn profile, ... | Needs file parsing, careful PII handling, and a good skill taxonomy first. | Manual "Where are you now?" step in the wizard (3.0). |
+| **Profile import from LinkedIn** – read the user's LinkedIn data export and pre-fill the profile | Needs export-format handling and its own review. (CV import moved into v1 setup, ADR 015.) | CV import in setup, or the manual answers. |
@@ 12.3 ProfileSource
-- `ProfileSource` – manual implementation only (...). → CV upload and LinkedIn import later fill the same structure.
-  - **Planned approach for later:** CV as PDF/DOCX parsed in the backend; LinkedIn via ...
-  - **Privacy:** contact details ... are stripped before any text reaches a model; the original file is deleted after extraction unless the user chooses to keep it; ...
+- `ProfileSource` – `manual` (setup answers) and `cv-browser` implementations (ADR 015). → LinkedIn import later fills the same structure.
+  - **CV (v1):** PDF/DOCX text is extracted in the browser only and matched to `skills.json`/`roles.json` by keyword rules, no AI. The file and its text never leave the device; only the fields the user confirms on a review screen are sent.
+  - **LinkedIn (later):** the user's own data export (CSV) or a "Save to PDF" of the profile, read the same way – never scraping.
+  - **Privacy:** contact details are dropped on the device; free-text role titles are never sent to a model.
```
Still to do (not in this change): the privacy-policy draft in `docs/legal/` (CV processed on the device only; owner wording), section 8 (Screens: Setup) and section 4 (data model: `user_profiles`).

## Work packages (Sonnet builders, each in its own worktree, PR into `rnd`)
Order: **WP-D → WP-A → (WP-B ∥ WP-C)**. WP-A's matcher part can start in parallel with WP-D; its `setupQuestions()` part waits for WP-D. WP-C builds against a mocked client after WP-A and wires the generated client after WP-B merges.

**WP-D – questions bank** (`feature/catalog-setup-questions`)
- Files: `data/catalog/build/questions.py` (add `"setup": {"order": n}` to the 8 ids, and `"ignore_show_if": true, "choices_only": true, "optional": true` on `target_role` and `target_skills`), `data/catalog/build/build.py` (validation rules in §1, fail the build with a clear message), regenerated `data/catalog/questions.json` (run `python3 build.py` from `data/catalog/build`), `data/catalog/README.md` (one line on the `setup` field), `packages/shared/src/catalog-data.test.ts` (the 8 ids in order; rules hold).
- Accept: CI catalog-drift green; the build fails when: a setup question has `show_if` without `ignore_show_if`; a setup question has `allow_other` without `choices_only`; a setup question has `privacy`; a 9th question is flagged; a question of a type outside the allowlist is flagged (show each failing run in the PR). `target_role` and `target_skills` keep their plan-builder definitions unchanged.

**WP-A – shared types and CV matcher** (`feature/shared-profile-cv-match`)
- Files: `packages/shared/src/profile/{types.ts,schemas.ts,setup.ts,answers.ts,cv-match.ts,cv-payload.ts}` + tests, export from `index.ts`.
- Tests (fictional CVs only, in `profile/fixtures/`): three English CVs (ops, data analyst, career changer), one with Hebrew lines plus Latin tool names, one two-column-order mix, one with no sections; assert skills, levels, roles, years (fixed `now`), education, tools; weak single-word keywords alone do not suggest a skill; contact details absent from all output and evidence; `toImportPayload` key allowlist; `validateAnswer` accepts/rejects per type (single, multi, weekdays, number bounds/step, multi_role and multi_skill: taxonomy ids only, count <= max, "Other"/typed value rejected, unknown role id rejected); `setupQuestions()` output has no `show_if`/`allow_other` and `required: false` for optional ones; the no-sections CV drops only the first 2 lines; `03/2018 - 06/2021`, `ASP.NET` and `monday.com` are still matched on raw text while evidence is redacted; `BA`/`MA` match case-sensitively; schemas reject unknown keys and any `userId`. Matcher linear-time (no nested unbounded regex), 10-page CV under 50 ms in the test.
- Accept: no I/O, no new runtime dependency, coverage of every rule in §3.

**WP-B – database and API** (`feature/api-user-profile`)
- Files: `packages/db/migrations/0016_user_profiles.sql`, `packages/db/test/profile-schema.test.ts` (+ rls test cases), `apps/api/src/modules/profile/{routes.ts,service.ts,repository.ts,schemas.ts}`, `apps/api/src/features.ts` (`FEATURE_PROFILE_SETUP`), app registration, account export/delete, regenerated OpenAPI + `apps/web/src/api/schema.d.ts`, `docs/api-profile.md`, `.env.example` (flag only).
- Tests: RLS directly in Postgres (user A cannot select/update/delete B's row; `user_id` and `created_at` not updatable; size caps reject oversize jsonb; backup role reads); `DELETE` keeps `setup_status = 'dismissed'`; import replaces only `source: 'cv'` skills and keeps `manual`/`setup` ones; `validateAnswer` is enforced on `PUT answers` including `multi_role`/`multi_skill` (unknown role/skill id, over `max`, "Other"/typed value → 400); migration additive on a db with existing data; API: each endpoint happy path, strict-schema 400s (unknown key, `userId` in body, non-setup question id, bad option, skill id not in taxonomy, title with email/URL/phone), Terms guard 403, flag off → 404, idempotent retries, export contains the profile, account delete removes it.
- Accept: no column for raw text, content validated by the API, `pg_column_size` caps in place; the API never reads a user id from input.

**WP-C – web setup wizard** (`feature/web-setup-wizard`)
- Files: `apps/web/src/pages/setup/{SetupPage.tsx,QuestionStep.tsx,CvStep.tsx,CvReviewStep.tsx,CalendarStep.tsx,DoneStep.tsx,cv-extract.ts}` + tests, route `/setup` in `App.tsx`, redirect rule in the account/plan bootstrap, `CalendarCallbackPage` return-to-setup, Settings card "Finish setup / Run setup again / Clear my profile", `package.json` (pinned `pdfjs-dist`, `fflate`), vite config for the worker asset.
- UI: Blocks design, no gradients, no nested cards, no decorative emoji; one question per screen rendered generically from the question definition (`why` under the question, `hint_if`); progress text + `<progress>`; focus moves to the step heading on change; drop zone is a labelled `<input type=file>` reachable by keyboard; review rows are a fieldset list; error and scanned-PDF messages in `role="alert"`; `dir="auto"` on evidence; axe clean on every step; works at 360 px.
- Tests: the privacy canary test (§3 b); resume at the saved step after reload; skip at any step sets `dismissed`; a `required` and not `setup.optional` question blocks Next only on its screen, and `target_role`/`target_skills` never block; existing user with a plan is not redirected; scanned/encrypted/oversize/`.doc` files show the right message; CV chunk is lazy (not in the entry chunk); calendar step hidden when the flag is off.
- Extraction requirement: PDF and DOCX text extraction must keep line breaks (one `\n` per text line or paragraph); the matcher caps each line at 2000 characters, so a text blob with no line breaks would be mostly ignored. Add a test with a multi-line fixture.
- Accept: screenshot of each step in the PR; real chunk sizes reported; nothing in web storage after the CV steps.

## Risks and needs check
- **Licences:** pdf.js Apache-2.0 and fflate MIT are permissive (needs check at the pinned version's `LICENSE`; add to third-party notices).
- **Bundle size** of pdf.js worker: measured in WP-C, about 1.81 MB lazy (see section 3); the revised 1.85 MB budget needs the owner's approval.
- **pdf.js security:** keep `isEvalSupported: false`, pin ≥ 4.2.67, Dependabot on.
- **Scanned PDFs:** no text layer → fewer than ~100 characters per page triggers "This looks like a scanned PDF; paste the text instead". No OCR in v1 (tesseract.js is large; deferred).
- **Other PDF edge cases:** password-protected (pdf.js `PasswordException` → message), multi-column layouts (text order interleaves; bag-of-words skills still match, title↔date pairing may fail, so years are suggestions), ligatures/odd encodings (NFKC helps; needs check on real exports from Word, Google Docs, Canva).
- **Browser support:** whether `pdfjs-dist` at the pinned version runs on the PWA's target browsers (including older iOS Safari) is **needs check**; WP-C tests on the supported browser list and, if a browser fails, shows the paste-text fallback instead of the file picker. Open question: the **modern (non-legacy)** pdf.js build is about 120 KB smaller (459 kB main + 1,264 kB worker for 6.4.299). WP-C uses the legacy build to be safe on older browsers; switch if the supported-browser list allows (**needs check**).
- **Hebrew / RTL:** supported = English CVs. A Hebrew CV is read, but `skills.json` keywords are English, so only Latin-script terms (Excel, SQL, Jira, degree abbreviations) are found; Hebrew words are ignored. Some PDFs store Hebrew in visual order, which can reverse words in extraction (needs check). Hebrew keyword aliases (e.g. degree terms) are a later taxonomy change, not v1. Review UI uses `dir="auto"`.
- **False positives** from generic keywords (`scope`, `scheduling`, `communication`): handled by the weak-hit rule and the review screen; tune with fixtures.
- **CV matcher known limits (WP-A):** 7-digit local phone numbers without a prefix and handles written without a URL or `@` may survive in an evidence snippet (`redactPii` limits); a sentence of the CV can appear in evidence, cut to at most 80 characters (the import payload never carries evidence); Hebrew keywords are not matched (only Latin terms; Hebrew letters stuck to a Latin term are split off, and a few Hebrew section headings are known); lines are capped at 2000 characters before any regex runs, and when a line is cut the last words are dropped so a cut email or phone number cannot leave a fragment; a `Contact` / `Personal details` section after the first heading is dropped like the block before the first heading; a title takes the next line's date range only when that line holds nothing but dates.
- **Personal data in titles:** a role title can name an employer; titles are user-reviewed, length-capped, PII-checked by the API, and never sent to AI.
- **Spec conflict:** 12.3 says "parsed in the backend"; this record changes it (owner approved 2026-11-08; edit applied above). Privacy policy draft must be updated before release.
- **Tier of `user_profiles`** in the admin console (3.B) needs owner confirmation.
