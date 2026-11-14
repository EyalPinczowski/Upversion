# API: optional AI explanations for the plan builder (ADR 017, WP-4)

`POST /api/v1/plans/build/explain`. Behind `FEATURE_PLAN_BUILDER_AI` (default off) **and** `FEATURE_PLAN_BUILDER`: with either flag off the route is not registered and answers 404, and `GET /api/v1/ai/usage` reports `features.planBuilderAi: false`. Needs a bearer token and accepted Terms (403 `terms_not_accepted`). The user is the token's `sub`. The live contract is `GET /api/v1/openapi.json`; the web types are generated (`pnpm api:types`).

The plan builder never waits for this. It runs **only when the user presses "Explain with AI"** on the draft step, never on preview. With AI off, over a cap or failing, the web keeps the template "why" lines and everything else works the same.

## Request

```json
{ "request": { "...BuildRequest": "same as preview" }, "draftHash": "<hash of the preview>" }
```

Strict: unknown keys (`userId`, `text`, `lines`, anything) are 400. There is **no free text anywhere**: the client sends the same request it previewed, and the server rebuilds the draft itself with `buildPlan` (409 `draft_changed` if its `draftHash` differs, before any provider is called).

## What a model receives (allowlist)

Built by `planExplainInput` (`packages/shared/src/plan-builder/explain.ts`) from the rebuilt draft, never from the client or the profile: the catalog role titles, and per item the catalog id, title, provider, kind, tier, origin, hours, `free` and `certificate` booleans, up to four skills (catalog name, role weight, level label, `extra`) and the template sentence (`baseline`). Never sent: names, emails, CV text, `rolesHeld.title`, job post text, any free-text answer (none can reach the request). The input goes through `buildSafeRequest` with the user's own identifiers (redact, then assert); if that fails nothing is sent (503). At most 30 items (fewer if the providers' context window needs it); the rest keep their template. Cloudflare Workers AI (8B model) is tried first, then Groq; `providers` in the answer lists every one that received the input.

## Response 200

```json
{
  "lines": [{ "itemId": "<catalog id>", "text": "...", "source": "ai" }],
  "providers": [{ "id": "cloudflare-ai", "label": "Cloudflare Workers AI" }],
  "usage": { "used": 1, "cap": 10 }
}
```

`lines` has one entry per item of the draft, in plan order. The model is asked for `id: sentence` lines. A line is the model's (`source: "ai"`) only if it passes every check; otherwise it is the template line (`source: "template"`). Refused: length under 15 or over 200 characters; markup, symbols, emoji; links, emails, handles, phone numbers, the account identifiers; any price or money word; "free" for a paid item; certificate or exam talk for an item that is not one; any number that is not the item's own hours, weights or in its baseline, and spelled-out numbers; any catalog item title, provider, skill or role name that is not the item's own (or in its baseline); over-claims ("guarantee", "hired", "expert"); instructions, refusals and "as an AI" text. Items, order, hours, cost and links are never touched.

`providers` is empty for a cached answer. The answer is cached per user for 7 days under `cacheKey(SafeAIRequest)` (the gateway's cache; `ai_cache.purpose = 'plan_explain'`): the same draft gives the same request and hits the same entry, with no provider call and no run spent, also when the app-wide cap is reached. The cache holds the model's raw reply; it is re-parsed and re-checked on every read. A reply that fails all checks stays cached for the 7 days (templates are shown). Nothing else is stored; no draft, prompt, input or line is logged.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | validation | unknown key, bad body |
| 409 | `draft_changed` | the rebuilt draft's hash differs from `draftHash`; re-preview |
| 422 | `unprocessable` | the builder refuses the request (as for preview) |
| 429 | `rate_limited` | more than 5 runs per user per minute (in memory, per instance) |
| 429 | `ai_user_cap` | `AI_USER_DAILY_PLAN_EXPLAIN` (default 10 per UTC day; **needs check** against the providers' free quotas) |
| 429 | `ai_feature_cap` | `AI_PLAN_EXPLAIN_DAILY_TOTAL` (default 50 per UTC day over all users, read from `ai_usage_daily` through `ai_plan_explain_usage_today()`, so it survives restarts; **needs check**) |
| 503 | `ai_unavailable` | no provider configured, every budget used, every provider failed, or nothing could be sent safely; `fallbacks: ["template"]`. No run is spent when no provider was tried (the remaining budget is checked before the user's call is reserved, which happens just before the first attempt) |

## Saving the AI lines with the plan

`POST /plans/build` keeps its body. With `useAiExplanations: true` (and the AI flag on) the server rebuilds the explain request, reads **only the cached answer** (no provider call), re-checks it and replaces the template sentence at the start of the matching task notes. No cache entry means the templates are saved. The body has no text field, so the client cannot inject text into a note.

## Config

`FEATURE_PLAN_BUILDER_AI`, `AI_USER_DAILY_PLAN_EXPLAIN`, `AI_PLAN_EXPLAIN_DAILY_TOTAL` (see `.env.example`). Migration `0019_ai_purpose_plan_explain.sql` widens the purpose checks of `ai_usage_daily` and `ai_cache` and adds `ai_plan_explain_usage_today()`.
