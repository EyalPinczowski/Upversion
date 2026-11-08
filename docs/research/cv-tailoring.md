# Research: improving a CV and tailoring it to a job

Researched 2026-11-08 with web searches. **Evidence quality is mixed.** Most sources are resume-service companies with a commercial interest. University career centres (Yale, Emory, Augsburg) agree on the basics, so the basics are marked **solid**. Statistics are marked **unverified** and are not used as rules. This file feeds the instructions for the CV agent (`docs/ai-prompts/cv-tailor.md`, ADR 016).

## 1. What the sources agree on

| Practice | Evidence | Rule for the agent |
|---|---|---|
| Mirror the job post's own words for skills, tools, certificates and titles, **where they are true** | Plausible, widely repeated by vendors; **no independent evidence** (one cited vendor page says systems "read tokens", gives no example and no test) | Use the post's exact term when the CV already shows that skill; never add a term the CV does not support |
| Keywords belong in context (summary, skills, bullets), backed by evidence | Practitioner advice, unverified: listing a term alone is weak, and repeating it is advised against. One vendor page withdrew its own "stuffing is penalised" test claims after finding no records, calling it "a rule of thumb, not an ATS threshold" | Each skill at most twice in the text, each time tied to something real |
| Bullet = strong verb + what + measurable result (the "XYZ" shape: accomplished X, measured by Y, by doing Z) | Solid for the shape (career centres). The claim that it "rests on behavioural science" is unverified | Rewrite duties into results using **only numbers already in the CV**; where a number is plausible but missing, insert a visible placeholder like `[number?]` for the user, never a made-up figure |
| Lead with a varied action verb; avoid "responsible for", "handled" | Solid (Emory career centre; Phoenix career services guide, a PDF found in the search results) | Vary openers; no repeated verb within a role |
| Put the most relevant material first; recruiters scan the name, current and previous titles, companies, dates (and in the 2012 study education) first | The 2012 and 2018 eye-tracking studies (6 and 7.4 seconds; the 2012 study put about 80 percent of the time on those items) were run by a job site (Ladders); sample size not confirmed: **treat as a hint**, not a law | Order roles and bullets by relevance; keep titles, employers and dates clean and easy to find |
| Single-column layout, standard headings, selectable text, no tables, text boxes or sidebars; contact details and dates not in headers or footers | Consistent practitioner advice (vendor blogs), not tested independently; some sources say a simple one-row table can work. Claims that one file format is better are weak (one source says it found no evidence; needs check); modern systems are said to read text PDFs | Output plain text with standard headings; no tables or columns. Suggest checking the order by pasting the final file into plain text |
| Spell out acronyms once, then use them | Solid | Spell out military and company acronyms on first use |
| Never claim what you cannot show | Solid. AI-invented details and metrics are the main risk; recruiters notice generic text, not "AI use" as such | See the honesty rules below; the agent only re-words and re-orders |
| Use AI for analysis, tightening and wording, then check every line yourself | Solid (practitioner advice, several sources) | The agent returns notes and a clearly marked draft; the UI says "check every line" |

## 2. Length

Mixed and commercial. A 2018 ResumeGo experiment and two surveys favoured two pages; a later ResumeGo survey of 418 hiring professionals had 92 percent recommending one page for the average job seeker, with 10 or more years of experience being the most common answer for when two pages are justified. **Rule (a judgment call, not a finding):** one page by default, two pages only for long and relevant experience, never a page that is only a quarter full. The CV agent does not output the whole CV (ADR 016: summary, experience bullets, skills), so it does not enforce a length.

## 3. Career changers (the owner's case)

Sources agree: a short summary that states the target and connects the past to it, a skills block near the top, and a **projects** section that proves the new skills. Format advice differs (chronological vs combination); a combination layout (summary, skills, projects, experience) is the most common recommendation. Every item should tie back to the target role.

## 4. Translating military experience

Common advice: show a functional, civilian title next to the real one, spell out acronyms and units, describe scope in numbers (people led, systems owned, timelines), and avoid jargon. Sources differ on how far to rewrite titles: some warn it harms credibility. **Rule:** keep the real title and add a plain-language equivalent only when it is accurate (for example, "Head of Department (30 people), responsible for ..."), never inflate scope.

## 5. What was not found or not verified

- No independent study of how specific ATS products rank resumes.
- The widely quoted "tailored resumes get up to 115 percent more interviews" figure was not traced to its source: **do not use it**.
- Recruiter detection rates of AI-written CVs come from vendor tests: do not cite them.

## Sources

- Tailoring and keywords: [Addison Group](https://addisongroup.com/insights/top-ways-to-tailor-your-resume-using-the-job-description/), [TopResume](https://topresume.com/career-advice/customize-your-resume-to-stand-out), [Zety](https://zety.com/blog/tailor-your-resume), [ATS mechanics: tailoring without keyword stuffing](https://atsverification.com/blog/tailor-resume-job-description-without-keyword-stuffing/)
- Bullets and verbs: [Emory](https://cpd.emory.edu/resources/creating-impressive-resume-bullets/), [Yale](https://ocs.yale.edu/resources/writing-impactful-resume-bullets/), [Augsburg](https://careers.augsburg.edu/resources/crafting-bullet-points-for-your-resume/)
- Recruiter reading time: [HR Dive on the 2018 eye-tracking study](https://www.hrdive.com/news/eye-tracking-study-shows-recruiters-look-at-resumes-for-7-seconds/), [Recruiter.com on the 2012 study](https://www.recruiter.com/i/theladders-reveals-research-reporting-that-resumes-spend-six-seconds-with-a-recruiter/)
- Length: [ResumeGo survey](https://resumego.net/research/how-long-should-a-resume-be), [Resume Genius hiring trends](https://resumegenius.com/blog/job-hunting/hiring-trends-survey), [CBS News](https://www.cbsnews.com/news/your-one-page-resume-may-be-killing-your-job-search)
- ATS parsing: [Jobscan on tables and columns](https://www.jobscan.co/blog/resume-tables-columns-ats/), [Adobe](https://www.adobe.com/acrobat/resources/resume-formatting-mistakes.html), [Enhancv](https://enhancv.com/blog/create-ATS-friendly-resume/)
- Military to civilian: [TopResume](https://topresume.com/career-advice/translating-military-experience-for-civilian-career), [The Muse](https://www.themuse.com/advice/translate-military-experience-civilian-resume), [American Legion](https://www.legion.org/information-center/news/careers/2018/january/translating-your-military-resume-for-a-corporate-audience)
- Career changers: [Monster](https://www.monster.com/career-advice/resume/career-change-resume), [TopResume](https://topresume.com/career-advice/how-to-write-resume-for-career-change), [Novoresume](https://novoresume.com/career-blog/career-change-resume)
- AI and CVs: [SHRM](https://www.shrm.org/in/topics-tools/news/technology/how-to-spot-ai-generated-lies-on-a-resume), [Augsburg](https://careers.augsburg.edu/resources/can-recruiters-tell-if-youve-used-ai-to-write-your-resume/), [Dice](https://www.dice.com/career-advice/use-ai-to-polish-your-resume-not-write-it-into-oblivion)
