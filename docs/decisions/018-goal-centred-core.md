# 018 – Goal-centred core: goal strip, Goal screen, a 4-screen first run

**Status:** Accepted (owner, 2026-11-14): Phase B, "plan coverage" wording, suggested-only level updates, AI explanations off by default, no release yet, the process changes, and the answers to Q1–Q3 (section 9). Read on `rnd` at `02bd0f9`; PR #118 merged since. Input: an independent review of the whole project (2026-11-14); its claims used here were checked against the repo, and the rest is marked **needs check**.

## 1. Context
- The goal is "skills tied to what I want to become" (spec 1), but after "Start this plan" the app shows tasks and hours, not progress towards the role. The data exists: builder tasks carry `externalRef: "catalog:<id>"`, catalog items list `skills`, `roles.json` weights each role's skills (values used: 2–5), `user_profiles.skills` holds starting levels with a `source`, practice sessions have a 0–10 `score`.
- Gaps (checked): `skill_depth` is empty on 178 of 178 catalog items; imported plans (the owner's real plan) carry no per-task skill link; `plans.summary` (jsonb, written once at insert) already holds `skillIds` (plan file) and, for builder plans, `targetRoleIds` and `builderVersion`, but no starting levels.
- First run today: welcome dialog and tour, 8 setup questions, CV, calendar, then the 5-step builder (ADR 015, 017): about 15 screens before any value.
- Plan builder state: shared (#116) and API (#117) are on `rnd`; the web (#118) is merged; the optional AI explanations (PR #119) are open. The owner considers #119 finished: it ships with `FEATURE_PLAN_BUILDER_AI` **off** by default.

## 2. Decision (owner, 2026-11-14)
1. **No release of `rnd` to `main` yet**; keep building. The reviewer recommended releasing first: `rnd` is 85 commits and 17 migrations (0002–0018) ahead of `main` (v0.0), so the first release grows riskier as Phase B lands. Recorded as a risk with a standing "release readiness" item (section 7); it does not override the owner.
2. **Plan builder AI explanations** are done and ship off by default.
3. **Phase B = this redesign.** Five destinations: **Today · Week · Plan · Goal · Settings**. A 4-screen first run replaces the welcome tour and the long setup. CV tailoring stays behind `FEATURE_CV_TAILOR` with no navigation entry.
4. **Wording:** the number is **"plan coverage"** (share of this plan's work for the goal that is done), never "readiness" or "qualified".
5. **Levels:** the app only **suggests** a level update; the user approves it (spec 12.2: suggestions, never self-marking).
6. **Process:** three review tiers by risk, one-page ADRs with at most three owner questions, e2e required in CI (CLAUDE.md "Process").

## 3. Target design
**Core loop:** goal (roles + skills + starting levels) → gap → plan → Today → evidence (hours, finished items, practice scores, certificates) → Goal screen → suggested level update or plan change, approved by the user → back to the plan.

**First run (after sign-in and Terms; questions come from `questions.json`, never hard-coded):**
1. "What are you aiming for?" `target_role` (1–2), `target_skills`; optional job-post match in the browser (ADR 016).
2. "Where are you now?" `skill_levels` for those skills only; link "Pre-fill from my CV" (in-browser import, ADR 015).
3. "How much time and money?" `days_per_week`, `hours_per_day`, deadline (`timeframe`), `budget`.
4. Draft plan (the builder's draft step, ADR 017 §1.5): fit, cost, skills covered, "Start this plan".
Certificates and interview prep use the builder defaults and can be changed on step 4. Answers are saved to the profile; levels the user sets are saved with `source: 'manual'`.
This replaces spec 3.0 Step 1 (28 questions in 7 stages) for the first run: "Not sure" on step 1 opens the role-discovery questions (`discover_enjoy`, `discover_style`, `discover_pick`) on the same screen and suggests 3–4 roles from `roles.json`; follow-up questions appear on step 4 as the draft's fit and budget messages with their options (extend, add time, drop optional items); the "Here's what I understood" summary is the top of step 4, each line editable. The other intake questions are not asked; the builder uses its defaults.

```
TODAY                                          GOAL
+--------------------------------------------+ +----------------------------------------------+
| Product Operations · ends 14 Feb   [Goal >]| | Product Operations       [Change] [Rebuild]  |
| Plan coverage ████████░░░░ 41%             | | Plan coverage 41% · 38 of 92 h · 1 of 2 certs|
+--------------------------------------------+ +----------------------------------------------+
| Today 3.0 h planned · 1.0 h done   [Start] | | Skill (weight)  Start  Evidence     Left     |
| 09:00 SQL basics 3   1.5 h   builds: SQL   | | SQL (5)         Basic  12 of 15 h   1 item   |
| 11:00 Stakeholder    1.0 h   builds: Comm. | |   practice avg 7.5 (3)  [Suggest: Comfortable]|
| [Connect your calendar]  (card, dismiss)   | | Excel (5)       Comf.  already covered       |
| 1 suggestion waiting  [Review] [End day]   | | 12 h not linked to a skill                   |
+--------------------------------------------+ | Practice score trend (was Practice history)  |
                                               +----------------------------------------------+
```
First-run steps 1–3 are one question group per screen with "Step n of 4" and Back; step 4 is the existing draft view.

**Data (no new table):**
- **Goal on the plan:** a `goal` object `{ targetRoleIds, skillIds, startLevels: {skillId: 0..3} }`, ids and numbers only, written when a plan is created (builder or import), inside the existing `plans.summary` jsonb (Q1; no migration). As built in B1 the goal also has two optional fields, `deadline` (a date) and `createdFrom` (`builder`, `import` or `manual`); `startLevels` keys must be in `skillIds`. This differs from spec 4, which has a separate `Goal` entity (`id, plan_id, goal_text, target_skills [{skill, current_level}]`, …) and `Plan.goal_id`; spec 4 is edited to match (section 8).
- **Plan file:** optional per-task `skillIds` (taxonomy ids, validated like the plan-level `skillIds`). `formatVersion` stays `1`; old files parse unchanged. B1 only checks the id pattern; **B2 adds taxonomy validation of task skill ids on import and an additive migration `tasks.skill_ids text[]`** (owner approved), so the column keeps what the plan file carries.
- **`skillProgress(tasks, catalog, goal, practiceScores)`** in `packages/shared`: pure, no I/O. A task's skills are its `skillIds`, else its catalog item's `skills`; its hours split evenly across those skills that are in the goal (no `skill_depth` exists). Per skill: planned hours, done hours (capped at estimate), items left, practice average. Plan coverage = done ÷ planned hours over goal-linked tasks. Unlinked hours are reported, never hidden.
- **Level suggestion:** derived by `skillProgress` under the rule of Q3; approving it writes one profile skill (`source: 'manual'`).

## 4. Keep, park, remove
- **Keep:** the engine, builder, daily loop, Week, Plan, briefing ("Start study day"), "Change my CV" (Settings > Profile), in-browser CV import (as step 2's pre-fill).
- **Move:** the other setup questions (`current_status`, `education`, `tools_known`, `time_of_day`) to Settings > Profile as optional (`setup` flags in `questions.py`, then `build.py`); calendar connect to a dismissible card on Today after a plan starts (hidden when `FEATURE_CALENDAR` is off or connected); Practice history into Goal (`/practice-history` redirects to `/goal`).
- **Park:** CV tailoring (flag, no navigation entry).
- **Remove (B5):** the welcome dialog and tour (`components/welcome/`, issue #97), the old setup wizard pages once the first run is on in `rnd`.

## 5. Phases (Sonnet builders, one worktree each, PRs into `rnd`; flag `FEATURE_GOAL_CORE`, default off)
| Phase | Scope | Size | Tier | Exit criteria |
|---|---|---|---|---|
| B1 data + shared | `goal` shape and schema, per-task `skillIds` in `PlanFileSchema`, `skillProgress` + level-suggestion rule, property tests | M | 2 | Same input, same output; hours conserved; coverage in 0–100; a fixture plan's table shown to the owner before B4 |
| B2 API | write `goal` on build and import; import archives the active plan (Q2); `GET /api/v1/plans/{id}/progress`; approve a level suggestion; OpenAPI and client regenerated | M | 1 (routes on user-owned data, the archive path) | Route tests incl. another user's plan → 404; canary: `goal` holds ids and numbers only |
| B3 web first run | 4 screens, answers and levels saved, redirect for users with no plan | M | 2 | e2e: sign-in to "Start this plan" in 4 screens; axe clean; 360 px |
| B4 web Today + Goal | goal strip, "builds:" tags, calendar card, Goal screen, fifth nav item | M | 2; a PR that changes calendar code is Tier 1 | e2e: log work, Goal shows it; "readiness" appears nowhere in copy |
| B5 clean-up | remove tour and old setup, move questions to Settings, the spec and ADR 017 edits of section 8 | S | 2 | No dead routes; questions still from `questions.json`; drift check green |

## 6. Tests and acceptance
- Property tests for `skillProgress`; unit tests for the suggestion rule (never above level 2, never for a skill without evidence).
- e2e (required): first run → "Start this plan"; plan builder draft → start; Goal after logging work; calendar connect and sync against a fake Google (its own PR, Tier 1).
- A plan without a goal (all existing plans) shows Today as now, with a "Set a goal" link; nothing breaks.

## 7. Risks and needs check
- **Release gap (owner chose to keep building).** Release readiness, kept in the roadmap: a CI job that applies all `rnd` migrations on top of `main`'s level, a release checklist of about ten lines, a smoke session on real services, a restore drill, and the privacy-policy truth pass. Not started until the owner asks.
- Coverage as a vanity number: the B1 fixture table is shown to the owner first. Even split may mislead: compare with hand-set depth for one role before B4.
- A shorter first run may give worse plans: diff builder drafts for five roles with and without the dropped answers.
- **Needs check:** the builder's default window when `time_of_day` is unanswered; whether config can point the Google provider's base URLs (`google-provider.ts` takes them as parameters) at a fake only in the e2e stack; flakiness of `e2e` once it is required (watch it; a flaky test is fixed or quarantined in its own PR, never skipped silently); 50 of 178 links and 104 of 178 prices are unverified, so drafts stay honest but thin for some roles.

## 8. Spec and ADR edits (to do, in the PR that builds each part)
- Spec 3.0: Step 0 (setup) and Step 1 (intake) replaced for the first run by section 3; "Multiple plans": import also archives the active plan after the confirm (Q2). ADR 017 §4.1 gets the same note.
- Spec 3.1 (goal strip), 4 (`Goal` entity and `Plan.goal_id` replaced by `plans.summary.goal`), 8 (Goal screen; Practice history merged), 9 (new acceptance tests).

## 9. Owner questions (answered, owner, 2026-11-14)
- **Q1 Where the goal is stored:** a `goal` key inside the existing `plans.summary` jsonb (no migration, already under RLS).
- **Q2 One active plan for imports too:** yes. "Import a plan file" also archives the active plan, with the same confirm dialog as the builder, so the goal strip and calendar never pick between plans.
- **Q3 When to suggest a level update:** when every task that builds that skill is done, suggest one level up, never above level 2 ("comfortable"); practice scores are evidence only; the user approves each change.

## Consequences
The Goal screen and goal strip make the stated goal visible with no AI and no new table. The first run shrinks from about 15 screens to 4 after sign-in. Phase B adds one flag and removes the tour and old setup at its end. The release risk grows until the owner releases.

## As built: B2 (API)
- Migration `0020_task_skill_ids.sql`: `tasks.skill_ids text[]`, nullable, at most 10 ids; NULL = unknown (fall back to the catalog item), `[]` = builds no skill. RLS unchanged.
- Import validates per-task `skillIds` against the taxonomy and **rejects** unknown ids with 422 (`tasks.N.skillIds.M`), the same as plan-level ones; repeats are dropped. Builder tasks store the catalog item's skills, booking tasks `[]`.
- Import also archives the active plans (Q2): the import body takes `replacesPlanIds` (optional, default none), compared with the active set after the lock and the idempotency check, 409 `active_plan_changed` otherwise; a `draft` import archives nothing. The archive step is shared with the builder (`plans/replace.ts`). Existing clients that import while a plan is active now get 409 until the web sends the confirm.
- The goal is written to `plans.summary.goal` on build (roles, extra skills, `skillLevels`, deadline) and on import (plan-level skill ids, else the tasks' skills; no start levels). Readers use `deriveGoal` for older plans.
- Routes (flag-independent): `GET /api/v1/plans/{id}/goal-progress` and `POST /api/v1/me/level-ups/approve` (docs/api-goal-progress.md). The path differs from section 5, which said `/plans/{id}/progress` (that path already exists for the day schedule). Approve is refused for an archived plan.
- Spec 3.0/3.1/4/8/9 and ADR 017 section 4.1 edits stay in B5, as the phase table says.
- Open point for the owner: after an approval from 0 to 1 the rule offers 1 to 2 at once while all tasks stay done (B1 rule, Q3 text). Consider suggesting once per plan or per start level.
