# Upversion – course catalog & RAG seed data

Seed data for the Upversion plan builder (spec section 3.0): a verified course catalog, organized by **roles**, **skills** and **keywords**, plus everything needed to load it into Postgres and search it semantically.

Researched on 2026-10-29. Put this folder in the repo as `data/catalog/`.

## What's inside

| File | What it is |
|---|---|
| `catalog.json` | 178 learning items: 151 courses / certificate exams + 27 practice templates. Cost model, certificate type, recognition, hours, skills, roles, prerequisites, free alternatives, and verification flags. |
| `roles.json` | 27 target roles with aliases (job titles), summary, weighted skills (1–5), job-description keywords, and an auto-ranked suggested path (`core`, `optional`, `practice`, `free_only`). Roles added on 2026-11-01 also carry `sources` (O*NET / ESCO occupations, see Attribution) and an `overlap_note`. |
| `skills.json` | 59 skills in 14 categories, each with synonyms/keywords. This is the shared vocabulary for tagging courses, matching job descriptions and (later) reading a CV. |
| `questions.json` | The guided intake: 28 questions in 7 stages (goal, role discovery, background, skill check, time, budget, learning style), each with a "why we ask" hint, branching (`show_if`), and the field it fills (`maps_to`), plus 5 follow-up rules for conflicting answers. Discovery options map interests to roles. |
| `documents.jsonl` | 264 retrieval documents (one per item, role and skill), written as natural-language text ready to embed, with filterable metadata. |
| `schema.sql` | Postgres/Supabase schema: taxonomy, catalog, links, `rag_documents` with a pgvector column + HNSW index, keyword search (tsvector), and `match_catalog()` with budget / free-only / recognition filters. |
| `seed.sql` | Loads all of the above into the schema (idempotent – safe to re-run). |
| `catalog.csv` | The catalog as a spreadsheet, for quick review. |
| `build/` | Python source (`taxonomy.py`, `catalog.py`) and `build.py`, which validates references, runs the lint in `lint.py` and regenerates every file above. Edit the source, then run `python3 build.py` from `build/`. `test_lint.py` tests the lint (`python3 -m unittest test_lint` from `build/`). |

## Roles covered

**Operations & business:** Operations Associate / Analyst · Project Coordinator · Business Analyst · Supply Chain / Logistics Analyst · Finance Operations / Junior Financial Analyst · Revenue Operations / Sales Ops · People Operations / Recruiting Coordinator
**Product & data:** Product Operations / Junior PM · Junior Data / BI Analyst
**Technical:** Technical Operations / Support · QA Tester · Junior Cybersecurity / SOC Analyst · IT Support / Junior Sysadmin
**AI & automation:** AI Implementation / Deployment Specialist · No-code / AI Automation Specialist
**Customer-facing:** Customer Success · Sales Development (SDR/BDR) · Solutions Engineer / Pre-sales · Growth / Digital Marketing
**Added 2026-11-01 (batch 3, from O*NET / ESCO occupations):** Customer Support Specialist · Technical Support Specialist · Administrative Coordinator · Bookkeeper / AP-AR Clerk · Procurement Specialist · Marketing Coordinator · Technical Writer · Learning & Development Coordinator

The 19 original roles have at least 6 core items, a free-only path and 4 practice templates. The 8 roles added in batch 3 have no practice templates of their own yet (they get up to 3 shared ones), and three have thin pools: Bookkeeper has 3 core items, Technical Writer 3 and Learning & Development Coordinator 2 (and no free-only item at all: the research found no free, verified learning item for it). They are the next candidates to extend with new items or re-tagging. Several new roles overlap existing ones; each `overlap_note` says how to tell them apart and flags the open owner decisions (for example, whether Technical Support Specialist should merge into IT Support / Junior Sysadmin). `suggested_path` lists never contain an item without a url, and verified items score higher than unverified ones.

## How retrieval works (RAG)

1. **Embed** each line of `documents.jsonl` with a free, open embedding model run locally (e.g. `all-MiniLM-L6-v2` or `gte-small` via transformers.js – 384 dimensions, no paid API). Store it in `rag_documents.embedding`.
2. **Query:** embed the user's goal ("junior ops role, SQL and Jira, 4 weeks, free only"), then call
   `match_catalog(query_embedding, 20, max_price, free_only, min_recognition)`.
3. **Hybrid:** combine with keyword search on `catalog_items.search_tsv` and exact skill matching via `item_skills`, then rank.
4. **Generate:** pass only the retrieved items to the free LLM, which orders them into a plan and explains each choice. The backend then recalculates hours and cost from the database – never from the model's answer.
5. **Fallback without AI:** use `roles.suggested_path` plus skill matching – the plan builder works even with no model available.

## Data quality – read before using

- `url_verified` / `price_verified` = `true` means the URL or price was confirmed in a source found during research. After the 2026-11-01 link check and the batch 3 additions, **127 of 151** item URLs and **73 of 151** prices are verified; the rest follow the provider's known URL pattern but must be checked. A price is only marked verified when it is stated on the official page; a price that could not be confirmed keeps its earlier value with `price_verified: false` (notes say "Price unverified" where needed). `price: null` is used only where the price varies by country or is not known (15 of 151: the 9 earlier items, the SC-900, CompTIA A+, AIPB and Asana certification fees whose amounts no opened official page states, and TryHackMe and openSAP, whose prices are unknown); price-cap filters exclude those items. The app should show unverified items with a "needs check" badge until the weekly link checker confirms them.
- Prices change often (exams, subscriptions, Udemy sales). `price: null` means it varies by country – show "check price".
- `ai-900` is **superseded** by `ai-901`. The official certification page (checked 2026-11-01) lists AI-901 as the required exam and does not name AI-900, so the replacement is inferred. `ai-900` stays in the catalog but no role points to it; `ai-901` has `price: null` (varies by country) and its hours and recognition are Upversion estimates carried over from `ai-900`.
- `scrum-open` and `power-bi-learn-path` are prerequisites whose pages could not be reached on 2026-11-01. They are kept, stay `url_verified: false` and say `UNVERIFIED` in their notes; any plan that includes them must show "needs check". `ms-learn-data-analytics-microsoft` (batch 3) is a candidate replacement for `power-bi-learn-path`, but the prerequisite edges were not changed; the owner decides.
- **Subscriptions** (`cost_type: subscription`, e.g. Coursera Plus at $59/month) are stored as a monthly price. The plan builder must compute the real cost from how many months the plan uses them; `match_catalog`'s `max_price` filter compares the monthly price only.
- The `suggested_path` per role is generated by a simple score (skill weight + role tag + recognition). Each of the 6 best-scoring items brings its transitive **required** prerequisites into `core` as a bundle, prerequisites first, so `core` can hold more than 6 ids. It's a sensible starting point, not a curated career plan – review it per role.
- **Batch 3 items (56, added 2026-11-01).** The research proposed 59 items; `ai-901` was already in the catalog, and `servicenow-welcome-to-servicenow` (reported retired) and `google-digital-garage-digital-marketing` (old URL gone, no live replacement found) were left out. 48 of the 56 have `url_verified: true` (the official page was opened that day; for 3 more the page returned only a title, so they are stored as unverified: `cisco-cybersecurity-essentials`, `netacad-networking-essentials`, `kaggle-data-cleaning`). 5 have `url: null` and `url_verified: false` (page blocked or never found: `splunk-intro-to-splunk-elearning`, `opensap-building-tomorrows-erp`, `tableau-free-training-videos`, `tryhackme-soc-level-1`, `futurelearn-understanding-gdpr`); the lint requires `Needs check: url` in their notes and no `last_verified_at`, and the build keeps them out of every role path. Only 11 prices are verified (all free, stated on the page) plus the free SC-900 practice assessment. Coursera items: where the research saw "Included with Coursera Plus" on the page the note says so; for 10 items it did not, and the note says "Coursera Plus membership assumed; needs check". All are stored in the `coursera-plus` group at the group price with `price_verified: false`, and whether they can be audited is unconfirmed, so do not treat them as free. `rutgers-global-procurement-sourcing-spec` states that an enrollment fee applies. Other vendor items whose page states no price are stored as free (0) with `price_verified: false`; `tryhackme-soc-level-1` (premium content) and `opensap-building-tomorrows-erp` (possibly archived) have `price: null` and a non-free cost type so they never pass a price cap or land in a free-only path. 25 items state no duration; their hours are Upversion estimates (the note says so). HubSpot certification type and hours come from search listings and are marked "needs check". `recognition` is `low` unless noted (SC-900 and CompTIA A+ are `medium`): no source states it. Every item that is not fully verified says "needs check" in its notes. The AIPB exam needs about 2 years of bookkeeping experience, so it is never in `core`; the three title-only items are also kept out of `core`.
- Hour estimates are approximate and should be recalibrated from users' actual hours (spec 3.4).

## Structure fields and lint

Added to every item (all additive; defaults mean "not set"):

| Field | Meaning |
|---|---|
| `prerequisite_kinds` | One entry per id in `prerequisites`: `required` (a plan must include it first) or `recommended` (order it first if both are in the plan, never add it on its own). Almost all prerequisites are `required`; batch 3 adds `google-technical-writing-two` after `google-tech-writing` (`required`, so One comes first in a plan) and two `recommended` order hints (`sc-900-practice-assessment` after `sc-900`, `sap-learning-sourcing-procurement` after `rutgers-procurement-basics`). In Postgres: `item_links.prerequisite_kind`. |
| `last_verified_at` | `YYYY-MM-DD` of the link check that confirmed `url_verified`, or `null`. Set to `2026-11-01` for the 89 items confirmed in that check (41 earlier items and 48 batch 3 items); `null` for items verified only in the earlier research pass and for unverified items. In Postgres: `catalog_items.last_verified_at date`. |
| `subscription_group` | Items that share one subscription (currently `coursera-plus`, 31 items). A plan pays for each month of a group once, not once per item. Members must agree on period and price. In Postgres: `catalog_items.subscription_group`. |
| `skill_depth` | Optional map of skill id to `beginner`, `intermediate` or `advanced`: how far the item takes that skill. Empty for every item; only the field and its validation exist. In Postgres: `item_skills.depth`. |

Learn-before-practice ordering for the same skill is a planner rule; this data only provides the prerequisite edges.

`build.py` fails (exit 1, nothing written) when:

- a prerequisite id does not exist, or an item lists itself;
- the prerequisites contain a cycle (the exact cycle is printed, e.g. `a -> b -> c -> a`; required and recommended edges both count);
- a role's `suggested_path.core` holds an item whose required prerequisite is missing from `core` or comes after the item;
- an item has `url_verified: true` but no `https://` url;
- `prerequisite_kinds`, `last_verified_at`, `subscription_group` or `skill_depth` are malformed;
- the `setup` flag on questions breaks the ADR 015 rules (see below).

`questions.json` entries may carry `setup: {order, ignore_show_if?, choices_only?, optional?, why?}`: the 8 first-time setup questions (ADR 015), checked by `lint.check_setup_questions`. Exactly 8, orders 1..8, type from `single, multi, weekdays, number, yes_no, multi_role, multi_skill`, no `show_if` without `ignore_show_if`, no `allow_other` without `choices_only`, no `privacy`. `setup.why` (optional string) replaces the question's `why` in setup only (e.g. when the plan-builder text mentions typing a value that setup does not allow).

## Main sources

- Google Career Certificates – grow.google/intl/europe/google-career-certificates
- Kaggle Learn micro-courses – kdnuggets.com/7-free-kaggle-micro-courses-for-data-science-beginners
- PSM I exam details – open-exam-prep.com/blog/psm-i-professional-scrum-master-exam-guide-2026
- HackerRank skills certifications – hackerrank-community-knowledge-base.help.usepylon.com/articles/2563639100
- Anthropic Academy – dev.to/amareswer/anthropic-academy-free-claude-courses-and-certificates-22ki
- AWS AI Practitioner – aguidetocloud.com/cert-compass/aws-ai-practitioner
- PL-300 – open-exam-prep.com/blog/pl-300-power-bi-data-analyst-exam-guide-2026
- CAPM costs – rosemet.com/capm-certification-cost-breakdown
- Lean Six Sigma White/Yellow Belt – goleansixsigma.com/white-belt
- Free PM courses (Pendo, ProductLed, Google) – productcompass.pm/p/free-product-management-courses
- HubSpot Academy certifications – coursera.org/articles/hubspot-certification
- Customer success certifications – supademo.com/blog/customer-success-certifications
- Salesforce Administrator – open-exam-prep.com/blog/salesforce-administrator-exam-guide-2026
- Tableau Desktop Foundations – ascendientlearning.com
- Google Ads Search – certpath.pages.dev/certifications/google-ads-search
- Google Cloud Digital Leader – telecomtrainer.com/google-cloud-cloud-digital-leader
- Jira Fundamentals – community.atlassian.com (Jira Fundamentals learning path announcement)
- ISTQB CTFL price – astqb.org/istqb-faqs/what-is-the-price-of-an-istqb-exam
- ISC2 CC program conclusion – isc2.org/insights/2026/04/one-million-certified-cyber-conclusion
- CompTIA Security+ price – hackerdna.com/blog/security-plus-certification-cost
- GitHub Foundations – dev.to/hosana/github-foundations-certification-is-free-1mlk
- IIBA ECBA cost – adaptiveus.com/blog/ecba-certification-cost-in-2026
- HRCI aPHR – examcert.app/blog/aphr-requirements-2026
- Free automation courses (Make, n8n, Zapier, Power Automate, DeepLearning.AI) – analyticsvidhya.com/blog/2026/08/free-ai-automation-courses-with-certificates
- Linux Foundation free courses – careers360.com
- Cisco Introduction to Cybersecurity badge – credly.com/org/cisco/badge/introduction-to-cybersecurity
- Google Technical Writing – developers.google.com/tech-writing
- CFI 14-Day Fundamentals Challenge – corporatefinanceinstitute.com
- Sales certifications for SDRs – hyperbound.ai/blog/sales-certifications
- Recruiting certifications – recruiterflow.com/blog/recruiting-certifications
- Wharton Introduction to Financial Accounting – riseupp.com
- SHRM-CP cost and eligibility – aihr.com/blog/shrm-certification-cost
- University of Minnesota HR Management specialization – coursera.org/specializations/human-resource-management
- CFI FMVA price (Oct 2026) – onlinecourseing.com/cfi-fmva-certification-cost
- QuickBooks ProAdvisor and Xero Advisor – capterra.com (2017 article – verify)
- Apollo Academy courses – apollo.io/academy/guides
- `ai-901` was already in the catalog before batch 3, so the batch adds no second copy.
- Batch 3 (2026-11-01): the official provider pages named in each item's `url` (Microsoft Learn, HubSpot Academy, Zendesk, Salesforce Trailhead, Asana, Atlassian, Coursera, CompTIA, The Open University, Google, Semrush, Odoo, SAP Learning, Kaggle, Cisco Networking Academy, AIPB), plus the O*NET and ESCO occupation pages in the Attribution section.

## Attribution

Batch 3 (18 skills, 8 roles, 2026-11-01) was derived from public occupation data. Only short occupation titles, codes and paraphrased task themes were used; no O*NET text was copied.

- **O\*NET.** This work includes information from O\*NET OnLine by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/). O\*NET is a trademark of USDOL/ETA. Upversion has modified the information (mapped to Upversion skills and weights); USDOL/ETA has not approved, endorsed, or tested these modifications. The O\*NET database release was not checked for this work: needs check. Pages: `https://www.onetonline.org/link/details/<code>` for 43-4051.00, 43-6014.00, 43-3031.00, 13-1023.00, 13-1161.00, 27-3042.00, 13-1151.00, 13-1081.00, 15-1244.00, 15-1232.00, 15-1212.00, 13-1082.00, 15-2051.01, 13-1111.00.
- **ESCO.** This service uses the ESCO classification of the European Commission. ESCO-derived mappings here are adapted by Upversion and are marked as modified. ESCO occupations were read through the public ESCO web API; preferred labels appear unchanged in the `sources` of each new role. The ESCO version and the exact reuse licence were not recorded: needs check.
- Each new role lists its occupations in `roles.json` under `sources`. The role weights and aliases are Upversion's mapping from those occupations and need an owner review against real job postings; `jd_keywords` are Upversion wording.
- CC BY 4.0 asks for attribution only (no share-alike): keep the notice above with any copy of the new roles and skills.

New skills and the occupations that support them (all occupation pages were opened on 2026-11-01):

| Skill | Main source occupations |
|---|---|
| `erp-systems` | O*NET 13-1081.00, 13-1023.00, 13-1111.00, 43-3031.00; ESCO project manager, supply chain manager |
| `customer-service` | O*NET 43-4051.00; ESCO customer service representative, call centre agent, ICT help desk agent |
| `ticketing-helpdesk` | O*NET 15-1232.00; ESCO ICT help desk agent |
| `office-administration` | O*NET 43-6014.00; ESCO administrative assistant |
| `bookkeeping-accounting` | O*NET 43-3031.00; ESCO bookkeeper, billing clerk |
| `procurement-sourcing` | O*NET 13-1023.00; ESCO purchasing manager, supply chain manager |
| `demand-inventory-planning` | O*NET 13-1081.00; ESCO supply chain manager, logistics and distribution manager |
| `data-privacy-confidentiality` | ESCO call centre agent, ICT help desk agent, administrative assistant, recruitment consultant, human resources assistant, data entry clerk (inferred from several occupations: needs check) |
| `change-management` | O*NET 13-1111.00, 13-1082.00; ESCO ICT business analyst, ICT project manager, project manager, supply chain manager (no role or item uses it yet) |
| `stakeholder-management` | O*NET 13-1082.00, 13-1111.00; ESCO project manager, ICT business analyst |
| `work-management-tools` | O*NET 13-1082.00, 13-1161.00, 43-6014.00 |
| `windows-m365-admin` | O*NET 15-1244.00, 15-1232.00; ESCO ICT security administrator, ICT system administrator |
| `security-monitoring-siem` | O*NET 15-1212.00; ESCO ICT security administrator |
| `content-social-marketing` | O*NET 13-1161.00; ESCO online community manager, marketeer |
| `market-research` | O*NET 13-1161.00; ESCO market research analyst |
| `data-cleaning-etl` | O*NET 15-2051.01; ESCO data entry clerk |
| `negotiation` | O*NET 13-1023.00; ESCO purchasing manager, project manager (the sales-side use is not backed by a sales occupation page: needs check) |
| `training-facilitation` | O*NET 13-1151.00; ESCO corporate training manager |
