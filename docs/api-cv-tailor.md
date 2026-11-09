# API: tailor my CV to a job (ADR 016)

`POST /api/v1/me/cv/tailor`. Behind `FEATURE_CV_TAILOR` (default off): with the flag off the route is not registered and answers 404, and `GET /api/v1/ai/usage` reports `features.cvTailor: false`. Needs a bearer token and accepted Terms (403 `terms_not_accepted` otherwise). The user is the token's `sub`; a `userId` or any other unknown key in the body is 400. Every error has the shape `{ "error": { "code", "message", "requestId" } }`. The live contract is `GET /api/v1/openapi.json`; the types are in `apps/web/src/api/schema.d.ts` (generated, not hand-edited).

This is the one place where CV text leaves the device, and only because the user pressed "Send to AI" on the preview screen (ADR 016 section 2.3). The browser cleans the text first; the server only checks it.

## Request

```json
{ "cvText": "...", "jobText": "...", "roleId": "optional roles.json id" }
```

| Field     | Rule                                                   |
| --------- | ------------------------------------------------------ |
| `cvText`  | 200 to 6000 characters after trim                      |
| `jobText` | 100 to 3000 characters after trim                      |
| `roleId`  | optional; unknown id is 400 `unknown_role`; the role's catalog **title** (never free text) goes into the prompt |

U+0000 anywhere in the body is 422 `unprocessable`.

## What the server does, in order

1. Strict body validation (400), then the per-user rate limit: **3 per minute** (in memory, per API instance) → 429 `rate_limited`.
2. **PII check, no repair.** `findCvPii` runs on `cvText` and `jobText` as received, with the account's own identifiers (email, display-name tokens). Anything found → **422 `pii_blocked`**; nothing is sent, nothing is counted, and the answer never says what was found or echoes the text. Catalog tool names that look like hosts (`ASP.NET`, `monday.com`) are allowed text; an email or URL that merely contains one is still found.
3. **App-wide cap:** `AI_CV_TAILOR_DAILY_TOTAL` (default 20) runs per UTC day over all users, summed from `ai_usage_daily` by the `ai_cv_tailor_usage_today()` database function (migration 0017; no argument, fixed to `cv_tailor`, returns one number and no rows). Reached → 429 `ai_feature_cap`. Concurrent runs may overshoot by a few.
4. The prompt is built with `buildCvTailorPrompt` and checked against the context window of Cloudflare and Groq **only** (not the minimum over every registered provider) → 422 `too_long`. `buildSafeRequest` is the second gate; it is called with the same tool-name allowance as step 2 so it never silently changes text that step 2 accepted.
5. **Gateway**, restricted to `['cloudflare-ai', 'groq']` in that order (a `providers` option on `generate`; no other provider is consulted, whatever the global order). Cloudflare uses its 8B chat model (`json: false`). Before the user's run is reserved, the gateway checks that a listed provider is usable **and has budget left** (not in cooldown, today's use below its budget). If none: **503 `ai_unavailable`, the run is not counted and nothing was sent.** The user's run (`AI_USER_DAILY_CV_TAILOR`, default 3 per UTC day; at the cap 429 `ai_user_cap`) is reserved only right before the first provider that is really about to be tried (not in cooldown, turn deadline not passed), then Cloudflare is called, then Groq only if Cloudflare failed.
6. The answer goes through `parseTailorOutput` and `checkTailoredOutput`: personal details are removed (and `output_redacted` is noted), control characters removed, length cut at 8000, and every number, catalog skill or tool, certificate, degree and employer-like phrase the CV does not contain is returned as a flag (at most 100 flags, each text cut to 200 characters; the same caps are applied in `checkTailoredOutput` and again by the service). Notes the model wrote are redacted too.

## Response 200

```json
{
  "text": "SUMMARY ... EXPERIENCE ... SKILLS ...",
  "notes": [{ "kind": "missing_keyword", "text": "Process improvement" }],
  "flags": [{ "kind": "number", "text": "40%" }],
  "providers": [{ "id": "cloudflare-ai", "label": "Cloudflare Workers AI" }],
  "usage": { "used": 1, "cap": 3 }
}
```

- `text`: plain text, at most 8000 characters. Render it as text only.
- `notes` (at most 40, each at most 200 characters), in this priority order: `output_redacted`, `check_number` / `check_skill` / `check_term` (one per flag), `missing_keyword` and `matched_keyword` (rule-based, from the keyword gaps against the catalog), `model_note` (`gap: ...` / `keyword: ...` lines from the model, a format warning, or a truncation notice).
- `flags`: the items behind the `check_*` notes, for highlighting (`number`, `skill`, `certificate`, `degree`, `term`, `placeholder`). `[number?]` is the one allowed placeholder and is not flagged.
- `providers`: **every** provider the text was handed to, in order: the one that failed first (when the gateway switched) and the one that answered.
- `usage`: today's runs for the user and the per-user cap (best effort: 0 if the counter could not be read after the run).

## Errors

| Status | Code                                | When                                                                                              |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| 400    | `validation_error`, `unknown_role`  | unknown key, `userId`, size outside the caps, unknown `roleId`                                    |
| 401 / 403 | `unauthorized`, `terms_not_accepted` | the usual guards                                                                              |
| 404    | `not_found`                         | flag off                                                                                          |
| 422    | `pii_blocked`                       | personal details in either text (nothing sent, nothing counted)                                  |
| 422    | `too_long`                          | the built prompt exceeds a listed provider's window                                               |
| 422    | `unprocessable`                     | U+0000                                                                                            |
| 429    | `rate_limited`                      | more than 3 per minute                                                                            |
| 429    | `ai_user_cap`                       | the user's runs for today are used (`fallbacks: ["keyword_list", "copy_prompt"]`)                 |
| 429    | `ai_feature_cap`                    | the app-wide runs for today are used (same `fallbacks`)                                           |
| 503    | `ai_unavailable`                    | no usable provider (run **not** counted), or every listed provider was tried and failed (run **counted**). The body is the same in both and carries no provider information; `fallbacks: ["keyword_list"]`. The client tells the two apart by the run count, which only rises when a provider was attempted. |

A timeout or 5xx from our own server says nothing about whether a provider received the text; the client must not claim otherwise (ADR 016 section 6).

Known gap: the budget is checked just before the user's run is reserved, and the run is reserved just before the first provider budget reservation. A budget used up by another request in that tiny gap (or a failing budget reservation for the first provider) can still end in 503 after the run was reserved; the counters only go up, so there is no refund. A turn whose deadline has passed, or whose providers are all in cooldown, no longer counts a run.

The budget pre-check (one extra database round trip) runs for every AI call where the gateway reserves the user's call itself (`userCap: 'reserve'`, the default, for any purpose). Today only CV tailoring calls it that way; practice chat and AI feedback reserve earlier (`already_reserved`) and skip the check. The response's `roleId` adds the catalog title only to the prompt.

## Nothing stored, nothing logged

No table, column, cache, event or idempotency record holds the CV, the job text, the prompt or the answer. `ai_cache` is unchanged by migration 0017, so a `cv_tailor` row there is rejected by its check. The only trace is `ai_usage_daily (purpose = 'cv_tailor')`, a counter. Logs carry the request id, status, provider id and error code only; error bodies are fixed text.

## What is NOT detected

Names other than the account's own display-name tokens, street addresses, employer names, dates of birth and ID numbers written in words are not detected. The user is the check for those; the browser drops the contact block and shows the warning (ADR 016 sections 2.2 to 2.4).

## Configuration (names only, see `.env.example`)

`FEATURE_CV_TAILOR` (default `false`), `AI_USER_DAILY_CV_TAILOR` (default 3), `AI_CV_TAILOR_DAILY_TOTAL` (default 20). The usual provider variables apply (`AI_PROVIDERS`, `AI_BUDGET_CLOUDFLARE_AI_DAILY`, `AI_BUDGET_GROQ_DAILY`); both providers stay off until the owner confirms their free plans (ADR 013).

## `GET /api/v1/ai/usage`

Adds `user.cvTailor` (`{ used, cap }`) and `features.cvTailor` (the flag and nothing else: it does not say whether a provider is available; read `configured` and `providers[]` for that).
