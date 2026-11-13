# API: plan builder, archive and restore (ADR 017)

Three routes behind `FEATURE_PLAN_BUILDER` (default off): with the flag off they are not registered and answer 404, and `GET /api/v1/ai/usage` reports `features.planBuilder: false`. They need a bearer token and accepted Terms (403 `terms_not_accepted` otherwise). The user is the token's `sub`; a `userId`, `user_id` or any other unknown key in a body is 400. Every error has the shape `{ "error": { "code", "message", "requestId" } }`. The live contract is `GET /api/v1/openapi.json`; the types are in `apps/web/src/api/schema.d.ts` (generated with `pnpm api:types`, never hand-edited).

The server runs the rule-based builder (`buildPlan` from `@upversion/shared/plan-builder`, bundled catalog). The client only collects choices: it never sends tasks, prices or hours. AI is not involved in these routes (the optional explanation text of ADR 017 section 3 is a later work package; `useAiExplanations` is accepted and ignored until then, templates are saved).

| Method | Path                           | Body                                                    | Result                                          |
| ------ | ------------------------------ | ------------------------------------------------------- | ----------------------------------------------- |
| POST   | `/api/v1/plans/build/preview`  | `BuildRequest`                                          | 200 `BuildDraft`. Saves nothing.                |
| POST   | `/api/v1/plans/build`          | `{ id, request, draftHash, replacesPlanIds, useAiExplanations? }` | 201 plan (200 on an idempotent retry) |
| POST   | `/api/v1/plans/{id}/restore`   | `{ replacesPlanIds }`                                   | 200 plan                                        |

## `BuildRequest`

The shared schema `BuildRequestSchema`, strict, with **no free text**: ids that match `^[a-z0-9][a-z0-9-]*$`, dates, times, numbers and enums only. Fields: `targetRoleIds` (1 to 2), `extraSkillIds` (up to 5), `skillLevels` (skill id to 0..3), `startDate`, `deadline`, `weekPattern`, `budget { mode: free|limit|flexible, amount? (USD, required for limit), maxItemPrice? }`, `certPreference`, `interviewPrep`, `certificateOptIns`, `examDates`, `mustInclude`, `exclude`, `priorityOverrides`. The schema is in `packages/shared/src/plan-builder/schemas.ts`.

`today` is not sent. The server computes it in `weekPattern.timezone` from its clock, as the schedule route does, so a start date in the past is moved to today.

## Preview

Returns the draft: `plan` (a normal plan file the engine can schedule), `items` (each with hours, cost, "why" line and needs-check flags), `excluded`, `skippedPrerequisites`, `summary` (finish date, total hours, cost, skills covered and not covered, certificates included and offered), `fits`, `options` (the three ways to fit, when it does not), `overBudget`, `removeToFit`, `warnings` and `draftHash`. Nothing is written: no plan, no event, no counter.

**422 `unprocessable`** when the request names something the catalog does not have or the dates cannot work. The body carries `error.issues`, a list of `{ code, id? }`; the message is generic and never echoes text from the request. Codes: `unknown_role`, `unknown_skill`, `unknown_catalog_id`, `duplicate_id`, `deadline_not_after_start`, `deadline_in_past`, `not_a_certificate`, `exam_date_too_late`, `exam_date_out_of_range`, `deadline_too_far`, `exam_dates_overlap`. `id` is the id the request itself named (it passed the id pattern), and is absent for date problems.

## Create

In **one transaction**, in this order:

1. The per-user lock: `pg_advisory_xact_lock(hashtextextended(advisoryKey(ctx, 'active-plan', userId), 0))`. `/plans/import` and `/plans/{id}/restore` take the same lock, so a build, an import and a restore of one user run one at a time.
2. **Idempotency first.** If a plan with this `id` exists, the stored hash of the **request body** (`request`, `draftHash`, `useAiExplanations`; recorded in the `plan.imported` event) is compared with this body's. Same: **200** with the stored plan, nothing re-built and nothing archived again. Other: **409 `conflict`**. The `draftHash` is not compared on this path, so a catalog deploy between the two calls cannot turn a retry into a 409.
3. A new `id`: the draft is rebuilt and its hash compared with `draftHash`. Different: **409 `draft_changed`** (the catalog or the inputs changed; preview again). A `BuildRequestError` is the same 422 as in preview.
4. The user's active plans are compared with `replacesPlanIds` as sets. Different (including an empty list while a plan is active, or a list naming a plan that is not active): **409 `active_plan_changed`**, nothing written. The client re-reads `GET /plans` and shows the archive dialog again.
5. Those plans become `archived` (`updated_at` set) and each gets a `plan.archived` event `{ by: 'plan_builder', replacedBy: <new id> }`.
6. The plan is inserted by the import service with `created_from = 'builder'`, status `active`, tasks `source = 'builder'`, `summary.targetRoleIds`, `summary.builderVersion` and a `plan.imported` event.

Any failure rolls all of it back: the old plan stays active and no new plan exists. With no active plan nothing is archived (`replacesPlanIds: []`). Several active plans can exist today (import does not archive), and all of them must be listed.

Two simultaneous builds with no active plan: the second waits on the lock, then finds the first one's plan active, and answers 409 `active_plan_changed`. Exactly one plan results.

## Restore

`POST /api/v1/plans/{id}/restore` with `{ replacesPlanIds }`: after the same lock, the plan must be `archived`; the plans that are active now (which must equal `replacesPlanIds`, else 409 `active_plan_changed`) become `archived` with `plan.archived` `{ by: 'restore', replacedBy: <id> }`, and the plan becomes `active` with a `plan.restored` event `{ replaced: [...] }`. A retry, when the plan is already the only active plan, answers **200** (checked before the active-set check). Only `archived` can be restored: a `draft`, `done` or otherwise active plan is **409 `plan_not_archived`**. A plan of another user is 404. Tasks are not rescheduled in the database: the schedule is computed from today on every read.

## Archived plans are read-only (ADR 017 section 4.1)

`requireWritablePlan` (`apps/api/src/modules/plans/guard.ts`) is the first call in the transaction of every user-facing write on a plan. It locks the plan row (`for no key update`) and answers **409 `plan_archived`** when the status is `archived` (and 404 for a plan that is not the caller's). It rejects only `archived`: `draft` and `done` plans stay writable. Logs, complete, reopen and skip take the lighter `for key share` lock instead, because the existing design says a log must never wait for a review or an accept (those hold `for no key update`); a build or a restore only updates non-key columns, so such a write that races an archive behaves as if it had come just before it.

| Refused on an archived plan (409 `plan_archived`)                                                                                         | Allowed on an archived plan                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `PUT week-pattern`, `PUT start-date`, `PUT`/`DELETE day-overrides/{date}`, `PATCH`/`DELETE tasks/{taskId}`, `POST tasks/{taskId}/logs`    | `DELETE /plans/{id}`, `POST /plans/{id}/restore`                                                                |
| `POST tasks/{taskId}/complete`, `reopen`, `skip`, `POST tasks/{taskId}/practice/sessions`, `PUT practice/context`                         | `POST schedule/preview`, `POST suggestions/{id}/preview` (they save nothing)                                    |
| `POST practice/sessions/{id}/messages`, `POST days/{date}/start`, `POST days/{date}/end`, `PUT days/{date}/review`                        | `POST practice/sessions/{id}/finish`, `abandon`, `feedback` for a session that already exists                   |
| `POST suggestions/{id}/accept`, `POST suggestions/{id}/reject`                                                                            | Every `GET`                                                                                                     |

Server-internal writes are not guarded and keep working: the day snapshots written when `GET progress` rolls the days over, the calendar sync's own tables (it removes an archived plan's future events from the app's own calendar), and the `plan.archived` event. Storing the reply of a practice turn that was already running (the second transaction of a chat message) is not guarded either.

`apps/api/test/plan-write-guard.test.ts` lists every `POST`/`PUT`/`PATCH`/`DELETE` route under `/plans/{id}` or `/plans/{planId}` from the real route table and fails for one that is neither in the guarded list nor in the allowed list, so a new route has to take the decision.

## Calendar

`/plans/build` and `/plans/{id}/restore` are in `RESCHEDULING_ROUTE` (`apps/api/src/app.ts`): after a successful call the calendar sync runs in the background, removes the archived plan's future events and writes the new active plan's (the write guard and the `calendar.app.created` scope are unchanged).

## Errors

| Status | Code                    | When                                                                          |
| ------ | ----------------------- | ----------------------------------------------------------------------------- |
| 400    | `validation_error`      | Body does not match the strict schema (unknown key, free text, bad id, ...)   |
| 401    | `unauthorized`          | No or bad token                                                               |
| 403    | `terms_not_accepted`    | The current Terms and Privacy Policy are not accepted                         |
| 404    | `not_found`             | Flag off; the plan is not the caller's or does not exist                      |
| 409    | `conflict`              | Create: the id exists with a different body                                   |
| 409    | `draft_changed`         | Create: the rebuilt draft's hash is not `draftHash`                           |
| 409    | `active_plan_changed`   | Create or restore: `replacesPlanIds` is not the user's active set             |
| 409    | `plan_not_archived`     | Restore: the plan is not archived (and not the only active plan)              |
| 409    | `plan_archived`         | A guarded write on an archived plan                                           |
| 422    | `unprocessable`         | Create or preview: `error.issues` lists the codes above                       |
| 429    | `rate_limited`          | Too many requests                                                             |

## Flag

`FEATURE_PLAN_BUILDER=true|false` (default `false`, see `.env.example`). `GET /api/v1/ai/usage` returns `features.planBuilder`, which the web reads. Turning the flag off does not unarchive or hide anything: archived plans stay archived, and the read-only rule is part of the plans module, not of the builder routes.
