# 004 – Free-tier AI with provider fallback, and AI as an optional extra

**Status:** Planned · built with practices (v0.3)

## Context
The app must cost nothing. A Claude subscription cannot be used by an app (no API), and the free tiers of AI providers have daily limits that can change (**needs check** against each provider's own documentation, including whether a card is required).

## Options
1. A paid API. Rejected: breaks the $0 rule.
2. One free provider. Fragile when its quota runs out.
3. Several free providers behind one interface, with automatic fallback, and a strong preference for not calling a model at all.

## Decision
Option 3, with AI strictly optional:
- An `AIProvider` interface; each implementation declares `costTier: free | paid`, and a guard refuses paid providers unless enabled in settings.
- **Deterministic first:** the rule-based plan builder is the default; templates write the day overview, the "why this is here" lines and LinkedIn posts; AI only improves them when the user asks (the plan builder's AI wording is the purpose `plan_explain`, on request only, with its own per-user and app-wide caps: see ADR 017 and `docs/api-plan-explain.md`).
- **Cache** responses by a hash of the PII-free input, repair broken JSON locally before spending a retry, and auto-grade what can be graded without a model (SQL exercises, quizzes).
- No personal details are ever sent to a model. Every user has a daily cap so one person cannot use the shared quota.

## Consequences
- The app is fully usable with every AI provider switched off.
- "AI calls avoided" is shown next to quota use.
- "Open in Claude" lets the user run a practice in their own account with no API use.
