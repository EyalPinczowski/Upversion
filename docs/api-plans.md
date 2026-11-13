# Plans and schedule API (v1)

Base path `/api/v1`. Every route needs `Authorization: Bearer <Supabase access token>`. The user is the token's `sub`; a `user_id` in a body, query or header is never read. A plan that belongs to someone else answers exactly like one that does not exist (404). All errors have one shape: `{ "error": { "code", "message", "requestId" } }`. The live contract is `GET /api/v1/openapi.json` (UI at `/api/v1/docs`).

| Method and path                       | What it does                                                                   | Success | Errors                  |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------- | ----------------------- |
| `POST /plans/import`                  | Import a plan file (see below)                                                 | 201/200 | 400, 409, 413, 422      |
| `GET /plans`                          | Own plans as summaries (`taskCount`, `summary`)                                | 200     |                         |
| `GET /plans/:id`                      | Plan with `weekPattern`, `overrides`, `tasks`                                  | 200     | 400, 404                |
| `DELETE /plans/:id`                   | Delete the plan and everything it owns (tasks, logs, events, ...)              | 204     | 400, 404                |
| `PUT /plans/:id/week-pattern`         | Replace the weekly time settings (shared `WeekPatternSchema`, spec 3.7)        | 200     | 400, 404                |
| `PUT /plans/:id/day-overrides/:date`  | Set the exception for one date `{ isStudyDay, capacityHours? }` (max 1000)     | 200     | 400, 404, 422           |
| `DELETE /plans/:id/day-overrides/:date` | Remove it; succeeds when there is none                                       | 204     | 400, 404                |
| `GET /plans/:id/schedule?today=`      | Run the shared engine: `blocks`, `warnings`, `finishDate`. `today` defaults to the date in the plan's time zone | 200 | 400, 404, 422 |
| `POST /plans/:id/schedule/preview`    | `{ today?, pattern?, overrides?, removeOverrideDates? }` returns the change summary text and the proposed schedule. **Saves nothing.** | 200 | 400, 404, 422 |

## Import

Body: a plan file (`formatVersion: 1`, shared `PlanFileSchema`) plus

- `id`: a UUID the client generates. This is the idempotency key.
- `status`: optional, `draft` or `active` (default `active`).

The plan, week pattern, day overrides, tasks and a `plan.imported` event are written in one transaction. Sending the same `id` and content again returns **200** with the stored plan and creates nothing; the same `id` with different content returns **409**. Content is compared with a hash recorded in the `plan.imported` event, so a retry still returns 200 after the plan was edited. Optional `skillIds` (array of taxonomy skill ids from `data/catalog/skills.json`, at most 50): every id must exist in the taxonomy, repeats are dropped (first one wins, order kept) and the list is stored in `plans.summary.skillIds`, which the day briefing reads to pick the "Idea of the day" podcast. An empty list is the same as leaving the field out, and a plan file without it imports exactly as before (no `skillIds` in the summary). Skill ids belong to the content hash, so re-sending the same plan `id` with different `skillIds` is a **409** like any other content change; nothing is updated in place. Import takes the same per-user lock as a plan build or restore (docs/api-plan-builder.md), so they run one at a time, and it never archives another plan. Limits: body 512 KiB (413), 500 tasks and 1000 overrides (422). Invalid plans (unknown time zone, duplicate task ids, unknown dependencies, blank names, end before start, duplicate override dates, unknown or too many `skillIds`) answer 422 with the field paths in `message`.

## Open tasks and day snapshots

`GET /plans/:id/open-tasks?today=` lists the tasks of the week that are not done: planned this week, or carried over (planned on an earlier frozen day and still open, listed in `carriedOverFrom`). A task that was **skipped** after it was planned on an earlier day stays in the list with `status: "skipped"` and its `carriedOverFrom` dates, so the user can reconsider it (spec section 9); nothing reopens it automatically, and `POST .../reopen` brings it back. A skipped task that was never planned on an earlier day, and every done task, are left out.

A frozen day (`schedule_days`) is **the plan as of the start of that day**: work logged on or after the day, and a task completed or skipped on or after the day, do not count yet. So a task skipped or marked done (without any log) during Monday is still in Monday's snapshot. Without that, such a task would vanish from the day it was planned on, the day review would show less than was planned, and a task skipped yesterday could never be carried over. The date comes from the `date` in the `task.completed` / `task.skipped` events (the plan-local date, written by the API; for older completion events the event time in the plan's time zone). A task skipped before skips were recorded has no such date and stays skipped in every snapshot, which is the old behaviour. Days that are already frozen never change.

## Archived plans are read-only

A plan with status `archived` (set by the plan builder or a restore, see docs/api-plan-builder.md) refuses every user-facing write with **409 `plan_archived`**: week pattern, start date, day overrides, task edits, logs, complete/reopen/skip, new practice sessions and messages, day start/end, reviews and suggestion accept/reject. It can still be read, deleted and restored. `draft` and `done` plans stay writable.

## Notes

- The schedule uses the stored tasks only. CV-update tasks appear once the tasks module creates them (they are not projected here).
- Plan changes are suggestions until the user approves them: the UI previews with `schedule/preview` and then saves with the PUT endpoints.
- Tests: `apps/api/test/plans.test.ts` (real Postgres, see `packages/db/README.md` for the throwaway cluster).
