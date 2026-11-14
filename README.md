# Upversion

*Build your skills, one block at a time.*

Formerly Skillstack and Skilender.

Upversion is a web app (PWA) that turns a learning goal into a study plan – courses, certificates and practice sized to the time you have – and then runs that plan day by day: what to do today, practice sessions, an end-of-day review, and automatic rescheduling based on what actually happened.

> **Status: early development.** Phase 0 (environments) is released as v0.0. v0.1 (foundation), v0.2 (daily experience), v0.3 (practices) and v0.3b (calendar) are built on `rnd` and not released yet; the reviews are in `docs/reviews/` (none yet for v0.3 and v0.3b). The plan builder is in progress, and the next work is the goal-centred core ([ADR 018](docs/decisions/018-goal-centred-core.md)). This README grows with each release.

## Why

Study plans usually fail on the second day: something takes longer, something comes up, and the plan is out of date. Upversion treats the plan as an ordered task list plus daily capacity, and reschedules from today onward after every change.

## Roadmap

| Phase | What | Status |
|---|---|---|
| 0 | Environments: `main` / `rnd`, CI, two database schemas, deployments, backups | Released (v0.0) |
| v0.1 | Foundation: accounts with row-level security, data model, scheduling engine, tasks API, minimal UI | Built on `rnd`, awaiting release approval |
| v0.2 | Daily experience: dashboard, day briefing, day review, adjustment rules | Built on `rnd`, awaiting release approval |
| v0.3 | Practices: in-app practice with free AI models and provider fallback | Built on `rnd`, not released; no phase review report yet |
| v0.3b | Google Calendar with minimal scopes and a write guard (moved up from v0.6) | Built on `rnd`, not released; no phase review report yet |
| v0.4 | Content, plan and admin console | Planned |
| v0.5 | Plan builder: catalog, guided intake, plan generation | In progress on `rnd` (rule-based builder, ADR 017) |
| B | Goal-centred core: goal strip on Today, Goal screen, a 4-screen first run ([ADR 018](docs/decisions/018-goal-centred-core.md)) | Next |
| Release | First release of `rnd` to `main` | Not scheduled: the owner chose to keep building first; release-readiness items are in ADR 018 section 7 |
| v1.0 | Showcase: PWA, demo mode, metrics, full README | Planned |

## Architecture (planned)

```mermaid
flowchart LR
  user([User]) --> web["apps/web<br/>React + TypeScript PWA"]
  web -->|REST /api/v1| api["apps/api<br/>Fastify + TypeScript"]
  api --> shared["packages/shared<br/>Zod schemas + scheduling engine"]
  web --> shared
  api -->|RLS-scoped queries| db[("Supabase Postgres<br/>schemas: prod, rnd")]
  api --> ai["Free-tier AI providers<br/>(optional)"]
  api --> cal["Google Calendar<br/>(optional, own calendar only)"]
```

## Principles

- **$0 to run.** Free tiers only; AI is an optional extra and every AI feature has a template or rule-based fallback.
- **Privacy first.** Row-level security on every user-owned table; no personal details sent to AI models.
- **Honest data.** Catalog entries carry verification flags; anything unconfirmed shows a "needs check" badge.
- **Suggestions, not surprises.** Plan changes are proposals the user approves.

## Repository layout

```
apps/web/           React + Vite + Tailwind PWA
apps/api/           Fastify REST API (/api/v1, OpenAPI docs)
packages/shared/    Zod schemas, date helpers, scheduling engine
packages/db/        database roles, migration runner, backup and restore scripts
docs/SPEC.md        build spec (source of truth)
docs/setup/         owner guides: Supabase, database, deployments, backups
docs/decisions/     architecture decision records (ADRs)
docs/legal/         privacy policy, terms of use, disclaimer (drafts)
data/catalog/       course catalog, roles, skills, intake questions, RAG documents
CLAUDE.md           rules for Claude Code
CONTRIBUTING.md     branching and merge strategy
```

## Development

Node 22 and pnpm 10. The API reads plain environment variables (see `.env.example`; `TRUST_PROXY` stays `0` until the Render hop count and X-Forwarded-For format are verified, needs check; maximum 5, and a value above the real number of proxy hops lets clients spoof their IP and defeats the rate limit); the web app reads `apps/web/.env` (see `apps/web/.env.example`).

```bash
pnpm install
CORS_ORIGINS=http://localhost:5173 pnpm --filter @upversion/api dev   # http://localhost:3000, docs at /api/v1/docs
pnpm --filter @upversion/web dev     # http://localhost:5173
pnpm lint && pnpm typecheck && pnpm test
```

## Legal

The documents in `docs/legal/` are drafts written for a free, invite-only beta. **They are not legal advice** and need review before the app is opened to the public.

## Built with Claude Code

This project is built with [Claude Code](https://claude.com/claude-code), working from the spec in `docs/SPEC.md` with every phase reviewed and approved by the owner.

## License

[MIT](LICENSE)
