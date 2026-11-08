# API: profile and setup (ADR 015)

Behind `FEATURE_PROFILE_SETUP` (default off). With the flag off the routes are not registered and answer 404. All routes need a bearer token and accepted Terms (403 `terms_not_accepted` otherwise). The user is always the token's; a `userId` (or any unknown key) in a body or query is a 400. Answers, skills and titles are never logged and never echoed in error messages. Table: `user_profiles` (migration 0016, `packages/db/README.md`).

`UserProfile` (every response, strict):
`{ answers: {[setupQuestionId]: value}, skills: [{skillId, level 0..3, source: 'cv'|'setup'|'manual'}], rolesHeld: [{roleId|null, title <= 80, years 0..50|null}], yearsExperience: number|null, cvImportedAt: ISO|null, setupStatus: 'not_started'|'in_progress'|'completed'|'dismissed', setupStep: string(<= 40)|null, setupCompletedAt: ISO|null }`.
No row means the defaults (`not_started`, empty), and `GET` creates nothing.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/v1/me/profile` | none | 200 `UserProfile` |
| PUT | `/api/v1/me/profile/answers` | `{answers: {...}}` | 200 `UserProfile`; partial merge, idempotent |
| PUT | `/api/v1/me/profile/import` | `ProfileImport` (shared schema) | 200 `UserProfile` |
| PATCH | `/api/v1/me/profile/setup` | `{status, step?}` | 200 `UserProfile` |
| DELETE | `/api/v1/me/profile` | none (a body naming anything is a 400) | 200 cleared `UserProfile` with `setupStatus: 'dismissed'` |

- **answers:** each key must be a setup question id (`setupQuestions()`), each value passes `validateAnswer` (`multi_role` / `multi_skill`: taxonomy ids only, count <= `max`; "Other" and typed values are refused). Any invalid entry is a 400 `invalid_answer` and nothing is saved.
- **import:** replaces all `source: 'cv'` skills by the confirmed ones; `manual` and `setup` skills are kept and win on a clash. Replaces `rolesHeld` and `yearsExperience`, sets `cvImportedAt`, pre-fills `answers.education` and `answers.tools_known` only when absent. 400 `invalid_import` for an unknown skill or role id, a duplicate skill, a tool that is not a `tools_known` option, or a role title with an email, link, handle or phone number. (Skill ids are unique and the taxonomy has fewer than 60, so the row's cap of 60 skills cannot be hit.)
- **setup:** `completed` sets `setupCompletedAt` (the first time; kept after). `step` is left unchanged when omitted. Creates the row if missing. All status changes are allowed (no 409).
- **DELETE:** clears answers, skills, roles, years and `cvImportedAt`; keeps the row as `dismissed` so the web never redirects back to setup.
- **Export / delete account:** `GET /me/export` has a `userProfiles` section; deleting the account removes the row (cascade).
