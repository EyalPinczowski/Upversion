# API: goal progress and level approval (ADR 018, phase B2)

Two routes. Both need a bearer token and accepted Terms (403 `terms_not_accepted` otherwise). They are **not** behind a feature flag (reading is harmless and the write needs a suggestion that only progress produces). The user is the token's `sub`; a `userId`, `user_id` or any other unknown key in a body or query is 400. A plan that is not the caller's answers 404, the same as one that does not exist. The live contract is `GET /api/v1/openapi.json`; the web types come from `pnpm api:types`.

| Method | Path                            | Body                          | Result                                |
| ------ | ------------------------------- | ----------------------------- | ------------------------------------- |
| GET    | `/api/v1/plans/{id}/goal-progress` | none                       | 200 `{ planId, planStatus, goal, progress, suggestions }` |
| POST   | `/api/v1/me/level-ups/approve`  | `{ planId, skillId, toLevel }` | 200 `{ skillId, fromLevel, level, source: 'manual' }` |

## Goal progress (read only)

- `goal` is `plans.summary.goal` (written when the plan is built or imported, ids and numbers only). Older plans have none: it is derived from `summary.skillIds` and `summary.targetRoleIds` (`deriveGoal`), with no start levels. A plan that names no skill answers `goal: null`, `progress: null`, `suggestions: []`.
- `progress` is `skillProgress` from `@upversion/shared`: per goal skill the planned and done hours, tasks done and total, status, the current level (the user's profile level, else the goal's start level, else 0) and practice evidence. A task's skills are its own `tasks.skill_ids`; when that is NULL (a row from before migration 0020) the catalog item named by `externalRef` (`catalog:<id>`) is used; `[]` means the task builds no skill. Hours of tasks that build none of the goal's skills are reported as `unattributedHours`, never hidden. The number is called "plan coverage" (`label`), never readiness.
- **Practice scores are evidence only.** Each practice feedback score (0 to 10) of the plan is credited to the skills of its task and shown as `practice { average, count }`. A score never creates a suggestion.
- `suggestions` is `suggestLevelUps`: a skill whose tasks are all done and whose level is below 2 (comfortable) gets one level up. It is empty for an **archived** plan (read-only, ADR 017 section 4.1), while `progress` is still returned.
- Nothing is written, whatever the suggestions say.

## Approve a level update

`POST /api/v1/me/level-ups/approve` is the only place a level is written from progress, and only for an explicit request (spec 12.2: suggestions, never self-marking). In one transaction the server locks the plan row (`requireWritablePlan`: 404 for another user's plan, **409 `plan_archived`** for an archived one) and share-locks its tasks, recomputes the suggestions from the stored tasks and the user's profile, and accepts only the one that matches:

- `skillId` must be a skill with a suggestion right now, and `toLevel` exactly that suggestion's level (one above the current one). The body schema allows only 1 or 2, so a level above 2 is 400, and a level the rule would not suggest is **409 `not_suggested`** (stale suggestion, skill not in the goal, tasks not all done, level already at the cap). Nothing is written then.
- It writes that skill to `user_profiles.skills` with `source: 'manual'` (replacing the user's entry for the skill, keeping the others) and a `level_up.approved` event on the plan. **409 `profile_skills_full`** if a new skill would be the 61st.
- A repeat of the same request is 409 `not_suggested`: after the write the step is no longer suggested.
- The rule currently offers the next step (1 to 2) right after an approval while all tasks stay done; it never goes above 2.

## Where the data lives

`tasks.skill_ids text[]` (migration 0020, nullable, at most 10 ids): NULL unknown, `[]` builds no skill. Import validates each id against the taxonomy (422 with `tasks.N.skillIds.M`, like the plan-level ids), the builder writes the catalog item's skills (`[]` for exam booking tasks), and `GET /plans/{id}` returns the field (absent when NULL). The goal is in `plans.summary.goal`; there is no new table.
