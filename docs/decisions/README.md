# Architecture decision records

One short record per significant choice: the context, the options considered, the decision and its consequences. A new record is written whenever a decision changes direction. Status values: **Accepted** (decided and, unless noted, built), **Planned** (decided, not built yet), **Superseded**.

| # | Decision | Status |
|---|---|---|
| [001](001-dynamic-scheduling-as-pure-functions.md) | Dynamic scheduling as pure functions | Accepted |
| [002](002-minimal-calendar-scopes-and-write-guard.md) | Minimal calendar scopes and a write guard | Accepted |
| [003](003-one-supabase-project-two-schemas.md) | One Supabase project, two schemas, per-environment roles | Planned |
| [004](004-free-tier-ai-with-provider-fallback.md) | Free-tier AI with provider fallback, and AI as an optional extra | Planned |
| [005](005-in-browser-demo-with-mocked-api.md) | In-browser demo with a mocked API | Planned |
| [006](006-oauth-production-status-without-verification.md) | OAuth in production status, without Google verification at first | Accepted |
| [007](007-catalog-grounded-plan-generation.md) | The AI picks from a verified catalog | Planned |
| [008](008-visual-design.md) | Visual design: Blocks direction, logo A | Accepted |
| [009](009-hosting-on-free-tiers.md) | Hosting on free tiers: Vercel, Render, Supabase | Planned |
| [010](010-current-user-id.md) | Row-level security reads the user from `current_user_id()`, not `auth.uid()` | Accepted |
| [011](011-account-provisioning-in-the-database.md) | Accounts are created and deleted by database functions, not by app-role writes | Accepted |
| [012](012-aiprovider-seam.md) | The AIProvider seam, and a template-only day briefing in v0.2 | Accepted |
| [013](013-free-ai-providers-after-github-models.md) | Free AI providers after GitHub Models | Accepted for the code; spec 3.3 and 12.3 change proposed, awaiting owner approval |
| [014](014-calendar-token-encryption-and-write-guard.md) | Calendar token encryption and write guard | Accepted |
| [015](015-onboarding-setup-and-cv-import.md) | First-time setup and in-browser CV import | Accepted (owner, 2026-11-08); setup question rules need owner confirmation |

Facts about third-party free plans change often. Anything in these records that has not been confirmed on the provider's own documentation is marked **needs check**.
