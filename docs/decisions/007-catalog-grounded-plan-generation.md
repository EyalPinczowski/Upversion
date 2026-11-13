# 007 – The AI picks from a verified catalog

**Status:** Planned · built with the plan builder (v0.5)

## Context
Language models invent courses, links and prices. A study plan built on invented links is worse than none.

## Options
1. Let the model suggest courses from memory.
2. Retrieve candidates from a curated catalog and let the model only choose, order and explain them.
3. No model at all, only rules.

## Decision
Option 2, with option 3 as the default and the fallback. The catalog (`data/catalog/`) is curated data with verification flags: an item with `url_verified: false` or `price_verified: false` is shown with a "needs check" badge and never presented as verified. Retrieval is hybrid (embeddings made locally with a free open model, keyword search and exact skill match). Cost and hours are always recalculated by the backend from catalog data, never taken from a model's answer. An item the model suggests that is not in the catalog is marked "Unverified – check before adding" and has no link.

**Amended by ADR 017:** in v1 the model does not choose or order items. The rule-based builder does (always the default path above), and a model may only rewrite explanation text on request. See [ADR 017](017-plan-builder.md).

## Consequences
- Every link in a plan comes from the catalog or from the user.
- The catalog needs upkeep: a weekly link check, and verification against providers' own pages. Generated catalog files are never edited by hand; CI fails if they drift from their build scripts.
