# CLAUDE.md – Upversion

**The source of truth is [`docs/SPEC.md`](docs/SPEC.md).** Read it before changing anything. If the spec, the catalog data in `data/catalog/` or the code disagree, or the spec looks like a mistake, say so instead of guessing.

Upversion turns a learning goal into a study plan and runs it day by day (PWA; React + TypeScript web app, Fastify API, shared package with the scheduling engine; Supabase + Vercel + Render on free plans).

## Rules to always follow

**Cost**
- **$0.** Free tiers only. If anything needs a credit card or could charge money, stop and ask.
- No paid AI providers (no Claude API). AI is an optional extra; the app must work with it off (template and rule-based fallbacks).

**Git flow**
- Feature branches `feature/<area>-<name>` (`api`, `web`, `shared`, `infra`, `catalog`) are created from `rnd`; PRs go into `rnd`. Release PRs go from `rnd` to `main`. Hotfixes go from `main` and are merged back into `rnd`.
- Never commit directly to `main` or `rnd`. Claude merges green feature PRs (every required check, including `e2e`) into `rnd` (squash) after their tier's review. **Only the owner merges into `main`** (merge commit).
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`), small and focused. Every PR says what changed, why, how to test, and has a screenshot for UI changes.
- Database migrations are additive and backward compatible, take the target schema explicitly (`rnd` first, then `prod`), and refuse to run without it.

**Facts**
- **Never invent facts:** no made-up course links, prices or free-tier limits. Check official docs and mark anything unverified as "needs check".
- Never present a catalog item with `url_verified: false` or `price_verified: false` as verified.

**Privacy and security**
- Row Level Security on every user-owned table, tested directly against the database. The API never accepts a `user_id` from the client.
- No secrets in the repo (`.env.example` has no real values). Check before every commit.
- No personal details (name, email, phone, links) are ever sent to AI models.
- The calendar write-guard (spec 3.8): the app only writes to events it created itself in its own calendar; scopes are `calendar.app.created` + `calendar.readonly` only.
- The owner's personal data (their real plan, the original spec) lives in a private repo, never here.

**Scope**
- Don't build anything from spec section 12.1. Build only the seams in 12.3. If something seems to need a deferred feature, ask.
- Plan changes are suggestions until the user approves them. The app never marks a task done on its own.

**Process**
- Stop at the end of every phase: run the review gate, show what works on the R&D environment, and wait for approval before releasing.
- When sending the owner a plan for approval, send only what is new.
- The whole project (UI, content, code, comments, commits, docs) is in English.
- **Model split:** plan and review on Opus. Code is written by Sonnet subagents, each working from a precise brief (files, tests, acceptance criteria, review tier) in an isolated worktree. Every diff gets its tier's review below before it merges, and a fix's test must fail without the fix.
- **Review tiers (ADR 018).** The Opus planner sets the tier in each brief from what the diff touches; a reviewer may raise it, never lower it; a PR touching any Tier 1 area is Tier 1 as a whole; when unsure, take the higher tier.
  - **Tier 1** – auth and sign-in, RLS and policies, migrations, calendar writes and tokens, AI payloads (anything built for or sent to a provider), secrets and keys config, account export and deletion: a full adversarial Opus review with mutation spot-checks of the guards, then an Opus delta review of every fix commit until clean.
  - **Tier 2** – other API, shared and web feature code, CI workflows, and docs that change rules (CLAUDE.md, the spec, ADR decisions, `docs/legal/`): one Opus review pass of the full diff; fixes are checked against its findings.
  - **Tier 3** – other docs, copy, styles, tests only, catalog data regenerated with `build.py`: the builder self-checks against the brief, CI is green, and Opus spot-checks the diff (and moves it to Tier 2 if needed).
- **ADRs are one page** (about 120 lines) with at most three owner questions, each with a recommended default. Build detail goes into the work-package briefs.
- **End-to-end tests are required:** `e2e` is a required CI check, and a user-facing flow is not done until an e2e test covers it.
- **Worktrees:** remove an agent worktree and its local branch once its PR is merged or closed; prune leftovers at every phase gate.
- **Questions for the owner** go in the question box (`AskUserQuestion`), asked in the same step as ongoing work so building doesn't wait.
- **Save tokens:** delegate broad reads and coding to subagents, read file ranges instead of whole files, cap search output, and don't re-read files just written.
- **Design:** no design plugin is installed. Follow the approved Blocks design and the craft rules in the web app's brief (no gradients, no nested cards, no decorative emoji) and check the result against them in review.

## Catalog data (`data/catalog/`)
- Read `data/catalog/README.md` first. Don't hand-edit the generated JSON/SQL: edit `build/catalog.py`, `taxonomy.py` or `questions.py` and run `python3 data/catalog/build/build.py` (run it from `data/catalog/build`). CI fails if generated files drift.
- `schema.sql` is a reference design, not something to run by hand; turn it into migrations (with RLS) and load data through the seed process.
- `questions.json` drives the guided intake; never hard-code the questions.

## Docs
- `docs/legal/` – privacy policy, terms and disclaimer drafts (placeholders in square brackets stay until the owner fills them; not legal advice).
- `docs/decisions/` – ADRs (to be added in Phase 0).
