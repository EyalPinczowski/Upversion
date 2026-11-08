# Upversion – Build Spec

*Upversion – build your skills, one block at a time.*

> Paste this document into Claude Code. Before writing any code: (1) save it as `docs/SPEC.md` in the repo, (2) create a `CLAUDE.md` that points to it as the project's source of truth, (3) read all of it, present a short work plan, and ask me the questions in section 13.

---

## 1. What we're building

A web app (PWA) that turns a learning goal into a working study plan – and then runs that plan day by day.

1. **Plan:** I say what I want to achieve ("get a junior Ops role", "learn SQL", "pass AWS Cloud Practitioner") or which skills I want, plus how much time I have. The app suggests a learning path – courses, certificates, practice – sized to the time period I set.
2. **Run:** the app becomes the **single entry point** for that plan: from it I see what to do today, open every lesson, practice, wrap up the day – and it reschedules everything else based on what actually happened.

The owner's own study plan (section 7) is the first plan in the system, and the first real test of the plan builder.

**Name:** Upversion. Tagline: "build your skills, one block at a time". Use the name consistently: app title, PWA name, calendar names, repo, README.

**Two goals:**
1. **A real working tool** that I use every day in November 2026.
2. **A portfolio project** – clean code on GitHub, an organized development history, a professional README, and a demo mode I can show employers.

**Success metrics** (shown on a small "App health" card in Settings, and summarized in the README):
- **Usage:** I opened the app on every study day, and submitted a day review on at least 90% of them.
- **Planning accuracy:** actual hours vs. estimated hours per task type, and how it improved after accepted adjustments.
- **Outcome:** certificates earned vs. planned; anchor exams taken on their original date.
- **Performance:** a reschedule completes in under 2 seconds; the dashboard loads in under 2 seconds on the tablet (excluding backend cold start, which is measured separately).
- **Reliability:** zero calendar writes outside the "Upversion" calendar; zero lost practice feedback.
- **Plan builder quality:** for my own goal, the generated plan covers the same core certificates as the owner's hand-made reference plan (section 7); I keep at least 70% of suggested items without removing them.

**Users:** anyone who signs up with their email. Every user has their own account, and all their data – intake answers, plans, progress, reviews, practice feedback and the courses they add – is saved to that account and visible only to them. I am the first user and the admin. Plus a **public demo mode** with sample data that needs no sign-in (section 10).
**Devices:** Android tablet, phone, and desktop. Touch-friendly, installable (PWA).
**Language:** the entire app – UI, content, code, comments, commits and docs – is in **English**.

---

## 2. Core principle: dynamic scheduling, not a fixed timetable

The plan is **not** a list of "on day X, do Y". It is:
1. **An ordered task list** – each task has an hour estimate, a type, and dependencies.
2. **Daily capacity** – how many study hours each day has.
3. **A scheduling engine** that distributes tasks across days according to capacity, order and dependencies.

Every change (an unfinished task, a calendar event, changed hours, an added day, end-of-day feedback) triggers a **reschedule** from today onward. Past days never change.

---

## 3. Features

### 3.A Accounts – sign in before starting
**Nothing starts without an account.** The first screen for a new visitor is sign-in; the guided intake (3.0) begins only after it. The public demo (section 10) is the one exception.

**Invite-only, with "Request access":** Upversion starts as a closed beta. Only approved emails can create an account.
- **Request access** (public page): email, name (optional), what they want to achieve (one line, chosen from the goal types in the intake), and how they heard about Upversion. Protected by Turnstile (below). The visitor sees "Thanks – you're on the list" and gets a confirmation email.
- **Access requests queue** in the admin console (3.B): pending / approved / declined, with the request date and the short answers. Approve or decline with one click, or in bulk.
- **On approval:** the email is added to the allowlist and the user receives an invite email with a sign-in link. On decline: an optional, polite email ("we're not adding new users right now").
- **Invite directly:** the admin can also invite an email without a request, or generate a single-use invite link (expires after 7 days).
- **Capacity setting:** a maximum number of active users (default 25), so the beta stays within the free limits. When it's full, the request page says so and keeps collecting requests.
- An email that isn't approved can't create an account, even through "Continue with Google".
- `docs/FUTURE.md` notes how to switch to open sign-up later (a config flag), once free limits and Google verification allow it.

**Bot protection:** Cloudflare **Turnstile** (free) on the sign-in and request-access forms, using Supabase Auth's built-in CAPTCHA support. Also basic rate limiting per IP on both forms.

**Sign-in methods:**
- **Email with a one-time code or magic link** (default): enter an email, receive a 6-digit code or a link, done. No password to remember or leak.
- **Continue with Google** as a second option – one tap on Android.
- Optional later: email + password. Not in v1.0.

**What the account holds:** the user profile, intake sessions, all plans (active, drafts, archived), schedules, logs, day reviews, practice sessions and feedback, recommendations, the user's own catalog items, settings, and the calendar connection. Everything is tied to the account's `user_id`.

**Isolation – enforced by the database, not only the code:**
- **Row Level Security (RLS)** on every user-owned table: a row can be read or written only when `user_id = auth.uid()`. Even a bug in the backend can't return another user's data.
- The shared seed catalog (`user_id is null`) is readable by every signed-in user and writable only by the admin. Items a user adds are private to them.
- The backend verifies the user's session token on every request and never accepts a `user_id` from the client.
- **Making RLS actually apply when the backend queries the database:** the backend's database roles (`app_prod`, `app_rnd`) must not own the tables and must not have `BYPASSRLS`. For each request the backend runs its queries in a transaction that sets the verified user's claims (e.g. `set_config('request.jwt.claims', …, true)` and `set role authenticated`, or uses the Supabase client with the user's JWT), so `auth.uid()` resolves to that user. Admin and background jobs use separate, explicitly named paths. A test proves a query without a user context returns nothing.
- **Auth is shared between environments:** Supabase Auth lives in one project, so R&D and Operational share the same user accounts (data stays separated by schema). R&D sign-in is restricted to an **allowlist** (me and invited testers).

**Sessions and devices:** stay signed in on the tablet, phone and desktop at the same time; sessions refresh automatically; "Sign out" and "Sign out of all devices" in Settings.

**Account control (required, also for privacy law):**
- **Export my data:** a JSON download of everything in the account.
- **Delete my account:** removes all the user's data, revokes the calendar connection, and deletes the Upversion calendar events the app created. Confirmed with a typed confirmation, completed within the same request.
- **Legal pages:** a **Privacy Policy**, **Terms of Use** and a short **disclaimer** – drafts are provided in `docs/legal/` (see section 3.C). They're linked from the sign-in page, the request-access page and Settings, and the user accepts the Terms once at sign-up (the acceptance and version are stored).

**Roles:** `user` (default) and `admin` (me). The admin account is created by a one-time setup script that promotes my email to `admin` – there is no "become admin" option in the app.

### 3.B Admin console – the users database
A separate area of the app, visible only to the `admin` role, for running Upversion as a product.

**Users table** (searchable, sortable, filterable, exportable to CSV):
- Account: email, display name, sign-up date, last active, sign-in method, devices count, status (active / inactive 14+ days / deleted).
- Goal: goal type, target role(s), plan period, budget type (free / limit / flexible) – from the confirmed intake.
- Progress: active plan, % complete, hours logged vs. planned, on track / behind, certificates earned vs. planned, day reviews submitted.
- Usage: AI requests today and this month, plan generations, practices completed, calendar connected (yes/no).
- Filters such as "behind schedule", "inactive 7+ days", "target role = Data Analyst", "free-only budget".

**User detail page:** everything above for one user, plus their plan as a timeline (items, status, dates) and their activity history.

**Aggregate dashboards:** sign-ups over time, active users, intake completion rate (and where people drop off, by stage), most-chosen roles and skills, most-added courses, catalog items with broken links, free-quota usage per AI provider, average plan completion.

**Sensitive content – a deliberate tier:**
- **Tier 1 – always visible to admin:** everything listed above (account, goal summary, progress, usage). Disclosed in the privacy page.
- **Tier 2 – free-text and personal content:** background text, concerns, job postings, practice transcripts and feedback, day-review notes. Hidden by default in the admin console. Shown only when the user turns on **"Allow support access"** in Settings (e.g. when asking for help), and automatically switched off after 7 days.
- Every admin view of a user detail page or Tier 2 content is written to an **audit log** (who, which user, what, when). The user can see in Settings when their data was accessed.

**Access requests:** the queue from 3.A – approve, decline, invite, and set the user capacity.

**Admin actions:** edit the shared catalog and question bank; disable or re-enable an account; trigger a data export for a user who asks; delete an account on request; adjust a user's AI cap. No action can change a user's plan or answers on their behalf.

**How it's built:**
- Admin endpoints under `/api/v1/admin/...`, checked for the `admin` role on every request.
- The admin reads through **database views** (`admin_users_overview`, `admin_usage_daily`, …) and RLS policies that grant the `admin` role access to Tier 1 columns only; Tier 2 tables have an admin policy that also requires an active, unexpired support-access grant from that user.
- The admin console ships in the same frontend, lazy-loaded, and is never included in the demo build.

**Fair use of free resources:** AI calls are rate-limited **per user** (e.g. a daily cap on practice messages and plan generations), so one heavy user can't use up the shared free quota. The limits are shown in Settings.

**Limits to check during Phase 0 (free plans change):**
- Supabase Auth on the free plan (monthly active users, and especially the **email sending rate limit** of the built-in mailer, which is very low). If it's too low, connect a free SMTP provider for the codes and links.
- Google OAuth for **Calendar** with other users: an unverified app is capped at a small number of users and shows a warning screen. Calendar sync for everyone may require Google verification. Until then, keep calendar sync as an **opt-in** feature with a clear note, and offer every user an **.ics export** of their schedule as a free alternative.

### 3.C Legal pages and disclaimer
- Drafts in `docs/legal/`: `privacy-policy.md`, `terms-of-use.md`, `disclaimer.md`. Render them as pages in the app (`/privacy`, `/terms`), and show the disclaimer in short form under every generated plan and in the plan builder's summary.
- The texts contain placeholders in square brackets (contact email, effective date) – keep them visible until I fill them in, and don't invent legal details.
- Each document has a version and date. When the Terms change, users see a one-time "We've updated our Terms" notice and accept again.
- They are drafts written for a free beta, **not legal advice** – note this in the README.

### 3.D Accessibility
The app must be usable by everyone, including with a keyboard and a screen reader. Target **WCAG 2.2 level AA**.
- All functionality works with a keyboard only, with a visible focus state and a logical tab order. Drag-to-reorder (3.10) has a keyboard and button alternative ("Move up / Move down").
- Text contrast at least 4.5:1 (3:1 for large text and UI components), in both light and dark mode.
- Every form field has a visible label; errors are described in text and announced to screen readers, not shown by color alone.
- Status is never color-only: on-track / behind, done / not done, and the R&D badge also use text or icons.
- Charts on the dashboard have a text summary or data table alternative.
- Touch targets at least 44×44 px on the tablet and phone; text resizes to 200% without breaking the layout.
- Respect `prefers-reduced-motion`; no auto-playing animation.
- The practice chat is announced correctly to screen readers (new messages read out; the timer doesn't spam announcements).
- CI runs automated accessibility checks (e.g. axe with Playwright) on the main screens; a failure blocks the release PR. Automated checks catch only part of the issues, so each phase also gets a short manual keyboard pass.

### 3.0 Plan builder – from goal to plan (the entry point)
The flow a user goes through to create a plan. It can be run any number of times; each run creates a separate `Plan` (section 12.3 already puts `plan_id` on everything).

**Step 1 – Guided intake: questions before anything is suggested**
The app never jumps straight to courses. It first runs a short guided interview (about 5 minutes), so the plan fits the person – not just the keywords they typed.

- **Question bank as data:** the questions live in `data/catalog/questions.json` (28 questions, 7 stages), not in code. Each question has: the text, a short **"why we ask"** line shown under it, its type, options, `show_if` branching rules, and `maps_to` – the `Goal`, `UserProfile` or `WeekPattern` field the answer fills. Editing a question never needs a code change.
- **Stages, one screen at a time, with a progress bar:**
  1. **Goal** – what brings you here (new job, grow in role, a skill, a certificate, or "not sure"), target role or skills, why now, and an optional job posting to aim at.
  2. **Role discovery** (only if "not sure") – what kind of work you enjoy and your work style; the app then suggests 3–4 fitting roles from `roles.json`, and you pick one or two.
  3. **Background** – current situation (job searching, employed, student, in transition), a short free-text background, education, tools already used.
  4. **Skill check** – a matrix generated from the skills the target role needs (never used / basic / comfortable / could teach it), plus an optional 2-minute quick check (3 questions per top skill) for more accurate levels.
  5. **Time** – period, study days, hours per day (with realistic hints, e.g. "most people working full-time manage 1–2 hours"), best time of day, fixed dates.
  6. **Budget and certificates** – free only / limit / flexible, max price per item, how much certificates matter.
  7. **Learning style** – formats, languages, whether to include interview prep, courses you already want, and what usually gets in the way.
- **Adaptive:** questions that don't apply are skipped (`show_if`), and pre-filled answers come from earlier plans when they exist.
- **Follow-up questions** fire when answers conflict or leave a gap – for example "with this time the core plan won't fit – extend, add time, or keep only the essentials?", "most official certificates are paid – allow a few paid exams?", or "the job posting also mentions Tableau – add it?". These rules are in `questions.json` too.
- **Job posting matching:** if a posting is pasted, its text is matched against `skills.json` keywords (no AI needed) and the detected skills are shown for confirmation before they're added to the goal.
- **Two ways to answer:** a structured form (default, works with no AI), or a **conversational mode** where the free LLM asks the same questions in a chat and fills the same fields. Both produce the same structured answers; the chat can never skip a required question.
- **"Here's what I understood" summary** at the end: goal, roles, skill gaps, time, budget and preferences in plain sentences, each editable. Only after I confirm does the app build a plan.
- **Save and resume:** answers are saved after every stage, so I can stop and continue later.
- **Privacy:** free-text answers (background, concerns) have contact details stripped before any text reaches a model.

**Step 2 – Suggested plan:**
- The app builds a **draft plan**: an ordered list of courses, certificate exams and practice tasks, each with an hour estimate, dependencies and a short "why this is here" line tied to the goal.
- **Source of courses – the catalog (see below), not the model's memory.** The AI chooses, orders and explains items from the catalog. It may suggest an item that isn't in the catalog, but it is clearly marked **"Unverified – check before adding"** and has no link until I add one.
- **Must-include items** I added are always in the plan; the builder plans around them.
- **Budget check:** the plan's total cost must stay within the price limit. Cost is **recalculated by the backend** from catalog prices – never taken from the AI's answer – and a draft that goes over the limit is rejected and regenerated (or trimmed by the rule-based builder).
- **Fit check:** total hours vs. capacity in the chosen period. If it doesn't fit, the app says so and offers: extend the period, add hours or days, or drop lower-priority items (each item is tagged **core** or **optional**).
- A summary at the top: total hours, number of certificates, **total cost vs. my price limit**, projected finish date, and the skills covered vs. the skills I asked for (with any gaps listed).

**Free option – always offered:**
- Next to every paid item: **"Free alternative"** – the best free catalog item that teaches the same skills, with a one-line trade-off ("free, but no official certificate", "free to audit; certificate costs $49").
- A **"Make this plan free"** button: builds a $0 version of the same plan by swapping every paid item for its best free alternative. Shown side by side with the paid version: hours, certificates, recognition level and skills covered, so I can see exactly what I give up (usually: official certificates).
- If no free alternative exists for an item, say so plainly ("no free equivalent – this is an official paid exam") instead of suggesting something weaker without saying it.
- Many paid courses can be audited for free (e.g. Coursera audit mode). These are catalog entries with cost type `free_audit` – free to learn, paid only for the certificate.

**Step 3 – Review and adjust:**
- Remove, add (from the catalog or manually), reorder, change estimates, mark core/optional.
- "Regenerate" with a short instruction ("less theory, more practice", "free courses only").
- **Nothing becomes a real plan until I press "Start this plan".** Then it is scheduled by the engine (3.6) and appears on the dashboard. Every plan change after that is a suggestion I approve (3.4).

**How the plan is generated:**
- Uses the free LLM through the `AIProvider` layer (3.3) – the model returns a structured plan (JSON, validated with Zod, with the same retry-then-fallback rule).
- **Rule-based fallback** when the AI is unavailable: match catalog items by skill tags and level, order them by prerequisites, and trim to capacity. The plan builder must work, in a simpler form, with no AI at all.
- The prompt receives only the intake answers and the catalog entries – no personal identifying details.

**The course catalog:**
- A curated list of verified learning resources, stored in the database and editable in the app. Each entry: title, provider, URL, skills taught (tags), level, estimated hours, cost, certificate type (`none` / `completion` / `official exam`), how recognized the certificate is (`low` / `medium` / `high`), prerequisites, format, language.
- **Seed data is provided** in `data/catalog/` (researched separately): 121 items across 19 roles and 41 skills, with `catalog.json`, `roles.json`, `skills.json`, `questions.json` (the guided intake), `documents.jsonl` (ready to embed), `schema.sql` (pgvector + keyword search + `match_catalog()` with budget filters) and `seed.sql`. Read its README first – it marks which URLs and prices are verified. Unverified entries are shown with a "needs check" badge until the link checker confirms them.
- **Retrieval (RAG):** embed `documents.jsonl` with a free open model run locally (384 dimensions, e.g. all-MiniLM-L6-v2 via transformers.js – no paid API), store in `rag_documents`, and retrieve with hybrid search (vector + keyword + exact skill match). The LLM only sees retrieved items.
- **Link checker:** a scheduled GitHub Action checks catalog URLs weekly and flags broken ones in the app.
- I can add entries manually at any time, including from the "Unverified" suggestions above.

**Adding courses myself:**
- **Where:** in the goal wizard (step 1), in the review step (step 3, "Add my own"), and in the Catalog screen.
- **Quick add from a link:** paste a URL; the backend tries to read the page title and description (a simple server-side fetch, no paid service), and I fill in or correct the rest. If the page can't be read, I fill everything manually – never blocked.
- **Fields:** title, provider, URL, skills (tags, with suggestions), level, estimated hours, **cost type and price**, certificate type, format, language. Only title and estimated hours are required; the rest can be filled later.
- **Where it lives:** saved to my catalog, marked **"Added by me"**, so it's reusable in future plans, not just this one. I can choose "this plan only" instead.
- **In the plan:** a manually added item is scheduled like any other and can have dependencies; the builder respects it and doesn't remove it unless I do.
- Practice templates (mock interview, home assignment, Excel test…) are catalog entries too, of type `practice`, so the builder can mix them into any plan.

**Multiple plans:**
- One plan is **active** at a time (the dashboard runs it). Other plans can be drafts or archived.
- A finished plan keeps its history and results (hours, certificates, scores), which can inform the next plan ("last time, courses took you 30% longer than estimated").


### 3.1 Progress dashboard (home screen)
**Daily view:**
- Today's tasks: open, in progress, done – with estimated vs. actual hours.
- Today's hours: planned vs. completed, and what's left.
- A prominent "Start study day" button (opens the day briefing, 3.2).

**Weekly view:**
- Week progress: tasks completed out of planned, actual vs. planned hours, a daily chart.
- **Open tasks** – everything planned for the week that isn't done yet, including tasks carried over from earlier days (clearly marked).
- Trend: am I ahead, on track, or behind, plus a projected finish date.

**Always visible:**
- Overall progress for the month, and a counter of certificates earned out of the total.
- A prominent warning if an anchor exam is at risk (the tasks before it won't fit in time).

### 3.2 Day briefing
When I start a study day, a briefing screen opens:
- **Day overview:** 2–3 sentences on what today is about and why – how it connects to a certificate or a role I'm targeting. Generated by the free LLM through the same `AIProvider` layer as practices (3.3): **one request per day**, cached, using only task metadata (no personal data). If the call fails or the quota is used up, a template built from the task list is shown instead – the briefing never waits on the AI.
- **For each task:**
  - Course: a direct link to the **specific lesson or module** (not just the course home page), what it covers, and how long it should take.
  - Practice: what to do, how, how long, and what success looks like.
  - **A ready-made prompt** for practices that need one – already tailored to today (e.g. including the job description of the user's next interview, if entered). "Copy" and "Run here" buttons (3.3).
- **Suggested order for the day**, with times (based on the start time and calendar events).
- **Idea of the day (added 1 Nov 2026, owner decision):** one podcast about the ideas around my skills, not a lesson, with a link to the show on Spotify. Chosen by a fixed rule from the plan's skills and the date (no AI, nothing about me leaves the app); not a task and not counted as study time. Only shows whose links were verified are listed (`data/podcasts/`); on days with no fit, nothing is shown.

### 3.3 Running practices inside the app – with a free AI model
**Constraint: the app is completely free.** No Claude API and no paid API of any kind. A Claude Pro subscription can't be connected to the app (it has no API), so in-app practice runs on **a model with a free tier**.

**In-app practice window:**
- A chat inside the practice screen. Each practice type has its own persona as a system prompt: behavioral interviewer, case interviewer, home-assignment reviewer, Excel/SQL examiner.
- The model is called through the **backend only** (the key never reaches the browser).
- A timer based on the practice duration. At the end, the model returns **structured JSON feedback** (`score`, `strengths`, `improve`, `next_focus`), which is saved automatically under the practice and feeds the dashboard and the day review.
- `next_focus` is automatically injected into the next practice of the same type.
- **Feedback validation:** free models often return broken JSON. Validate it with the shared Zod schema; on failure, retry once with a "return valid JSON only" instruction; if it still fails, save the raw text as free-text feedback (same fallback as the pasted block below). A practice is never lost because of bad JSON.
- Voice practice (optional, free): a mic button using the browser's Web Speech API for speech-to-text, and reading questions aloud with speechSynthesis.

**Model providers (one abstraction layer, provider switchable in settings):**
| Provider | Why | Free-tier limits (verify during the build) |
|---|---|---|
| **GitHub Models** (primary) | Strong models like GPT-4o, free with a GitHub account – fits a project that lives on GitHub | Daily and per-minute request quotas |
| **Groq** (fallback) | Very fast, doesn't train on your data | Roughly 1,000 requests per day |
| **Gemini Flash-Lite** (fallback) | Good quality | Daily quota; free-tier data may be used for training – so no personal data |

- **Automatic fallback:** if a provider returns 429 (quota), switch to the next provider and show me which model the practice continues on.
- **Usage meter** in settings: requests used today vs. quota for each provider.
- **Privacy:** never send personally identifying details (name, phone, email) to the model. Job descriptions and STAR stories are fine.
- **Don't invent limits:** check each provider's official docs during the build, and tell me if anything has changed or requires a credit card.

**Alternative: claude.ai (copy-paste).** Every practice also has an "Open in Claude" button: it copies the same prompt and opens claude.ai, for practices where I want Claude's quality. The prompt instructs Claude to end with a **feedback block in a fixed format**:
```
===FEEDBACK===
score: 7/10
strengths: ...
improve: ...
next_focus: ...
===END===
```
I paste the block back into the app; it parses and saves it just like feedback from the in-app chat. If parsing fails, it's saved as plain text, without an error.

**Dynamic prompts:** either way, the prompt is built from a template plus data in the app: practice type, the job description of the user's next interview (a field the user fills in), feedback from the previous practice, and the topics I studied this week.

### 3.4 End-of-day review
At the end of the day ("End day" button, or automatically on the first visit the next day):
- **What got done and what didn't:** for each task – done / partial (how many hours) / not done + a short reason (optional).
- **Feedback questions** (each on a 1–5 scale, quick to fill in by touch):
  - Difficulty of today's content
  - Day density (too light / just right / too much)
  - Energy / focus level
  - Free-text note
- **Adjusting the plan based on feedback** (transparent rules, not a black box):
  - "Too much" density two days in a row → suggest reducing daily capacity by one hour.
  - "Too light" → suggest adding an hour or pulling tasks forward.
  - Actual hours differ from estimates by more than 25% for a task type (e.g. Google PM courses) → suggest updating estimates for that type.
  - High difficulty on a topic → suggest adding practice time to the next task in the same area.
  - **Every adjustment is shown as a suggestion** with an explanation ("Courses are taking you 30% longer than estimated – update?"), and I accept or reject it. After accepting – reschedule and show a change summary.
- Review history is saved and shown on the dashboard (difficulty and density trends over the month).

### 3.5 System recommendations
Recommendation cards on the home screen and in the briefing, based on progress:
- **LinkedIn post:** after earning a certificate or at the end of a week – two options: (1) a **template** auto-filled from app data (certificate name, hours, what I learned – from task notes), to edit and copy; (2) a **ready-made prompt** for claude.ai with the same data, for a more personal post.
- **Further learning:** a video, article or reading related to today's or tomorrow's topic – from a list I maintain (title, link, topic, length). I can add items from inside the app.
- **Update CV and LinkedIn** after every certificate (see 3.6).
- **Smart reminders:** "Your PSM I exam is in 3 days – your last practice score was 82%, target is 90%."
- Every recommendation: "Done" / "Not relevant" / "Later". Dismissed recommendations don't come back.

### 3.6 Progress tracking and the scheduling engine
- Marking a task: done / partial (how many hours) / skipped. Logging actual hours and a short note (e.g. a practice-exam score).
- Tasks are scheduled in order, subject to dependencies.
- A day is never filled beyond its capacity. A task larger than the remaining capacity **splits** across days (courses – allowed; exams and mock interviews – not allowed).
- **Anchor tasks** (official exams) stay on their date. If the tasks before them don't fit – a warning with 3 options: add hours, add a day, or move the exam.
- Non-study days get no tasks. Study days come from the user's intake answers (for example Sunday–Thursday).
- After a certificate is completed, a task is created automatically: "Update CV and LinkedIn: [certificate name]" (15 minutes, same day).
- Every reschedule shows a **change summary** before saving ("3 tasks moved, plan finish pushed back by one day").

### 3.7 Time settings
All of these are edited on the Plan page, in the 'Plan settings' tab, and every change triggers a reschedule (with a change summary).

**Weekly pattern:**
- **Days per week:** pick which weekdays are study days (pre-filled from the intake; the default suggestion follows the user's locale – Sunday–Thursday in Israel, Monday–Friday elsewhere). The screen shows the resulting count ("5 days per week").
- **Hours per day:** a default (from the intake; for example 7), with an optional override **per weekday** (e.g. Thursday: 5 hours).
- **Daily window:** earliest start and latest end (pre-filled from the intake's "best time of day"; for example 09:00–17:30). Study blocks are never scheduled outside it.
- **Breaks:** a fixed lunch break (default 13:00–14:00) and an optional short break after every X hours of continuous study (default: 10 minutes after 2 hours).
- **Minimum block length:** default 30 minutes. The scheduler never creates a study block shorter than this – leftover gaps around calendar events stay empty rather than becoming 15-minute fragments.

**Exceptions:**
- Change hours for a specific date ("only 4 hours tomorrow").
- Add a one-off study day (e.g. a specific Friday) or remove one (a day off).

**Exams and fixed-time tasks:**
- Anchor tasks (exams) have a **date and a start time**, not just a date. The scheduler places them exactly there and schedules other work around them.
- Any task can optionally be pinned to a specific time.

**Validation:** if the settings make the plan impossible (e.g. capacity drops below what the anchors need), the change summary says so before saving and offers the 3 anchor options (3.6).

### 3.8 Calendar (Google Calendar API)
The principle: **the app manages only the events it created itself. All other events are view-only.**

**The app's own events (read and write):**
- A dedicated secondary calendar named "Upversion". All study blocks are created there only.
- Create, move, change and delete these events on every reschedule, with no duplicates (each block maps to exactly one event by event id).
- Every event is tagged with `extendedProperties.private` (`source=<APP_EVENT_SOURCE value>`, `task_id=...`).
- If the user moves a study block directly in Google Calendar – on sync the new position is locked as my decision, and everything else is rescheduled around it.

**All other events (view-only):**
- Read from my other calendars, shown in the app's calendar view, and subtracted from capacity **only if they really block my time**:
  - Counted as busy: events I organized or **accepted**, marked "Busy".
  - Not counted: events I **declined**, invitations I haven't answered, events marked **"Free"** (transparency = transparent), and **"Maybe"/tentative** events (shown in the calendar view with a dashed style, so I can decide).
  - All-day events: not counted by default (birthdays, holidays), except ones I mark as blocking (see below).
- Busy events are subtracted from capacity. A 2-hour interview on Sunday → 5 study hours instead of 7, with study blocks scheduled around it.
- **The app must never change, move or delete an event it didn't create.** Two layers of protection:
  1. **Minimal OAuth scopes:** `calendar.app.created` + `calendar.readonly` only. No full `calendar` scope.
  2. **In code:** every write goes through a single function that checks the event is in the "Upversion" calendar and tagged as the app's own; otherwise it throws. With a unit test.
- All-day event (e.g. "Vacation" or "Conference") → option to have it cancel the study day.
- External event content is not stored beyond what's needed (title and times).

**Keeping the calendar connection alive (OAuth):**
Calendar scopes are "sensitive". While a Google OAuth app is in **Testing** status, its refresh tokens expire after 7 days – the sync would silently break every week. The fix:
- **Publish the OAuth app to "In production" status** in Google Cloud, **without** Google verification at first. This removes the 7-day expiry; users see a one-time "Google hasn't verified this app" warning, and an unverified app is limited to a small number of users. That's fine for me and a small group of testers. **Before opening calendar sync to the public, the app must pass Google verification** (privacy policy, domain, and a review of the scopes) – until then calendar sync is opt-in with the .ics export as the alternative (3.A). Confirm the current rules in Google's docs during Phase 0.
- **Fail loudly, never silently:** if a token is ever rejected (`invalid_grant`), the app shows a "Reconnect calendar" banner with one-tap reconnection, and keeps working on its own data in the meantime. The schedule never depends on the calendar being reachable.
- Refresh tokens are stored encrypted in the backend only.

**Sync:** on every app open, via a "Sync now" button, and after every reschedule. A new event that conflicts with a study block → the block moves, and I see what changed in the summary.

### 3.9 Course and certificate library
- All courses and certificates: provider, link, cost, status, date earned.
- "For my CV": a copy-ready list of earned certificates, formatted for an English CV.

### 3.10 Plan editing
- Add, edit, delete and reorder (drag) tasks; change hour estimates; add lessons and links to a task.
- Every edit → reschedule.

---

## 4. Data model (suggested)

Every user-owned entity below also has `user_id`, and every plan-scoped entity has `plan_id` (12.3) – omitted from the list for readability. A `PlanItem` belongs to a draft plan; on "Start this plan" each one becomes a `Task` that the scheduler places.

```
Task
  id, title, type: course | cert_exam | practice | admin | cv_update
  provider, url, est_hours, done_hours
  status: pending | in_progress | done | skipped
  order, depends_on: [task_id]
  is_anchor, anchor_date, anchor_start_time, pinned_start, splittable
  is_certificate, certificate_name
  lessons: [{title, url, est_minutes, summary}]
  how_to_steps: [string], prompt_template: string, practice_kind
  notes

WeekPattern      study_weekdays: [0-6], default_hours, hours_by_weekday {weekday: hours},
                 window_start, window_end, lunch_start, lunch_end,
                 break_every_hours, break_minutes, min_block_minutes, timezone
DayOverride      date, is_study_day, capacity_hours (overrides WeekPattern for one date)
Schedule         (computed) date → [{task_id, hours, start, end, locked}]
CalendarSync     block → google_event_id, last_synced_at
Log              date, task_id, hours, result, score, note
DayReview        date, difficulty 1-5, density 1-5, energy 1-5, note
Adjustment       date, rule, suggestion, accepted: bool
Recommendation   id, kind: post | content | cv | reminder, payload, status
ContentItem      title, url, topic, minutes, type: video | article | reading
User             id (= auth user id), email, display_name, role: user | admin, status: active | disabled | deleted,
                 created_at, last_seen_at, support_access_until (null = off),
                 ai_usage_today {practice_messages, plan_generations}
AccessRequest    id, email, name, goal_type, source, status: pending | approved | declined, created_at, decided_at, decided_by
Invite           id, email | null (link invite), token_hash, expires_at, used_at, created_by
LegalAcceptance  user_id, document: terms | privacy, version, accepted_at
AdminAuditLog    id, admin_id, user_id, action (view_detail | view_tier2 | export | disable | delete | edit_cap), at
IntakeSession    id, user_id, current_stage, answers {question_id: value}, status: in_progress | confirmed, updated_at
UserProfile      user_id, status, background, education, tools [..], skill_levels {skill: 0-3}, interests, work_style, concerns
Goal             id, plan_id, goal_text, target_skills [{skill, current_level}],
                 background, start_date, end_date | duration_weeks,
                 budget_total, budget_currency, max_item_price, free_only: bool,
                 must_include [catalog_item_id], cert_preference, formats, language, fixed_dates
Plan             id, user_id, goal_id, status: draft | active | archived | done,
                 created_from: builder | import, summary {hours, certs, cost, finish}
CatalogItem      id, user_id, title, provider, url, type: course | cert_exam | practice,
                 skills [tag], level, est_hours,
                 cost_type: free | free_audit | one_time | subscription,
                 price, currency, subscription_period (e.g. month),
                 certificate_price (for free_audit), free_alternative_ids [id],
                 added_by: seed | me, certificate_type,
                 recognition: low | medium | high, prerequisites [id],
                 format, language, verified: bool, last_link_check
PlanItem         plan_id, catalog_item_id | null (manual), priority: core | optional | must_include,
                 reason (why it's in the plan), order
PracticeSession  task_id, started_at, duration, prompt_used, raw_feedback,
                 feedback {score, strengths, improve, next_focus}
```

---

## 5. Tech stack (suggested – feel free to propose alternatives with reasons)

**Cost constraint: $0.** Every component must be on its free plan, and usage by a small group of users (tens, not thousands) shouldn't come close to its limits. Track usage against each free limit on the admin "App health" card. If any component requires a credit card or could incur charges – stop and ask me.

### Backend / frontend separation
The code is split into two separate parts in one monorepo:

```
/apps
  /web        Frontend – React + TypeScript (Vite), Tailwind, PWA
  /api        Backend  – Node.js + TypeScript (Fastify or Express), REST API
/packages
  /shared     Shared types, validation schemas (Zod), and the scheduling engine
/docs         Architecture, API docs
```

- **Frontend (`apps/web`):** presentation and UX only. Talks to the backend over REST only – no direct database access and no Google tokens.
- **Backend (`apps/api`):** all business logic – the scheduling engine, adjustment rules, feedback parsing, seed data, the AI layer for practices, and **all** communication with Google Calendar. OAuth tokens and AI keys live here only.
- **Shared (`packages/shared`):** types and schemas shared by both, so the API and the UI always agree on the data shape. The scheduling engine lives here as pure functions, with tests.
- **API docs:** OpenAPI (Swagger) generated from the schemas, with a docs page – this also looks good in a portfolio.
- Example endpoints: `GET /today`, `GET /week`, `POST /tasks/:id/log`, `POST /days/:date/review`, `POST /schedule/recompute`, `GET /suggestions`, `POST /calendar/sync`, `POST /practice/:id/message`, `POST /practice/:id/finish`, `POST /practice/:id/feedback`.

### Components
- Database: one Supabase project (Postgres) on the free plan, with a `prod` schema for Operational and an `rnd` schema for R&D, each with its own restricted role (section 6). Accessed by the backend only.
- Auth: **Supabase Auth** (free plan) – email one-time code / magic link and Google sign-in (3.A). Row Level Security on every user-owned table. The calendar OAuth connection is separate from sign-in and optional.
- Google Calendar API: `calendar.app.created` + `calendar.readonly` only (3.8). Free.
- Free-tier AI models only (GitHub Models / Groq / Gemini), via an abstraction layer in the backend with fallback (3.3). No Claude API.
- Free hosting, two environments (section 6): frontend on Vercel Hobby (production for `main`, a preview deployment for `rnd`). Backend – propose a free option (e.g. Render Free, or Vercel Functions as a separate project) with its pros and cons, including cold-start times on services that sleep.
- **Address:** the free Vercel address (`upversion-<something>.vercel.app` for Operational, a preview URL for R&D, a separate one for the demo). No custom domain in v1.0. Two consequences to plan for:
  - **Sign-in emails** are sent with Supabase Auth's built-in mailer. Its sending limit is very low, which fits an invite-only beta; a custom email provider usually requires owning a domain, so it's deferred.
  - **Google verification** (needed before calendar sync is opened to the public, 3.8) requires a domain I own. Until then, calendar sync stays limited to me and invited testers. Both items go in `docs/FUTURE.md`.
- PWA: manifest and service worker in the frontend.
- The scheduling engine and adjustment rules (3.4) as **pure functions**, with unit tests.
- All secrets (OAuth, API keys) in environment variables only. An `.env.example` file with no real values.
- **Time zones:** all timestamps stored in UTC; displayed and scheduled in **each user's own time zone** (detected from the browser at sign-up, editable in Settings; for example `Asia/Jerusalem`). Dates (e.g. a study day) stored as local dates, not timestamps. Tests include a daylight-saving boundary.
- **Backups:** the Supabase free plan has no point-in-time restore. A scheduled GitHub Action exports the `prod` schema daily, **encrypted** (e.g. with `age`, key stored only as a GitHub secret), to a private GitHub Actions artifact with 30-day retention – **never committed to a git repo**, because it now contains other users' personal data. A documented `restore` script is tested once on `rnd`. Deleted accounts disappear from backups within the retention window (stated on the privacy page).
- **Security basics:** the "quick add from a link" fetch (3.0) accepts only `https` URLs, blocks private/internal IP ranges, follows at most 3 redirects, and times out after 5 seconds; CORS locked to the app's own domains; rate limiting on the practice and AI endpoints; secret scanning in CI (e.g. gitleaks) so a leaked key fails the build; dependency updates via Dependabot.
- **Logging:** structured logs in the backend with a request id; errors include enough context to debug without logging personal data.

---

## 6. Git and GitHub

The code lives in a GitHub repo of mine, and **the history itself is part of the project** – anyone looking should see professional, organized development.

**Two environments: Operational and R&D**

The app is used every day during the sprint, so the version in use must stay stable while development continues. There are two long-lived branches, each with its own environment:

| | **`main` – Operational** | **`rnd` – R&D** |
|---|---|---|
| Purpose | The version I use daily | Where new features are built and tested |
| Deployment | Production URL (Vercel production + backend production) | Separate R&D URL (Vercel preview + backend R&D instance) |
| Database | `prod` schema – my real data | `rnd` schema – seed and test data. Same Supabase project, separate schema (see below) |
| Google Calendar | Writes to the "Upversion" calendar | Writes only to a separate "Upversion (R&D)" calendar, so experiments never touch my real schedule |
| AI providers | Real keys | Separate keys where possible, so R&D testing doesn't use up the operational quota |
| Stability | Always working. No direct commits. | May be unstable. Breaking things here is fine. |

The environment name is shown in the app header in R&D (e.g. an "R&D" badge), so I never confuse the two.

**Database isolation – one project, two schemas:**
- A single Supabase project (free plan) with two schemas: `prod` and `rnd`. Same table structure in both.
- **Two database roles:** `app_prod` with access to `prod` only, and `app_rnd` with access to `rnd` only. Each backend environment connects with its own role, so the database itself blocks R&D from reading or writing Operational data – even if the code has a bug.
- The schema is chosen by environment config (`DB_SCHEMA`, `DB_ROLE`), never hard-coded.
- Migrations take the target schema as an explicit argument and refuse to run without it. The release process runs them on `rnd` first, then `prod`.
- The Google Cloud project and OAuth setup are shared between environments; the separation is the calendar (above) and the data.

**Branch flow:**
```
feature/<area>-<name>  ──PR──▶  rnd  ──release PR──▶  main
                                  ▲                     │
                                  └──── merge back ─────┘ (after hotfixes)
hotfix/<name> ──PR──▶ main  (then merged back into rnd)
```
- **`feature/<area>-<name>`** – one branch per feature, created from `rnd` and merged back into it via Pull Request. The area marks the part of the code: `api`, `web` or `shared`. A feature that touches both – an `api` branch first, then a `web` branch built on it. Examples:
  - `feature/shared-types-schemas`
  - `feature/shared-scheduling-engine`
  - `feature/api-data-model-seed`
  - `feature/api-tasks-and-logs`
  - `feature/api-day-review-adjustments`
  - `feature/api-google-calendar`
  - `feature/api-practice-feedback`
  - `feature/web-dashboard`
  - `feature/web-day-briefing`
  - `feature/web-day-review`
  - `feature/web-practice-flow`
  - `feature/web-recommendations`
  - `feature/web-pwa-polish`
  - `feature/demo-mode`
- **`fix/<name>`** – bug fixes found in R&D, from `rnd` back into `rnd`.
- **`hotfix/<name>`** – an urgent bug in the operational version: created from `main`, merged into `main`, and then immediately merged back into `rnd` so the two don't drift.
- **Release:** when something is ready, open a release PR from `rnd` to `main`, with a version tag (`v0.1`, `v0.2`...) and release notes listing what's new. **I approve every release merge.**

**Definition of "ready to merge into Operational":**
- All CI checks pass (lint, type-check, tests).
- The relevant acceptance tests from section 9 pass.
- It has been running on the R&D environment and I've tried it there.
- Database migrations are **backward compatible** (additive: new tables/columns with defaults – no renames or drops in the same release), and have been run on the `rnd` schema first.
- No half-finished features reach `main` – anything incomplete stays behind a feature flag set to off (12.3).
- Release notes written.

**Releases don't have to wait for a whole phase.** A single finished feature can be released on its own. Phases (section 11) are milestones for planning, not release gates.

**Rules:**
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`), small and focused commits.
- Every PR has a description: what changed, why, how to test, and a screenshot for UI changes.
- GitHub Actions: lint, type-check and tests on every PR, separately for `web`, `api` and `shared`. A PR can't merge if checks fail.
- **No secrets in the repo** – check before every commit. A proper `.gitignore` from day one.
- I approve every merge into `main`.
- Branch protection on `main` and `rnd`: PR required, CI must pass.
- **End-to-end tests** with Playwright for the 3 core flows – start a study day, log progress on a task, end the day with a review – running in CI against the R&D environment (or the in-browser demo build), on every release PR.
- **Decision log:** a `docs/decisions/` folder with short ADRs (Architecture Decision Records), one per significant choice: context, options considered, decision, consequences. Start with:
  - `001-dynamic-scheduling-as-pure-functions.md`
  - `002-minimal-calendar-scopes-and-write-guard.md`
  - `003-one-supabase-project-two-schemas.md`
  - `004-free-tier-ai-with-provider-fallback.md`
  - `005-in-browser-demo-with-mocked-api.md`
  - `006-oauth-production-status-without-verification.md`
  - `007-catalog-grounded-plan-generation.md` (why the AI picks from a verified catalog instead of inventing courses)
  Write a new ADR whenever a decision changes direction. These are written for a non-engineer reader too – they're the "how I think" part of the portfolio.

**README (for the portfolio):**
- What the problem is and why I built this – in two sentences.
- Screenshots / GIF of the main flow.
- Key features, especially the scheduling engine and feedback-based adjustment.
- Architecture diagram (Mermaid).
- Main product and technical decisions – a short summary linking to the ADRs in `docs/decisions/`.
- Success metrics (section 1) with the actual results after the sprint.
- Demo link, local setup instructions.
- A note that it was built with Claude Code.

---

## 7. Seed data

The owner's own study plan is the first real plan in the system (`status: active`, `created_from: import`) and the reference test for the plan builder: given a goal like theirs, the builder should produce something similar. **Its content is personal, so it is kept in a separate private repository and not published here.** It is loaded through the same plan-import API as any other plan.

This repository ships a fictional sample plan in the same format, `data/sample-plans/demo-plan.json`, used by tests, the R&D environment and the demo.

The shape of the reference plan – what the scheduling engine and the tests must handle:
- A fixed period of about four weeks, five study days a week, around 7 hours a day starting at 09:00 – roughly 128 hours of tasks out of 140 available.
- About 30 ordered tasks of types `course`, `cert_exam`, `practice` and `admin`, with estimates from 15 minutes to 10 hours. Some courses also earn a certificate.
- Dependencies between tasks ("after task N"), one task with a "not before" date, non-splittable tasks (exams and mock interviews), and two anchor exams with a fixed date and start time near the end of the period.
- "Update CV and LinkedIn" tasks are created automatically (3.6) – don't seed them.
- **Lessons and links:** for each course, fill in the list of lessons/modules with direct links as they appear on the course site. Anything that can't be verified – mark it "needs check"; never invent a link.
- **How-to steps and prompts:** write a reasonable default for every practice; the owner edits them.

---

## 8. Screens

1. **Plan builder** – goal intake wizard, suggested plan, review and "Start this plan" (3.0). Also: list of my plans (active / drafts / archived).
2. **Dashboard** – home screen, daily and weekly (3.1).
3. **Day briefing** – when starting a study day (3.2), including the practice window (3.3).
4. **Day review** – end-of-day window and adjustment suggestions (3.4).
5. **Calendar** – week/month, scheduled tasks alongside external events (read-only).
6. **Plan** – all tasks of the active plan, edit and drag (3.10). Two tabs: 'Curriculum' (tasks grouped by type, with hours, progress and certificates earned) and 'Plan settings' (study hours and days, job description for prompts).
7. **Certificates** – library and "For my CV" (3.9).
8. **Catalog** – browse, add and edit learning resources; broken-link flags (3.0).
9. **Recommendations and content** – recommendation cards and further-learning list (3.5).
10. **Settings** – calendar connection, account (export, delete, "Allow support access", access log).
11. **Admin console** (admin only) – users table, user detail, access requests, aggregate dashboards, catalog and question-bank editing, audit log (3.B).
12. **Public pages** – sign-in, request access, privacy, terms, and the demo link (3.A, 3.C).

The home screen is the Dashboard when a plan is active, and the Plan builder when there is none.

Design: clean, practical, touch-friendly, light and dark mode. A daily work tool – but polished enough to show in a portfolio.

---

## 9. Acceptance tests (must pass)

**Scheduling:**
- A 10-hour task on a day with capacity 7 → 7 today and 3 tomorrow.
- "Partial – 2 of 5" → 3 hours carry over to the next study day, and everything else shifts accordingly.
- Adding Friday as a study day → tasks move earlier into it, and the finish date moves up.
- Anchor at risk → warning with 3 options.
- Completing a certificate → a CV-update task on the same day.
- Past days never change.

**Calendar:**
- A 2-hour event on a study day → capacity drops to 5, and the schedule updates.
- A schedule change → calendar events update with no duplicates.
- Attempting to edit/delete an event the app didn't create → blocked, an error is thrown.
- Manually moving a study block in Google → it stays in the new spot, and the rest reschedules around it.
- A new external event that conflicts with a block → the block moves; the external event is unchanged.

**Day review and adjustments:**
- "Too much" density two days in a row → a suggestion to reduce by one hour is shown, and nothing changes without approval.
- Accepting a suggestion → reschedule and change summary.
- Actual hours +30% over estimate for a task type → suggestion to update estimates for that type.

**Dashboard and briefing:**
- A task skipped yesterday appears in the weekly "Open tasks" and is marked as carried over.
- The day briefing shows a specific lesson link for every course task, and a ready prompt for every practice.

**Practices:**
- In-app practice → valid JSON feedback is saved at the end, and the practice is marked done.
- Primary provider returns 429 → the switch to the fallback is seamless, and the conversation continues from the same point.
- The API key never appears in browser code or in network traffic to the browser.
- Pasting a valid feedback block → score and feedback saved, practice marked done.
- Pasting unformatted text → saved as free text, without an error.
- `next_focus` from a previous practice appears in the prompt of the next practice of the same type.

**Environments:**
- An action in R&D (e.g. a reschedule) creates events only in "Upversion (R&D)" and changes nothing in the Operational database or calendar.
- The `app_rnd` role is refused (permission error) when it tries to read or write any table in the `prod` schema.
- A migration run without an explicit target schema refuses to start.
- The R&D badge is visible in R&D and absent in Operational.
- A hotfix merged into `main` is present in `rnd` after the merge-back.

**Access and legal:**
- An email that isn't on the allowlist can't create an account – by email code or by Google.
- A request-access submission appears in the admin queue; approving it sends the invite and lets that email sign in.
- An invite link works once and is rejected after use or after 7 days.
- When the user capacity is reached, the request page says so and new sign-ups are blocked; requests are still collected.
- Turnstile is required on sign-in and request access (tested with Turnstile's test keys in CI).
- A new user must accept the Terms before the intake starts; a new Terms version triggers a re-accept notice.

**Accessibility:**
- Automated axe checks pass on sign-in, intake, dashboard, day briefing, day review, plan, settings and admin screens.
- The full core flow (sign in → intake → start plan → log progress → end day) can be completed with the keyboard only.
- Reordering tasks works without drag-and-drop.

**Accounts:**
- A signed-out visitor opening the app sees sign-in; the intake can't be reached without an account (the demo can).
- Sign in with an email code → account created on first sign-in; same email later → same account and data.
- User A can't read or change any of user B's rows – tested **directly against the database with RLS**, not only through the API.
- A user-added catalog item is invisible to other users; the shared catalog is visible to all and editable only by the admin.
- "Export my data" returns everything in the account; "Delete my account" removes all of it and the app-created calendar events.
- A user who hits the daily AI cap gets a clear message and the form/template fallbacks; other users are unaffected.

**Admin console:**
- A `user` account calling any `/admin` endpoint gets 403; the admin console route isn't reachable in the UI for them.
- Admin sees all users in the users table, with correct progress and usage numbers for a seeded test user.
- Admin can't see a user's Tier 2 content (background, practice transcripts) without an active support-access grant – tested against the database.
- With support access on, admin can see it; after 7 days the grant expires and access is blocked again.
- Every user-detail view and Tier 2 view creates an audit-log row, visible to that user in Settings.
- The users CSV export contains Tier 1 columns only.

**Guided intake:**
- Choosing "I'm not sure yet" shows the role-discovery stage; choosing "Get a new job" skips it.
- The skill matrix lists exactly the skills of the selected target role(s).
- "Free only" + certificates "Must have" → the follow-up question about paid exams appears.
- A pasted job posting that mentions Tableau → Tableau is suggested as an extra skill, and added only after confirmation.
- Closing the app mid-intake and reopening → continues from the last completed stage.
- No plan is generated before the "Here's what I understood" summary is confirmed.
- Conversational mode with the AI disabled → falls back to the form with the answers so far kept.

**Plan builder:**
- A goal + skills + 4 weeks × 5 days × 7 hours → a draft plan whose total hours fit the capacity, with a summary of hours, certificates, cost and finish date.
- A request that doesn't fit → a clear warning with the 3 options (extend, add capacity, drop optional items).
- Every suggested item with a link comes from the catalog; anything outside it is marked "Unverified" and has no link.
- Skills asked for but not covered by the plan are listed as gaps.
- With the AI provider disabled → the rule-based builder still produces a valid plan.
- Nothing is scheduled or written to the calendar until "Start this plan" is pressed.
- Starting a new plan while another is active → asks whether to archive or pause the current one.
- Price limit $100 → the plan's backend-calculated total is ≤ $100; an AI draft over the limit is rejected.
- "Free only" → every item has cost type `free` or `free_audit`, and certificate costs are shown separately.
- A subscription item (e.g. $59/month) in a 6-week plan → cost counts 2 months, based on when the plan actually uses it.
- "Make this plan free" → a $0 version with a side-by-side comparison; items with no free equivalent are listed explicitly.
- A course I added as "must include" → appears in every generated draft, even after "Regenerate".
- Quick add from a URL that can't be fetched → the manual form opens, nothing breaks.

**Time settings:**
- Changing study days from 5 to 6 per week → the plan finishes earlier, and the change summary shows by how much.
- A per-weekday override (Thursday: 5 hours) → every Thursday gets 5 hours.
- A 1-hour event leaving a 20-minute gap → no block is created in the gap (minimum 30 minutes).
- No study block is ever scheduled inside the lunch break or outside the daily window.
- An exam with a start time is placed exactly at that time.

**Calendar busy rules:**
- A declined event, an event marked "Free", and an unanswered invitation → don't reduce capacity.
- An accepted "Busy" event → reduces capacity.
- A rejected refresh token → "Reconnect calendar" banner, and the dashboard still works.

**Robustness:**
- Broken JSON from the model → one retry, then saved as free text; the practice is not lost.
- AI quota exhausted → the day briefing shows the template overview.
- A timestamp created at 23:30 in the user's time zone is shown on the correct local date.
- The backup action produces a dump, and the restore script recreates the data on `rnd`.

**Extensibility:**
- Every user-owned query is scoped by `user_id`; a test proves a second user can't read the first user's data.
- The scheduling engine runs on any `Plan` passed to it, including a second test plan unrelated to the seed.
- A `paid` AI provider registered in tests is refused while the setting is off.
- A dummy `NotificationChannel` added in tests receives events from the log with no changes to core code.

---

## 10. Demo mode (for the portfolio)

- **Runs entirely in the browser.** The demo is a frontend build with a **mocked API** (e.g. MSW – Mock Service Worker) that serves sample data. It makes **no calls to the real backend** – so the public demo can't expose my data, my API, or my AI quota.
- The mock API uses the same OpenAPI contract and shared types as the real one, so the demo stays in sync with the app (a CI check fails if they drift).
- The sample data simulates mid-month: some tasks done, day reviews, recommendations and schedule changes – so visitors see the system "alive".
- Visitors can click around (mark tasks, review a day, see a reschedule – the scheduling engine runs in the browser from `packages/shared`). Data lives in memory and resets on every visit.
- Practices in demo: pre-saved conversations and feedback.
- **Plan builder in demo:** visitors can enter a goal and get a plan from the **rule-based builder** running in the browser on the sample catalog (no AI calls). This is the most impressive part to show, so it should work well in the demo.
- Deployed as its own static site (Vercel), with a visible "Demo – sample data" banner.

---

## 11. Build phases

Each phase = several feature branches → PRs into `rnd` → tested on the R&D environment → released to `main` (Operational) when ready, feature by feature or as a group. **At the end of each phase, stop, show me what works on R&D, and wait for my approval before releasing it to Operational.**

**Phase 0 – Environments (before v0.1):** set up both branches, branch protection, both deployments, the `prod` and `rnd` schemas with their restricted roles, the R&D calendar, the R&D badge, the daily backup action, secret scanning in CI, and the `docs/decisions/` folder with the first ADRs. Nothing else starts before this works.

1. **v0.1 – Foundation:** monorepo setup (web, api, shared), CI, **sign-in and accounts with RLS (3.A)**, data model, seed, scheduling engine + tests, tasks API, progress logging and time settings, and a minimal UI connected to it.
2. **v0.2 – Daily experience:** daily and weekly dashboard, day briefing with links and the AI/template day overview, day review, adjustment rules + suggestions, Playwright e2e tests for the 3 core flows.
3. **v0.3 – Practices:** dynamic prompts, timer, in-app practice chat with provider layer and fallback, JSON feedback, claude.ai alternative, score trends. Voice input – at the end of the phase, if time allows.
3b. **v0.3b – Calendar** *(moved here from v0.6 by the owner on 1 Nov 2026, so that calendar events shape capacity before the content and plan-builder phases)*: Google Calendar with minimal scopes and the protection layer. Connecting is one tap per user (the app creates the "Upversion" calendar itself, with sensible defaults for which calendars block time). Google only for now; until Google verifies the app it is limited to testers (see 3.8). Version numbers v0.4 to v1.0 are unchanged.
4. **v0.4 – Content, plan and admin:** admin console (3.B), plan and certificate screens, automatic CV tasks, system recommendations, content list.
5. **v0.5 – Plan builder:** catalog (data, screen, link checker), goal intake wizard, AI plan generation + rule-based fallback, fit check, review and "Start this plan", multiple plans.
7. **v1.0 – Showcase:** PWA, polish, in-browser demo mode, "App health" metrics card, full README with screenshots, diagram, ADR summary and sprint results, deployment.

---

## 12. Out of scope – and built to be extended

The items below are **not built in v1.0**. But the code must be structured so that each of them can be added later **without rewriting the core** (the scheduling engine, the data model, the API contract).

The balance: **prepare the seams, not the features.** That means interfaces with a single implementation, a few fields added from day one, and clean module boundaries – no speculative tables, screens, or dependencies for features that don't exist yet.

### 12.1 Deferred features

| Item | Why it's out of v1.0 | What to do instead in v1.0 |
|---|---|---|
| **Sharing** (sharing a plan or progress with a friend, mentor or employer) | Needs sharing permissions on top of RLS and a public-view mode. | Export my data; screenshots; the demo URL. |
| **Push notifications** | Needs a push service, permission flows and background workers; calendar events already notify me. | Calendar reminders on "Upversion" events, in-app warnings. |
| **Native mobile app** | A PWA installs on tablet and phone with no store and no cost. | PWA only. |
| **Offline-first editing** | Syncing offline edits with the backend and calendar is hard. | Read-only cache of the last view; edits need a connection, with a clear "offline" message. |
| **Course-platform integrations** (auto-reading progress from Coursera, Skilljar, Kaggle…) | No public progress APIs; scraping is fragile. | Manual progress marking. |
| **Shared / public plan templates** (publishing plans for others, a community library) | Needs moderation and sharing permissions. | Plans are personal; the shared catalog is curated by the admin. |
| **Advanced analytics and exports** | The dashboard answers "am I on track". | Optional quick CSV export of logs. |
| **Other calendars** (Outlook, Apple) | Google first; others via the `CalendarProvider` seam. | Google sync, plus .ics export for any calendar. |
| **Gamification** (points, badges, streaks) | The goal is honest tracking; engagement mechanics can push toward faking completions. | Plain progress numbers. |
| **Social features** (comments, profiles, feeds) | Needs moderation and safety work; not the core value. | – |
| **Job-search tracking** (applications, contacts) | Separate concern; may become its own module. | – |
| **General AI assistant** (beyond the practice window) | Keeps the AI layer small and the free quota for practice. | AI only inside practices. |
| **Paid AI providers** (e.g. Claude API) | The $0 constraint. | Free-tier providers only. |
| **Profile import from CV / LinkedIn** – read the user's CV and LinkedIn profile, extract skills, experience and level, and pre-fill the goal wizard with suggested skills, gaps and courses | Needs file parsing, careful PII handling, and a good skill taxonomy first. | Manual "Where are you now?" step in the wizard (3.0). |
| **LinkedIn progress posts** – optionally connect the user's LinkedIn account and publish updates on their improvement (a finished course, a certificate earned, a milestone) | Needs a LinkedIn developer app and OAuth, and LinkedIn's API access terms and rate limits have not been checked (needs check). Posting is outward-facing, so it needs its own consent and review flow. | Manual: the app shows a ready-to-copy update text the user can paste into LinkedIn themselves. |

### 12.2 Permanent guardrails (stay true even when extending)
Future features must respect these. They are rules, not missing features.
- The app never writes to calendar events it didn't create, and never requests the full `calendar` scope (3.8).
- No personally identifying information is sent to AI models (3.3).
- A user's data is visible to that user, and to the admin only within the tiers in 3.B – enforced by RLS, with every admin access audit-logged.
- The app never marks a task done on its own – completion is always the user's action or their pasted/returned practice feedback.
- Plan changes are suggestions until the user approves them (3.4).
- Any paid component is **off by default** and requires an explicit setting plus a spending cap.

### 12.3 Extension seams to build now
Each seam below costs little in v1.0 and makes a deferred item a contained addition later.

**Data**
- **`user_id` on every user-owned table from day one** (including plans, goals and the catalog), and every query scoped by it (with a test that a query can't read another user's rows). Multiple users exist from v0.1 (3.A), and RLS enforces the same rule in the database. → also enables sharing and social later.
- **`plan_id` on tasks and schedules.** A `Plan` entity owns its tasks and settings; the scheduling engine takes a plan as input and knows nothing about *my* plan. The seed is a JSON file in the shared format, loaded through the same API as any plan. → used by the plan builder (3.0) from v1.0; later enables shared templates.
- **Append-only event log** (`task.started`, `task.logged`, `task.completed`, `certificate.earned`, `schedule.changed`, `anchor.at_risk`, `review.submitted`, `practice.finished`). The dashboard reads current state; the log records history. → enables analytics, exports, gamification and notifications without touching existing tables.
- **`external_ref` and `source` fields on tasks** (`source: manual` in v1.0). → enables course-platform integrations.
- **Database migrations from the first commit** (no manual schema edits).

**Backend interfaces (one implementation each in v1.0)**
- `CalendarProvider` – Google implementation. The protection layer from 3.8 lives **above** the interface, so it applies to every future provider. → Outlook, Apple.
- `AIProvider` – GitHub Models, Groq, Gemini implementations, each declaring `costTier: "free" | "paid"`. A guard refuses `paid` providers unless enabled in settings. → Claude API or other paid models later, and a general assistant reusing the same layer.
- `NotificationChannel` – in-app implementation only, subscribed to the event log. → push, email, Telegram later.
- `ProgressSource` – manual implementation only. → Coursera/Kaggle/etc. importers later.
- `Exporter` – CSV implementation (optional in v1.0). → other formats later.
- `ProfileSource` – manual implementation only (the wizard's "Where are you now?" answers, stored as a structured `UserProfile`: skills with levels, roles held, years, education). → CV upload and LinkedIn import later fill the same structure.
  - **Planned approach for later:** CV as PDF/DOCX parsed in the backend; LinkedIn via the user's own **data export** (LinkedIn "Get a copy of your data" → CSV files such as Profile, Positions, Skills) or a "Save to PDF" of the profile – **never scraping**, which breaks LinkedIn's terms. Skills are matched against `skills.json` keywords first (no AI needed), then optionally refined by the free LLM.
  - **Privacy:** contact details (name, phone, email, address, links) are stripped before any text reaches a model; the original file is deleted after extraction unless the user chooses to keep it; extracted skills are shown for confirmation before they're used.

**Structure and API**
- **Domain modules in the backend** (`modules/plans`, `modules/scheduling`, `modules/practice`, `modules/calendar`, `modules/recommendations`), each with its own routes, service and tests, talking to others through services – not through each other's tables. → a future `modules/job-search` or `modules/social` drops in beside them.
- **Versioned API** (`/api/v1/...`) with the OpenAPI spec as the contract, and a typed client generated from it for the web app. → a native app or another client can use the same API.
- **No business logic in the frontend.** The web app only renders what the API returns and sends user actions. → native app, offline mode.
- **Idempotent write endpoints with client-generated ids** (so a retried request never creates duplicates), and all frontend data access through one client layer (e.g. TanStack Query). → offline queuing and sync later.
- **Feature flags** in config (`features.notifications`, `features.sharing`, …), all off. New features ship behind a flag.

### 12.4 Rules while building
- Don't build anything from 12.1, and don't add its dependencies. Build only the seams in 12.3.
- If a feature in section 3 can't be done well without something from 12.1, build the simpler version and add a note to `docs/FUTURE.md`.
- Keep `docs/FUTURE.md` as the single list of deferred ideas, each with the seam it will use.
- Add `docs/EXTENDING.md`: a short guide showing how to add a new `CalendarProvider`, `AIProvider` or `NotificationChannel` – with the expectation that each is a new file plus a config entry, with no changes to the core.
- If you're unsure whether something is in scope, ask me before writing code.

---

## 13. Questions to ask me before starting

- Where to host: Vercel + Supabase on free addresses (decided: no custom domain in v1.0), or something else you'd recommend for the backend?
- The admin email to promote, and the initial user capacity for the beta (default 25)?
- Repo name (suggested: `upversion`, or `upversion-app` if taken), and should it be public from the start or private until v1.0?
- Do I already have keys for GitHub Models / Groq / Gemini, or do I need a walkthrough to create them?
- Do I have a Google Cloud project, or do I need a step-by-step guide to set up OAuth for Calendar?
- Do the estimates in section 7 look reasonable, or should we calibrate them after the first week based on actual hours?
