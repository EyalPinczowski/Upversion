# 009 – Hosting on free tiers: Vercel, Render, Supabase

**Status:** Accepted · built in Phase 0. Which service hosts the web app today (Vercel, or Cloudflare as "Option B" in `docs/setup/deployments.md`) is **needs check**

## Context
Everything must run at $0, with an Operational and an R&D environment, for a small group of users. Free limits change. Supabase's are verified (see `docs/setup/supabase.md`: two free projects, 500 MB, 50,000 monthly users, pausing after a week of low activity). Vercel's and Render's are still **needs check** against their documentation before those services are created, including that no card is required.

## Options
- Frontend: Vercel Hobby (production for `main`, preview for `rnd`).
- Backend: Vercel Functions, or Render Free.
- Database and sign-in: Supabase free plan.

## Decision
Backend on **Render Free**, as a long-running Node service per environment (`upversion-api`, `upversion-api-rnd`). The API code stays host-agnostic, so moving is cheap. Free Render services sleep when idle, so a scheduled GitHub Action pings the production API during study hours (a UTC window that covers both daylight-saving offsets, plus a local-time check), and the web app shows a "waking up the server…" message instead of an error.

## Consequences
- The cold start is measured separately from the dashboard's load time.
- The proxy hop count for rate limiting must be verified on Render before `TRUST_PROXY` is raised from 0.
- A free-hours budget limits how many services can stay awake; R&D is left to sleep.
