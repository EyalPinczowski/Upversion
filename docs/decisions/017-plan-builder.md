# 017 – Plan builder v1: a rule-based plan from profile, target role, time and deadline

**Status:** Proposed (awaiting the owner's decisions in section 9)

Builds on ADR 001 (pure scheduling), 004 (AI optional, rule-based builder is the default), 007 (catalog-grounded generation), 012 (`AIProvider`), 015 (setup answers, `user_profiles`, CV import) and 016 (Change my CV, `matchSkillsInText`, `keywordGaps`). Implements the core of spec 3.0 ("Plan builder – from goal to plan"). Read on `rnd` at `c9b4f21` (2026-11-12).

## Context
- Spec 3.0 describes the full builder: a 28-question intake, RAG retrieval, an AI that chooses and orders catalog items, "Make this plan free", regenerate, conversational mode, user-added catalog items. None of it is built. Plans today come only from `POST /api/v1/plans/import` (a hand-made plan file, like the owner's own plan and `data/sample-plans/demo-plan.json`).
- What already exists and is reused: setup answers and `profile.skills` with `source` (`cv`/`setup`/`manual`) in `user_profiles` (ADR 015); `matchSkillsInText` for a pasted job post (ADR 016 §5); the plan file format (`PlanFileSchema`, `parsePlanFile`), `TaskSourceSchema` already has `builder`, `plans.created_from` already allows `builder`; the scheduling engine `schedule()` and `dayCapacity()`; the demo plan's conventions (`externalRef: "catalog:<id>"`, no `url` and a "Needs check" note when a link or price is not verified, exam split into prep + exam block, admin tasks for booking).
- The catalog lives only as bundled JSON (`data/catalog/*.json`; `schema.sql` is a reference, no catalog migration exists). `roles.json` has weighted skills (1–5) and `suggested_path` (`core`/`optional`/`practice`/`free_only`) per role.

## Options
1. **Spec 3.0 in full, AI first** (RAG + model orders the plan, rules as fallback). Needs embeddings, a catalog in the database and a new AI purpose; large, and the AI-off path would be the second-class one.
2. **Deterministic builder first, AI only for explanation text, behind a flag.** The same pure function runs with AI on or off; the plan is always identical for identical inputs.
3. **Web-only builder** that produces a plan file and posts it to `/plans/import`. Breaks spec 12.3 ("no business logic in the frontend") and spec 3.0 ("cost is recalculated by the backend").

## Decision
Option 2. A pure shared function `buildPlan(input, catalog)` makes the draft; the API runs it (preview, then create on confirm); the web only renders and collects choices. AI never chooses, adds, orders or prices items. The parts of 3.0 not in this record (RAG, catalog in the database, user-added catalog items, conversational intake, "regenerate with an instruction", quick check, "Make this plan free" side-by-side) stay for later records; none is a 12.1 deferred feature, so this is ordering, not a scope change.

### 1. Inputs and UX
**Where:** a new page `/plan/new` ("Build a plan"), shown only when `features.planBuilder` is true. Entries: the no-plan state of the Plan page (next to "Import a plan file"), a "Build a new plan" button on the Plan page, and the setup Done step ("Build my first plan"). Blocks design, no gradients, no nested cards, no decorative emoji; usable at 360 px; axe clean.

**Steps** (progress "Step n of 5", Back on every step, answers kept in component state; not saved to the server until step 5):
1. **Target.** Role picker from `roles.json` (1–2, pre-filled from `profile.answers.target_role`) and extra skills from `skills.json` (≤ 10, pre-filled from `target_skills`). Optional "Paste a job post": matched **in the browser** with `matchSkillsInText`; detected skills are shown as checkboxes for confirmation; only the confirmed skill ids are sent. The post text is never sent or stored.
2. **Your skills.** The `skill_levels` matrix (scale from `questions.json`) for the union of the target role skills and extra skills. Pre-filled from `profile.skills` (each row shows its source: "from your CV", "from setup", "you set this"); unknown rows start at "Never used" and are labelled "not rated". A link "Change my CV" (ADR 016 §1, `/settings/cv`) returns here. Edits here are used for this plan only; a checkbox "Also save these levels to my profile" (default off) saves them with `source: 'manual'` through the existing profile API.
3. **Time.** Start date (default: tomorrow), deadline (date, or weeks; default from `timeframe.default_weeks` = 4), study days and hours per day (pre-filled from `days_per_week` / `hours_per_day`), window from `time_of_day` (mapping in WP-1), time zone from the browser. Live line: "about N study hours until the deadline".
4. **Budget and certificates.** `budget` (free / limit / flexible, USD only in v1: every catalog price is USD), `max_item_price`, `certificates` (must / nice / none), `interview_prep` (yes / later / no). All rendered from `questions.json`, never hard-coded.
5. **Draft review** (the "Here's what I understood" summary plus the draft). Top summary: total hours vs capacity, projected finish date, cost vs limit (with "+ prices to check"), certificates, skills covered vs asked, and gaps the catalog cannot fill. Then the item list (core, then optional), each with hours, cost, a "why this is here" line, badges ("Needs check: link", "Needs check: price", "Price varies – check") and controls: remove, core/optional, and for exams "Include this exam" (opt-in). A "Certificates you can add" list shows the matching exams not included. Every change re-runs the preview. **"Start this plan"** creates it; nothing is created before that (spec 3.0 step 3, 12.2).

### 2. Algorithm (`buildPlan`, pure, deterministic, no I/O, no `Date.now()`)
Inputs: `BuildRequest` (section 4) + the bundled catalog + `today`. Output: `BuildDraft` = a valid `PlanFile` plus per-item metadata, summary and warnings.

1. **Targets.** For each target role skill: `need = 2` (Comfortable) if weight ≥ 4, else `1`; extra skills: `need = 2`. `gap = max(0, need − level)`; `priority = weight × gap` (extra skills weight 4). Skills with `gap = 0` are listed as "already covered".
2. **Eligible items.** Catalog items of type `course` or `cert_exam` that teach a gap skill, with a non-null `url` (items with `url: null` are never chosen, as `build.py` already does for role paths). Budget filter: `free` → `cost_type` `free` or `free_audit` (certificate not bought); `limit` → known price ≤ `max_item_price`; `price: null` excluded unless `flexible` (then shown as "Price varies – check"). Items in the request's `exclude` list are dropped.
3. **Selection (greedy set cover).** Score each eligible item: Σ priority of the uncovered gap skills it teaches + 3 if in a target role's `suggested_path.core` (or `free_only` when budget is free) + 1 if `url_verified` − 1 if `level` is `beginner` and the user's level on all its skills is ≥ 1 (and an `intermediate` item covers the same skills). Pick the highest, mark its skills covered, repeat until every gap skill is covered or no item helps. Ties break by catalog id. `cert_exam` items are not chosen here (step 5). `mustInclude` ids are added first.
4. **Prerequisites.** Add every transitive `required` prerequisite, except one whose skills the user rated ≥ 2 (listed as "skipped: you rated X Comfortable"). `recommended` edges only order items already in the plan.
5. **Certificates.** Candidate exams = `cert_exam` items teaching a target skill, within budget. `must` → the best-scoring candidate per target role is included and the rest offered; `nice` → none included, all offered; `none` → none offered. The user's opt-ins (`certificateOptIns`) are included. An included exam becomes **two tasks**: "Prepare for X" (`course`, splittable, `est_hours − examHours`) and "X – exam" (`cert_exam`, `splittable: false`, `isCertificate`, `examHours` from the catalog, see section 5) plus "Book the X exam" (`admin`, 0.25 h, before the prep ends). An exam date from `examDates` makes the exam an anchor (`isAnchor`, `anchorDate`, `anchorStartTime`).
6. **Practice.** `interview_prep` yes/later → the target role's `suggested_path.practice` items (≤ 4); "later" makes them depend on the last course. Practice for a skill always comes after the learning items for that skill (learn-before-practice, README "Structure fields").
7. **Admin.** "Set up learning accounts" (0.5 h, first) and a "Weekly review" (0.5 h) after roughly every week of planned hours. Fixed template text, no catalog link. **No `cv_update` tasks:** the tasks module creates them when a certificate is completed (spec 3.6).
8. **Order.** Topological sort over prerequisite and learn-before-practice edges; ties by core before optional, then priority, then catalog id. `order` = position; `dependsOn` = prerequisite, booking and practice edges only (so the engine can interleave).
9. **Fit.** `capacityHours` = Σ `dayCapacity` from start to deadline (pattern, no calendar busy time: the calendar is applied after creation as today). If core hours > capacity: drop optional items (lowest priority first) and report; if still over, return `fits: false` with the three spec options computed: "finish on <date>" (from `schedule()` with no deadline), "study <h> hours a day", "keep only the essentials" (drop lowest-priority core items until it fits, listing the skills lost). The builder never applies one silently. Then run `schedule()` on the draft for `finishDate` and engine warnings.
10. **Cost.** One-time prices summed; a `subscription_group` is paid once per month it is used (months = ceil(days between the group's first and last scheduled block / 30), at least 1); a subscription without a group counts its own period; `free_audit` costs 0 (its `certificate_price` only if the user opts into the certificate). `price: null` is not added; the summary says "+ N prices to check". Any item with `price_verified: false` makes the total "estimated". Over the limit: swap a paid item for its first `free_alternative_ids` entry that teaches the same gap skills, else drop optional, else report `overBudget` (never silently exceed).
11. **Task mapping.** id `c-<catalogId>` (`p-`/`x-`/`b-` for prep/exam/booking, `a-<kind>-<n>` for admin); title, provider from the catalog; **`url` only when `url_verified: true`**; `externalRef: "catalog:<id>"`; `source: 'builder'`; `isCertificate` and `certificateName` when `certificate_type` is not `none`; `notes` = generated "why" line + "Needs check: link not yet verified…" / "Needs check: price not verified." / "Price per catalog: N USD (prices change; re-check before paying)" only when `price_verified`. Plan `name` = "<role title> plan" (catalog text only); `skillIds` = target skill ids (feeds the briefing's podcast pick); `endDate` = deadline.
12. **"Why this is here" (template).** e.g. "Teaches SQL and Excel – the role weights them 4–5 and you rated them Basic." / "Required before PL-300." / "Practice for interviews (you asked for interview prep)." Built from ids, names and numbers only.

### 3. Optional AI (explanation text only)
- Off unless `FEATURE_PLAN_BUILDER_AI` is on and a free provider is available. It may only rewrite the "why" lines and add a 2-sentence plan overview. Input: role title, skill names with levels and weights, item titles and providers, hours. **Never** sent: names, CV text, role titles the user typed (`rolesHeld.title`), job post text, or any free-text answer. It passes through `buildSafeRequest` (redact + assert).
- The output replaces text only; item ids, order, hours, cost and links always come from `buildPlan`. Output that names an item, number or skill not in the input is discarded (template kept). Cached by input hash; per-user daily cap.
- Needs a new AI purpose `plan_explain` (migration widening `ai_usage_daily_purpose_check`, as 0017 did). **Recommended: not in v1** (section 9, Q1); the builder is complete without it.

### 4. API (`apps/api/src/modules/plan-builder`, flag `FEATURE_PLAN_BUILDER`, default off; off → 404)
Two new endpoints; the write reuses the import service rather than `/plans/import`, so the server — not the client — decides the tasks, links and cost.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/v1/plans/build/preview` | `BuildRequest` | 200 `BuildDraft` (plan file, items with flags/cost/why, summary, warnings, `draftHash`). **Saves nothing.** 400 strict schema, 422 unknown role/skill/catalog id or deadline ≤ start |
| POST | `/api/v1/plans/build` | `{ id: uuid, request: BuildRequest, draftHash }` | Re-runs `buildPlan`; if its hash ≠ `draftHash` → 409 `draft_changed` (catalog or inputs changed; the web re-previews). Else writes through the import service with `created_from = 'builder'`, status `active`, and `summary.targetRoleIds` + `summary.builderVersion`. Same `id` + same content → 200; different → 409 (import rules) |

`BuildRequest` (shared zod, `.strict()`; **no free text at all**, so no PII can enter): `targetRoleIds` (1–2), `extraSkillIds` (≤ 10), `skillLevels: Record<skillId, 0..3>` (≤ 60), `startDate`, `deadline`, `weekPattern` (`WeekPatternSchema`), `budget {mode, maxItemPrice?}`, `certPreference`, `interviewPrep`, `certificateOptIns` (≤ 10 catalog ids), `examDates` (≤ 10 `{catalogId, date, start}`), `mustInclude` / `exclude` (≤ 30 catalog ids each), `priorityOverrides: Record<catalogId, 'core'|'optional'>`. No `userId`; the user is `request.accountId`. Terms guard, rate limit as other writes. `docs/api-plan-builder.md` + regenerated OpenAPI and web client.

Why not plain `/plans/import`: it would let the web assemble tasks and prices (spec 12.3 forbids business logic in the frontend; spec 3.0 wants cost recalculated by the backend) and would record `created_from = 'import'`.

### 5. Data needs and catalog gaps (measured on `rnd`, 2026-11-12)
| Gap | Effect | Proposal |
|---|---|---|
| No exam duration field; `cert_exam.est_hours` mixes prep and exam (e.g. `capm` 60 h); durations exist only in `notes` ("70 minutes") | A 60 h non-splittable task cannot be placed | Add `exam_minutes` (optional) in `build/catalog.py`, filled only from the official page; until set, the exam block defaults to 2 h with "Needs check: exam length". Catalog WP-0 |
| 50 of 178 items `url_verified: false`; 104 `price_verified: false`; 31 `url: null`; 15 `price: null` | Many drafts carry "needs check" | Shown as such, never as verified; `url: null` never chosen |
| Only 18 items have `free_alternative_ids`; 45 paid items have none | Budget swaps often impossible | Say "no free equivalent in the catalog"; extending the data is a catalog task |
| `interviewing` is taught by no course (practice templates only); 12 role skills have no free item with a link (e.g. `git`, `software-testing`, `ux-basics`, `windows-m365-admin`); 10 skills have ≤ 1 item | Free-only plans leave gaps | Listed as "gaps the catalog cannot fill", never padded with invented items |
| `skill_depth` is empty everywhere; 33 items `level: unspecified` | Level matching is coarse (unspecified = beginner) | Accept for v1 |
| Thin roles: Bookkeeper (3 core), Technical Writer (3), L&D Coordinator (2 core, **0 free-only**) | Short or empty free plans | Warning on the draft; catalog extension later |
| One subscription has no price and no period; one is yearly without a group | Cost rule edge cases | Unit tests cover both; shown as "check price" |
| Catalog is bundled JSON, not in the database | No user-added items, no link-check flags at run time | v1 reads the bundled catalog in `packages/shared` (as roles/skills already are); DB catalog is a later record (Q4) |
| Hour estimates are approximate (README) | Fit is an estimate | The draft says "estimates"; recalibration is spec 3.4 |

**Discrepancies found while reading (not fixed here, flagged for the owner):** (a) `demo-plan.json` task `pl300-exam` says "Exam fee per catalog: 165 USD", but `catalog.json` has `pl-300` `price: null`, `price_verified: false`; the demo note should say "check price" (catalog WP-0 can fix it). (b) Spec 3.0 says the seed catalog has "121 items"; `data/catalog/README.md` and `catalog.json` have 178. (c) Spec 3.0 says "one plan is active at a time", but import creates `active` plans and nothing archives the previous one (Q3).

### 6. Work packages (Sonnet builders, isolated worktrees, PRs into `rnd`)
Order: **WP-0 ∥ WP-1 → WP-2 → WP-3**; WP-4 only if Q1 = yes. WP-3 can start against a mocked client once WP-1 merges (the `BuildDraft` type is shared).

**WP-0 – catalog: exam length** (`feature/catalog-exam-minutes`, small)
- Files: `data/catalog/build/catalog.py` (optional `exam_minutes` on `cert_exam` items, only where the official page states it, otherwise absent), `lint.py` (+ `test_lint.py`: positive int, only on `cert_exam`), regenerated files via `build.py` (from `build/`), README "Structure fields" row; fix the demo-plan PL-300 fee note.
- Accept: CI drift check green; no value without a source; unverified durations stay absent.

**WP-1 – shared: `buildPlan` and schemas** (`feature/shared-plan-builder`)
- Files: `packages/shared/src/plan-builder/{schemas.ts,catalog.ts,targets.ts,select.ts,order.ts,fit.ts,cost.ts,tasks.ts,why.ts,build.ts,prefill.ts}` + tests; exports from `index.ts`. `catalog.ts` loads `catalog.json` typed (bundled, `sideEffects: false` kept). `prefill.ts`: `prefillFromProfile(profile, questions)` → partial `BuildRequest` (target roles/skills, levels with source, week pattern from the setup answers and the `time_of_day` → window map: morning 08:00–12:00, afternoon 12:00–17:00, evening 18:00–22:00, flexible 09:00–17:30, **owner to confirm**).
- Tests (fictional inputs only): every chosen task with a `url` has a `url_verified` catalog item and every `url_verified: false` item has no `url` and a "Needs check" note (property test over all 27 roles × 3 budgets); `parsePlanFile(buildPlan(...).plan)` succeeds and `schedule()` runs on it for every role; determinism (same input twice → deep-equal, and shuffled catalog order → same output); prerequisites always before dependents, required prerequisite closure, rated-≥2 skip; `free` budget never contains `one_time`/`subscription` items or paid certificates; `limit` never exceeds the cap with known prices, `price: null` excluded; Coursera Plus counted once per month for 3 items over 6 weeks (= 2 months); `free_audit` certificate price only on opt-in; no `cv_update` tasks; exam split into prep/exam/booking, exam `splittable: false`, anchor only with a date; fit: over capacity → optional dropped first, then `fits: false` with three options and correct numbers; gaps listed for a free-only Technical Writer plan; no task, note or name contains text that is not from the catalog or the fixed templates; `BuildRequest` rejects unknown keys and any string outside an id/date/time pattern; 50 ms for the largest role.
- Accept: pure (no I/O, no clock), no new runtime dependency, existing shared tests unchanged.

**WP-2 – API** (`feature/api-plan-builder`, depends on WP-1)
- Files: `apps/api/src/features.ts` (`FEATURE_PLAN_BUILDER`, default false; `planBuilder` in `/features`), `apps/api/src/modules/plan-builder/{routes.ts,service.ts}`, a small change in `modules/plans/import.ts`/`repository.ts` so the import service takes `createdFrom` (default `'import'`; `/plans/import` unchanged), summary fields `targetRoleIds`, `builderVersion`; `.env.example` (name only); OpenAPI + `apps/web/src/api/schema.d.ts`; `docs/api-plan-builder.md`. No migration (`created_from` already allows `builder`; summary is jsonb).
- Tests (real Postgres): flag off → 404 for both; Terms guard; strict body (unknown key, `userId`, free text) → 400; unknown ids → 422; preview writes nothing (row counts unchanged); build writes one plan with `created_from = 'builder'`, tasks `source = 'builder'`, `plan.imported` event; idempotent retry → 200, same id other content → 409; stale `draftHash` → 409 `draft_changed` and nothing written; RLS: another user cannot read the plan; cost and hours in the response come from the catalog even if the body carries other numbers (it cannot: strict schema).
- Accept: API never reads a user id from input; `/plans/import` behaviour and tests unchanged.

**WP-3 – web** (`feature/web-plan-builder`, depends on WP-2 for the client)
- Files: `apps/web/src/pages/plan-builder/{PlanBuilderPage.tsx,TargetStep.tsx,SkillsStep.tsx,TimeStep.tsx,BudgetStep.tsx,DraftStep.tsx}` + tests, route `/plan/new`, entries (Plan page empty state and header, setup Done step), hooks for preview/build.
- Tests: hidden and unreachable with the flag off; pre-fill from a mocked profile (levels show their source); a pasted job post is never in any request (canary test on the mocked client) and only confirmed skill ids are sent; "needs check" badges render for unverified items and no unverified item renders a link; nothing is created before "Start this plan" (zero calls to the build endpoint until then); `draft_changed` → re-preview with a message; `fits: false` shows the three options; axe clean; 360 px.
- Accept: screenshots of the 5 steps and of a free-only plan with gaps; no business logic in the web beyond rendering and collecting choices.

**WP-4 – optional AI explanations** (only if Q1 = yes; after WP-3): purpose `plan_explain`, migration (additive, `rnd` then `prod`), `FEATURE_PLAN_BUILDER_AI`, gateway call with the input allowlist of section 3, output check (unknown names/numbers → template kept), a canary test that no profile field other than the allowlist reaches the provider fetch, cap and cache.

### 7. Risks
- **Bad advice from thin data:** a rule-based plan can look authoritative. Mitigation: "estimates", "needs check" badges, explicit gaps, and the draft is always reviewed before creation.
- **Over-trust in levels from the CV matcher** (ADR 015 never sets 3, never 0). Mitigation: step 2 shows the source of every level and lets the user change it.
- **Cost surprises** with subscriptions and unverified prices. Mitigation: "estimated" label, per-item price status, subscription months shown.
- **Catalog drift between preview and create.** Mitigation: `draftHash` → 409 → re-preview.
- **Two active plans** (Q3). **Bundle size:** `catalog.json` (~178 items) in the API is fine; the web must not import the catalog module eagerly (lazy route chunk, measured in WP-3).

### 8. Spec edits (applied only after approval)
- 3.0 "How the plan is generated": v1 is the rule-based builder; AI only rewrites explanation text (ADR 017). RAG and AI selection move to a later record.
- 3.0 catalog: "121 items" → "178 items"; v1 reads the bundled catalog; the database catalog and "Added by me" items come later.
- 8 Screens: add `/plan/new`. 12.3 feature flags: add `features.planBuilder`.

### 9. Open questions for the owner (recommended default first)
1. **AI explanations in v1?** (a) No, templates only; WP-4 later — *recommended*. (b) Yes, WP-4 in this phase (needs the `plan_explain` migration and a share of the free quota).
2. **Where it starts:** (a) `/plan/new` with entries on the Plan page and the setup Done step — *recommended*. (b) Also a home-screen card.
3. **Existing active plan when a new one starts:** (a) keep both active, the plan switcher shows both (today's import behaviour) — *recommended for v1*. (b) Archive the old one on "Start this plan" (needs a status endpoint and a confirm dialog). (c) Create the new plan as a draft and add an "Activate" action.
4. **Catalog source:** (a) bundled `catalog.json` in v1, database catalog later — *recommended*. (b) Migrate the catalog into the database now (spec 3.0 says "stored in the database and editable"; larger scope, needs seed and RLS work).
5. **Certificates default when "Nice to have":** (a) offered, not included — *recommended*. (b) Include the best one by default.
6. **Prerequisite skip:** (a) skip a required prerequisite when the user rated its skills Comfortable, and say so — *recommended*. (b) Always include required prerequisites.
7. **Target level per skill:** (a) Comfortable for role weight ≥ 4, Basic otherwise — *recommended*. (b) Comfortable for every role skill (longer plans).
8. **Unverified items:** (a) may be chosen, shown without a link and with "needs check" — *recommended* (otherwise many roles lose core items). (b) Only `url_verified: true` items are chosen.
9. **`time_of_day` windows:** confirm the four windows in WP-1 (morning 08–12, afternoon 12–17, evening 18–22, flexible 09:00–17:30).
10. **Save edited skill levels to the profile:** (a) only when the user ticks the box (default off) — *recommended*. (b) Always.
11. **WP-0 exam length:** (a) add `exam_minutes` from official pages; 2 h default with "needs check" until set — *recommended*. (b) No data change; every exam block is 2 h with "needs check".

## Consequences
- Every plan the builder makes is reproducible from its inputs and the catalog version, works with AI off, and holds only catalog links (verified ones) or none.
- The plans module gains one small seam (`createdFrom` on the import service); no migration in v1.
- Catalog quality becomes visible to users (badges, gaps); extending the catalog is the main lever for better plans.
