# Contributing

Upversion is developed in the open. The history is part of the project, so please keep it tidy.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Operational – the version in daily use. Never commit directly. |
| `rnd` | R&D – where features are built and tested. Never commit directly. |
| `feature/<area>-<name>` | One feature, created from `rnd`. Area is one of `api`, `web`, `shared`, `infra`, `catalog`, `demo`. |
| `fix/<name>` | A bug found on R&D, from `rnd` back into `rnd`. |
| `hotfix/<name>` | An urgent bug on Operational: from `main`, merged into `main`, then merged back into `rnd`. |

```
feature/<area>-<name> ──PR──▶ rnd ──release PR──▶ main
                               ▲                    │
                               └─── merge back ─────┘ (after hotfixes)
```

## Merging

- **Feature and fix PRs into `rnd`:** squash merge, once CI is green. The squash commit is one Conventional Commit whose body is the PR summary.
- **Release PRs `rnd` → `main`, and hotfix merge-backs:** merge commit (no squash), so the branches never diverge. Releases carry a version tag (`v0.1`, `v0.2`, …) and release notes. The owner approves and merges every release.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- A PR describes what changed, why, how to test it, and includes a screenshot for UI changes. It links its issue ("Closes #n").
- CI must pass: lint, type-check and tests for each of `web`, `api` and `shared`, and the `db` tests against real Postgres.

## Ready to release

- CI is green and the relevant acceptance tests from the spec pass.
- It has run on the R&D environment and been tried there.
- Database migrations are backward compatible (additive) and have run on the `rnd` schema first.
- Anything unfinished stays behind a feature flag that is off.
- Release notes are written.

## Rules

- **No secrets in the repo.** `.env.example` holds names only. Secret scanning runs in CI.
- **No invented facts** in catalog data or docs: unverified links and prices are marked "needs check".
- Don't build anything listed as deferred in `docs/SPEC.md` section 12.1; the seams in 12.3 are the only preparation.

## Repository settings (maintainer checklist)

Set these in GitHub under **Settings → Rules → Rulesets**, which can allow a different merge method per branch. Nobody can approve their own pull request, so required approvals stay at 0; the protection comes from "pull request + passing checks".

**Ruleset `rnd`** (target: branch `rnd`)
- Restrict deletions and block force pushes.
- Require a pull request before merging: 0 required approvals, allowed merge method **squash** only, require conversation resolution.
- Require status checks: `shared`, `web`, `api`, `db`, `catalog-drift`, `gitleaks`, `analyze (javascript-typescript)`, `analyze (python)`, `e2e`. Don't require the branch to be up to date.
- `e2e` (Playwright, see `e2e/README.md`) is required since the owner's decision of 2026-11-14 (ADR 018). The owner adds it to the ruleset by hand; until then GitHub does not enforce it, and Claude checks that `e2e` passed before merging.
- No bypass actors.

**Ruleset `main`** (target: branch `main`)
- Restrict deletions and block force pushes.
- Require a pull request before merging: 0 required approvals, allowed merge method **merge commit** only. The owner presses the merge button on every release.
- Require the same status checks, and require the branch to be up to date.
- No bypass actors (hotfixes also go through a pull request).

**Ruleset `release tags`** (target: tags `v*`)
- Only repository admins may create, update or delete them.

**Other settings**
- Code security: turn on secret scanning with push protection, Dependabot alerts, and private vulnerability reporting (`SECURITY.md` points to it).
- General: automatically delete head branches after merge; turn off rebase merging.
- Actions: default workflow permissions "Read repository contents".

