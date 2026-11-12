import { redactPii } from '../practice/redact';
import { catalogToolLabels, CATALOG_TAXONOMY } from './catalog';
import type { EducationLevel } from './schemas';
import { MAX_ROLE_TITLE_LENGTH, MAX_ROLES_HELD, MAX_YEARS } from './schemas';
import type {
  CvExtraction,
  CvMatchOptions,
  EducationSuggestion,
  MatchTaxonomy,
  RoleSuggestion,
  SkillSuggestion,
  ToolSuggestion,
} from './types';

/**
 * Deterministic CV matcher (ADR 015 section 3). Pure: no I/O, no AI, no network.
 *
 * Matching runs on the RAW text (redaction would break `03/2018 - 06/2021`, `ASP.NET`,
 * `monday.com`). `redactPii` is applied only to evidence snippets and free-text titles.
 * Everything is linear in the text length: one tokenizer pass per line and hash lookups on the
 * first token of each term, no nested unbounded regexes. Every line is capped at
 * MAX_LINE_LENGTH characters before any regex runs, and trailing-character trimming uses loops.
 *
 * Known limits (by design, see ADR 015 "Risks"):
 * - Phone numbers are removed from evidence by `redactPii`; 7-digit local numbers without a
 *   prefix may survive in an evidence snippet.
 * - Handles written without a URL or `@` (for example "linkedin: dana-example") may survive in
 *   evidence.
 * - A sentence of the CV can appear in evidence, cut to at most 80 characters. The import
 *   payload never carries evidence.
 * - `skills.json` keywords are English: Hebrew words (apart from a few section headings) are not
 *   matched. Hebrew letters stuck to a Latin term (`בSQL`) are split off so the term is found.
 * - A range inside one year ("2014 - 2014") counts 0 years: months are not guessed.
 * - Two-column layouts can pair a title with the wrong date; years are suggestions.
 */

export const MAX_EVIDENCE_LENGTH = 80;
const MAX_LINE_LENGTH = 2000;
const MAX_TITLE_LINE_LENGTH = 120;

type SectionKind = 'experience' | 'education' | 'skills' | 'contact' | 'references' | 'other';

const HEADINGS = new Map<string, SectionKind>([
  ...[
    'experience',
    'work experience',
    'professional experience',
    'relevant experience',
    'employment',
    'employment history',
    'work history',
    'career history',
    'career',
  ].map((h): [string, SectionKind] => [h, 'experience']),
  ...[
    'education',
    'education and training',
    'academic background',
    'academic education',
    'studies',
  ].map((h): [string, SectionKind] => [h, 'education']),
  ...[
    'skills',
    'technical skills',
    'key skills',
    'core skills',
    'skills and tools',
    'tools',
    'tools and technologies',
    'technologies',
    'core competencies',
    'competencies',
    'technical proficiencies',
  ].map((h): [string, SectionKind] => [h, 'skills']),
  // Hebrew section headings (structure only; keywords stay English, ADR 015 risks).
  ...['ניסיון', 'ניסיון תעסוקתי', 'ניסיון מקצועי'].map((h): [string, SectionKind] => [
    h,
    'experience',
  ]),
  ...['השכלה'].map((h): [string, SectionKind] => [h, 'education']),
  ...['כישורים', 'מיומנויות'].map((h): [string, SectionKind] => [h, 'skills']),
  ...[
    'contact',
    'contact info',
    'contact details',
    'contact information',
    'personal',
    'personal info',
    'personal details',
    'personal information',
    'get in touch',
    'פרטים אישיים',
    'פרטי קשר',
    'יצירת קשר',
  ].map((h): [string, SectionKind] => [h, 'contact']),
  // References hold other people's names and phone numbers: dropped like the contact block.
  ...['references', 'referees', 'ממליצים'].map((h): [string, SectionKind] => [h, 'references']),
  ...[
    'summary',
    'profile',
    'professional summary',
    'objective',
    'about me',
    'projects',
    'certifications',
    'certificates',
    'languages',
    'courses',
    'training',
    'volunteering',
    'volunteer experience',
    'military service',
    'awards',
    'publications',
    'interests',
    'additional information',
  ].map((h): [string, SectionKind] => [h, 'other']),
]);

/** Removes trailing characters of `chars` (a loop: no regex, no backtracking). */
function trimEndChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s.charAt(end - 1))) end -= 1;
  return s.slice(0, end);
}

function trimBothChars(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s.charAt(start))) start += 1;
  return trimEndChars(s.slice(start), chars);
}

function headingKind(line: string): SectionKind | null {
  const trimmed = line.trim();
  if (trimmed.length > 60) return null;
  const t = trimEndChars(trimmed, ': \t')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length === 0 || t.length > 40) return null;
  return HEADINGS.get(t) ?? null;
}

/** `Skills: Excel, SQL` on one line counts as a skills line even without a heading. */
const INLINE_SKILLS_RE = /^\s*(?:technical skills|key skills|skills|tools|technologies)\s*[:\-–]/iu;
const SEPARATORS = ' \t|,;·•–—-';
const BULLET_RE = /^\s*[-•*▪◦·–]\s/u;

// ---------------------------------------------------------------- tokens and term index

interface Tok {
  raw: string;
  lower: string;
  start: number;
  end: number;
}

/** Words, with `.` kept inside (`ASP.NET`, `monday.com`) and trailing `+`/`#` (`C++`, `C#`). */
/** Hebrew letters stuck to a Latin term (`בSQL`) are separate tokens. */
const ATOM = '(?:\\p{Script=Hebrew}+|(?:(?!\\p{Script=Hebrew})[\\p{L}\\p{N}])+)';
const TOKEN_RE = new RegExp(`${ATOM}(?:\\.${ATOM})*[+#]*`, 'gu');

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const raw = m[0];
    out.push({ raw, lower: raw.toLowerCase(), start: m.index, end: m.index + raw.length });
  }
  return out;
}

interface Term<O> {
  owner: O;
  raw: string[];
  lower: string[];
  /** Case-sensitive: short all-caps abbreviations (`SQL`, `BA`) and forced terms. */
  cs: boolean;
  strong: boolean;
  text: string;
  /** Per gap between tokens: the term wrote a hyphen there (`no-code`). */
  hyphen: boolean[];
}

function isAbbreviation(text: string): boolean {
  return /\p{Lu}/u.test(text) && text === text.toUpperCase() && text.length <= 6;
}

function makeTerm<O>(owner: O, text: string, forceCs = false): Term<O> | null {
  const toks = tokenize(text);
  if (toks.length === 0) return null;
  if (toks.reduce((n, t) => n + t.raw.length, 0) < 2) return null;
  return {
    owner,
    raw: toks.map((t) => t.raw),
    lower: toks.map((t) => t.lower),
    cs: forceCs || isAbbreviation(text),
    strong: toks.length > 1,
    text,
    hyphen: toks.slice(1).map((t, k) => text.slice((toks[k] as Tok).end, t.start) === '-'),
  };
}

type TermIndex<O> = Map<string, Term<O>[]>;

function buildIndex<O>(terms: readonly (Term<O> | null)[]): TermIndex<O> {
  const index: TermIndex<O> = new Map();
  const seen = new Set<string>();
  for (const t of terms) {
    if (!t) continue;
    const key = `${String(t.owner)}|${t.cs ? 'c' : 'i'}|${t.lower.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const first = t.lower[0] as string;
    const list = index.get(first);
    if (list) list.push(t);
    else index.set(first, [t]);
  }
  return index;
}

/** `Zapier / Make` becomes two aliases. */
function splitAliases(text: string): string[] {
  return text
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Match<O> {
  term: Term<O>;
  start: number;
  end: number;
  tokens: number;
  /** A hyphenated term found with something else between its words (`no code`). */
  loose: boolean;
}

function matchLine<O>(line: string, index: TermIndex<O>): Match<O>[] {
  const toks = tokenize(line);
  const out: Match<O>[] = [];
  for (let i = 0; i < toks.length; i += 1) {
    const cands = index.get((toks[i] as Tok).lower);
    if (!cands) continue;
    for (const term of cands) {
      const n = term.lower.length;
      if (i + n > toks.length) continue;
      let ok = true;
      let loose = false;
      for (let k = 0; k < n; k += 1) {
        const t = toks[i + k] as Tok;
        if (t.lower !== term.lower[k] || (term.cs && t.raw !== term.raw[k])) {
          ok = false;
          break;
        }
        if (k > 0 && term.hyphen[k - 1]) {
          const prev = toks[i + k - 1] as Tok;
          if (line.slice(prev.end, t.start) !== '-') loose = true;
        }
      }
      if (ok) {
        out.push({
          term,
          start: (toks[i] as Tok).start,
          end: (toks[i + n - 1] as Tok).end,
          tokens: n,
          loose,
        });
      }
    }
  }
  return out;
}

interface TaxonomyIndexes {
  skills: TermIndex<string>;
  roles: TermIndex<string>;
}

const indexCache = new WeakMap<MatchTaxonomy, TaxonomyIndexes>();

function taxonomyIndexes(taxonomy: MatchTaxonomy): TaxonomyIndexes {
  const cached = indexCache.get(taxonomy);
  if (cached) return cached;
  const skills = buildIndex(
    taxonomy.skills.flatMap((s) =>
      [s.name, ...s.keywords].flatMap(splitAliases).map((a) => makeTerm(s.id, a)),
    ),
  );
  const roles = buildIndex(
    taxonomy.roles.flatMap((r) =>
      [r.title, ...r.aliases].flatMap(splitAliases).map((a) => makeTerm(r.id, a)),
    ),
  );
  const built = { skills, roles };
  indexCache.set(taxonomy, built);
  return built;
}

// ---------------------------------------------------------------- dates

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE = `(?:(?:${MONTHS})[a-z]{0,6}\\.?\\s+\\d{4}|\\d{1,2}[./]\\d{4}|\\d{4}-\\d{2}(?:-\\d{2})?(?!\\d)|\\d{4})`;
const RANGE_SOURCE =
  `(?<![\\d/.\\p{L}])(${DATE})\\s*(?:-|–|—|to)\\s*` +
  `(${DATE}|present|current|now|today|ongoing)(?![\\d/])`;

interface DateRange {
  start: number;
  end: number;
}

function parseDate(s: string, now: Date): number | null {
  const t = s.toLowerCase().trim();
  const nowFrac = now.getUTCFullYear() + now.getUTCMonth() / 12;
  if (/^(present|current|now|today|ongoing)$/.test(t)) return nowFrac;
  let y: number;
  let m = 0;
  const slash = /^(\d{1,2})[./](\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(t);
  const named = new RegExp(`^(${MONTHS})[a-z]{0,6}\\.?\\s+(\\d{4})$`).exec(t);
  if (slash) {
    const mm = Number(slash[1]);
    if (mm < 1 || mm > 12) return null;
    m = mm - 1;
    y = Number(slash[2]);
  } else if (iso) {
    const mm = Number(iso[2]);
    if (mm < 1 || mm > 12) return null;
    m = mm - 1;
    y = Number(iso[1]);
  } else if (named) {
    m = MONTHS.split('|').indexOf(named[1] as string);
    y = Number(named[2]);
  } else if (/^\d{4}$/.test(t)) {
    y = Number(t);
  } else {
    return null;
  }
  // Future years are kept here; `findRanges` caps an end date at now.
  if (y < 1950 || y > 2100) return null;
  return y + m / 12;
}

function findRanges(line: string, now: Date): DateRange[] {
  const out: DateRange[] = [];
  const nowFrac = now.getUTCFullYear() + now.getUTCMonth() / 12;
  for (const m of line.matchAll(new RegExp(RANGE_SOURCE, 'giu'))) {
    const start = parseDate(m[1] as string, now);
    let end = parseDate(m[2] as string, now);
    if (start === null || end === null || start > nowFrac) continue;
    end = Math.min(end, nowFrac);
    if (end < start) continue;
    out.push({ start, end });
  }
  return out;
}

function stripRanges(line: string): string {
  // Empty brackets left by a removed range, as in "Coordinator (2020 - 2021)", go too.
  return line.replace(new RegExp(RANGE_SOURCE, 'giu'), ' ').replace(/[([]\s*[)\]]/gu, ' ');
}

const STARTS_WITH_RANGE_RE = new RegExp(`^[\\s(\\[|,;·•–—-]*${RANGE_SOURCE}`, 'iu');
/** A line that opens with a date range ("Jan 2021 - Present, Tel Aviv"). */
function startsWithRange(line: string): boolean {
  return STARTS_WITH_RANGE_RE.test(line);
}

const roundHalf = (n: number): number => Math.round(n * 2) / 2;

function sumYears(ranges: readonly DateRange[]): number {
  return roundHalf(ranges.reduce((n, r) => n + (r.end - r.start), 0));
}

function unionYears(ranges: readonly DateRange[]): number {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = 0;
  let curEnd = -Infinity;
  for (const r of sorted) {
    if (r.start > curEnd) {
      if (curEnd > -Infinity) total += curEnd - curStart;
      curStart = r.start;
      curEnd = r.end;
    } else if (r.end > curEnd) {
      curEnd = r.end;
    }
  }
  if (curEnd > -Infinity) total += curEnd - curStart;
  return total;
}

// ---------------------------------------------------------------- evidence

/**
 * Caps a line before any regex runs. When the cut falls inside a line, the last 3 words are
 * dropped too, so an email or phone number straddling the cut cannot leave a fragment that
 * `redactPii` would no longer recognise.
 */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  const cut = line.slice(0, MAX_LINE_LENGTH);
  let end = cut.length;
  let words = 0;
  while (end > 0) {
    while (end > 0 && /\s/u.test(cut.charAt(end - 1))) end -= 1;
    const wordEnd = end;
    while (end > 0 && !/\s/u.test(cut.charAt(end - 1))) end -= 1;
    words += 1;
    // After 3 words, keep dropping words that look like part of a phone number or address.
    if (words >= 3 && !/[\d+@()]/u.test(cut.slice(end, wordEnd))) break;
  }
  return cut.slice(0, end).trimEnd();
}

function snippet(line: string, needle: string | undefined): string {
  // Lines are already capped (and a cut token dropped) by `capLine`; redact the whole line.
  const red = redactPii(line).text.replace(/\s+/g, ' ').trim();
  if (red.length <= MAX_EVIDENCE_LENGTH) return red;
  const idx = needle ? red.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  // Cut on word boundaries and mark each cut with an ellipsis (the whole result stays within
  // MAX_EVIDENCE_LENGTH, ellipses included).
  const room = MAX_EVIDENCE_LENGTH - 2;
  let start = idx < 0 ? 0 : Math.max(0, idx - 30);
  if (start > 0 && !/\s/u.test(red.charAt(start - 1))) {
    // Snap forward to a word start, but never past the matched text: when a long token runs
    // into it, start at the match itself.
    const space = red.indexOf(' ', start);
    start = space >= 0 && space < idx ? space + 1 : idx;
  }
  let end = Math.min(red.length, start + room);
  if (end < red.length && !/\s/u.test(red.charAt(end))) {
    const space = red.lastIndexOf(' ', end);
    const needleEnd = idx < 0 || !needle ? start : idx + needle.length;
    if (space > start && space >= needleEnd) end = space;
  }
  const body = red.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${body}${end < red.length ? '…' : ''}`;
}

// ---------------------------------------------------------------- education and tools

interface EduRule {
  text: string;
  level: EducationLevel;
  cs: boolean;
}

const EDU_RULES: EduRule[] = [
  ...['MSc', 'M.Sc', 'M.A', 'MA', 'MBA', 'MEng', 'M.Eng'].map((text): EduRule => ({
    text,
    level: 'master',
    cs: true,
  })),
  ...['PhD', 'Ph.D', 'Doctorate', 'Master', 'Masters'].map((text): EduRule => ({
    text,
    level: 'master',
    cs: false,
  })),
  ...['BSc', 'B.Sc', 'B.A', 'BA', 'BEng', 'B.Eng', 'LLB'].map((text): EduRule => ({
    text,
    level: 'bachelor',
    cs: true,
  })),
  ...['Bachelor', 'Bachelors'].map((text): EduRule => ({ text, level: 'bachelor', cs: false })),
  ...['courses', 'bootcamp', 'diploma', 'certificate program'].map((text): EduRule => ({
    text,
    level: 'some_college',
    cs: false,
  })),
  ...['high school', 'Bagrut'].map((text): EduRule => ({ text, level: 'high_school', cs: false })),
];

const EDU_RANK: Record<EducationLevel, number> = {
  high_school: 1,
  some_college: 2,
  bachelor: 3,
  master: 4,
};

const EDU_INDEX: TermIndex<EducationLevel> = buildIndex(
  EDU_RULES.map((r) => makeTerm(r.level, r.text, r.cs)),
);

/** Plain English words that are also tool names: matched only in their exact spelling. */
const EXACT_CASE_TOOLS = new Set(['excel', 'notion', 'make']);
const MAKE_CONTEXT_RE = /zapier|integromat|automation|no-code|workflow/i;

/** `Make` (the tool, or the skill keyword) needs automation context or a Skills line. */
function isUnguardedMake(lower: readonly string[], section: SectionKind, line: string): boolean {
  return (
    lower.length === 1 && lower[0] === 'make' && section !== 'skills' && !MAKE_CONTEXT_RE.test(line)
  );
}

function buildToolIndex(labels: readonly string[]): TermIndex<string> {
  return buildIndex(
    labels.flatMap((label) =>
      splitAliases(label).map((alias) =>
        makeTerm(label, alias, EXACT_CASE_TOOLS.has(alias.toLowerCase())),
      ),
    ),
  );
}

// ---------------------------------------------------------------- main

/**
 * Sections. With no heading at all every line counts as experience (best effort) and the first
 * 2 non-empty lines are the contact block; otherwise everything before the first heading is.
 * A `Contact` / `Personal details` section and a `References` section are dropped as well.
 */
function classifyLines(lines: readonly string[]): {
  headingAt: (SectionKind | null)[];
  kind: SectionKind[];
  dropped: Set<number>;
} {
  const n = lines.length;
  const headingAt = lines.map((l) => headingKind(l));
  const hasHeadings = headingAt.some((h) => h !== null);
  const kind: SectionKind[] = new Array<SectionKind>(n);
  const dropped = new Set<number>();
  let current: SectionKind = hasHeadings ? 'other' : 'experience';
  let seenHeading = false;
  let nonEmpty = 0;
  for (let i = 0; i < n; i += 1) {
    const h = headingAt[i] ?? null;
    if (h) {
      current = h;
      seenHeading = true;
    }
    kind[i] = !h && INLINE_SKILLS_RE.test(lines[i] as string) ? 'skills' : current;
    if (current === 'contact' || current === 'references') dropped.add(i);
    if (hasHeadings) {
      if (!seenHeading) dropped.add(i);
    } else if (nonEmpty < 2 && (lines[i] as string).trim() !== '') {
      dropped.add(i);
      nonEmpty += 1;
    }
  }
  return { headingAt, kind, dropped };
}

/**
 * The matcher's contact-block rule (ADR 015 section 3, ADR 016 section 2.2), shared with the CV
 * tailoring feature: the indexes of the lines that are NOT read. Lines before the first section
 * heading (with no heading: the first 2 non-empty lines), a `Contact` / `Personal details`
 * section and a `References` section.
 */
export function dropContactLines(lines: readonly string[]): Set<number> {
  return classifyLines(lines).dropped;
}

/** Splits CV text into lines the way the matcher does. */
export function splitCvLines(text: string): string[] {
  return text.split(/\r\n|\r|\n|\u2028|\u2029/u);
}

/** Longest wording kept as a display term, in characters (longer matches are skipped). */
export const MAX_TERM_LENGTH = 40;
/** Most display terms kept for one skill. */
export const MAX_TERMS_PER_SKILL = 3;

/** Counts the wordings of one skill as written in a text, for display. */
class TermCounter {
  private readonly seen = new Map<string, { text: string; count: number }>();

  /** `raw` is the matched span as written. Whitespace is collapsed; case is kept. */
  add(raw: string): void {
    const text = raw.replace(/\s+/gu, ' ').trim();
    if (text === '' || text.length > MAX_TERM_LENGTH) return;
    const key = text.toLowerCase();
    const prev = this.seen.get(key);
    if (prev) prev.count += 1;
    else this.seen.set(key, { text, count: 1 });
  }

  /**
   * Most frequent first (ties: first seen), capped. A wording the PII redaction would change is
   * dropped, so contact text never reaches the screen.
   */
  top(): string[] {
    return [...this.seen.values()]
      .filter((t) => redactPii(t.text).count === 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TERMS_PER_SKILL)
      .map((t) => t.text);
  }
}

/** A skill found in free text (a job post), with how often it was named. */
export interface TextSkillHit {
  skillId: string;
  /** Total matches in the text (for sorting). */
  hits: number;
  /** The text's own wordings for it, most frequent first, capped, free of contact text. */
  terms: string[];
}

/**
 * Skills named in a text that has no CV structure (a job post: its first lines are its title,
 * it has no contact block). Every line is read. Same threshold as the CV matcher: one strong
 * (multi-word) term or two different weak terms, with one addition: a single term that is also a
 * `tools_known` label (`SQL`, `Python`, `Tableau`, `Jira`; `Excel` only in that spelling) counts
 * on its own, because a requirement line such as "Strong SQL skills" names it once. Sorted by
 * `hits`, then id. Deterministic, linear.
 */
export function matchSkillsInText(
  text: string,
  options: Pick<CvMatchOptions, 'taxonomy' | 'tools'> = {},
): TextSkillHit[] {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const { skills: skillIndex } = taxonomyIndexes(taxonomy);
  const toolIndex = buildToolIndex(options.tools ?? catalogToolLabels());
  const agg = new Map<
    string,
    { strong: Set<string>; weak: Set<string>; hits: number; terms: TermCounter }
  >();
  for (const raw of splitCvLines(text.normalize('NFKC'))) {
    const line = capLine(raw);
    const toolKeys = new Set(matchLine(line, toolIndex).map((m) => m.term.lower.join(' ')));
    for (const m of matchLine(line, skillIndex)) {
      if (isUnguardedMake(m.term.lower, 'other', line)) continue;
      const id = m.term.owner;
      let a = agg.get(id);
      if (!a) {
        a = { strong: new Set(), weak: new Set(), hits: 0, terms: new TermCounter() };
        agg.set(id, a);
      }
      a.terms.add(line.slice(m.start, m.end));
      const key = m.term.lower.join(' ');
      if ((m.term.strong && !m.loose) || toolKeys.has(key)) a.strong.add(key);
      else a.weak.add(key);
      a.hits += 1;
    }
  }
  return [...agg]
    .filter(([, a]) => a.strong.size >= 1 || a.weak.size >= 2)
    .map(([skillId, a]) => ({ skillId, hits: a.hits, terms: a.terms.top() }))
    .sort((a, b) => b.hits - a.hits || a.skillId.localeCompare(b.skillId));
}

/** Catalog skills and tools a text mentions, with no threshold (used to check AI output). */
export interface CatalogMentions {
  /** Skill ids with at least one matching term, in any strength. */
  skills: string[];
  /** `tools_known` labels with a match. */
  tools: string[];
}

/**
 * Every catalog skill id and tool label named anywhere in `text`, even by one weak term. Unlike
 * `matchSkillsInText` there is no threshold: it answers "is this name in the text at all", for
 * comparing an AI answer with the CV it came from. Deterministic, linear.
 */
export function findCatalogMentions(
  text: string,
  options: Pick<CvMatchOptions, 'taxonomy' | 'tools'> = {},
): CatalogMentions {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const { skills: skillIndex } = taxonomyIndexes(taxonomy);
  const toolIndex = buildToolIndex(options.tools ?? catalogToolLabels());
  const skills = new Set<string>();
  const tools = new Set<string>();
  for (const raw of splitCvLines(text.normalize('NFKC'))) {
    const line = capLine(raw);
    for (const m of matchLine(line, skillIndex)) {
      if (!isUnguardedMake(m.term.lower, 'other', line)) skills.add(m.term.owner);
    }
    for (const m of matchLine(line, toolIndex)) {
      if (!isUnguardedMake(m.term.lower, 'other', line)) tools.add(m.term.owner);
    }
  }
  return { skills: [...skills].sort(), tools: [...tools].sort() };
}

interface SkillHits {
  strongKeys: Set<string>;
  weakKeys: Set<string>;
  inSkills: boolean;
  level: 1 | 2;
  evidence: { line: number; text: string; strong: boolean } | null;
  terms: TermCounter;
}

/**
 * Reads a CV (plain text, as extracted in the browser) and suggests profile items.
 * Nothing here is final: the review screen lets the user change or drop every suggestion.
 */
export function extractProfileFromText(text: string, options: CvMatchOptions = {}): CvExtraction {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const toolIndex = buildToolIndex(options.tools ?? catalogToolLabels());
  const now = options.now ?? new Date();
  const { skills: skillIndex, roles: roleIndex } = taxonomyIndexes(taxonomy);

  const lines = splitCvLines(text.normalize('NFKC')).map(capLine);
  const n = lines.length;

  const { headingAt, kind, dropped } = classifyLines(lines);
  const hasHeadings = headingAt.some((h) => h !== null);
  const isHeading = (i: number): boolean => headingAt[i] !== null;

  // Date ranges per line (experience lines only feed years).
  const ranges: DateRange[][] = lines.map((l, i) =>
    kind[i] === 'experience' && !isHeading(i) && !dropped.has(i) ? findRanges(l, now) : [],
  );

  // Entry starts: a non-bullet line with text and a date range on the same or the next line.
  const entryYears: number[] = new Array<number>(n).fill(0);
  const roleCandidates: RoleSuggestion[] = [];
  {
    let currentYears = 0;
    for (let i = 0; i < n; i += 1) {
      const line = lines[i] as string;
      if (kind[i] !== 'experience' || isHeading(i)) {
        currentYears = 0;
        continue;
      }
      if (dropped.has(i) || line.trim() === '') {
        entryYears[i] = currentYears;
        continue;
      }
      const cleaned = trimBothChars(stripRanges(line), SEPARATORS);
      const isBullet = BULLET_RE.test(line);
      const own = ranges[i] as DateRange[];
      // The next line's range belongs to this title only when that line is nothing but dates.
      const nextRanges =
        i + 1 < n &&
        !dropped.has(i + 1) &&
        (trimBothChars(stripRanges(lines[i + 1] as string), SEPARATORS) === '' ||
          startsWithRange(lines[i + 1] as string))
          ? (ranges[i + 1] as DateRange[])
          : [];
      const entryRanges = own.length > 0 ? own : cleaned && !isBullet ? nextRanges : [];
      if (!isBullet && cleaned !== '' && entryRanges.length > 0)
        currentYears = sumYears(entryRanges);
      entryYears[i] = currentYears;
      if (isBullet || cleaned === '' || line.length > MAX_TITLE_LINE_LENGTH) continue;

      // Role or editable title for this entry line.
      const years = entryRanges.length > 0 ? sumYears(entryRanges) : null;
      const matches = matchLine(cleaned, roleIndex);
      const segments = cleaned
        .split(/\s*(?:\||·|•|,|;|—|–)\s*|\s+-\s+|\s+@\s+|\s+at\s+/iu)
        .map((s) => s.trim())
        .filter(Boolean);
      if (matches.length > 0) {
        const best = matches.reduce((a, b) => (b.tokens > a.tokens ? b : a));
        const seg = segments.find((s) =>
          matchLine(s, roleIndex).some((m) => m.term.owner === best.term.owner),
        );
        const red = redactPii(seg ?? best.term.text);
        const title = (red.count > 0 ? best.term.text : red.text)
          .slice(0, MAX_ROLE_TITLE_LENGTH)
          .trim();
        roleCandidates.push({
          roleId: best.term.owner,
          title,
          years,
          checked: true,
          evidence: dropped.has(i) ? '' : snippet(line, cleaned.slice(best.start, best.end)),
        });
      } else if (entryRanges.length > 0 && segments[0] && !startsWithRange(line)) {
        const red = redactPii(segments[0]);
        if (red.count === 0 && /\p{L}/u.test(red.text)) {
          roleCandidates.push({
            roleId: null,
            title: red.text.slice(0, MAX_ROLE_TITLE_LENGTH).trim(),
            years,
            checked: false,
            evidence: snippet(line, undefined),
          });
        }
      }
    }
  }

  // Skills.
  const hits = new Map<string, SkillHits>();
  for (let i = 0; i < n; i += 1) {
    if (isHeading(i) || dropped.has(i)) continue;
    const line = lines[i] as string;
    for (const m of matchLine(line, skillIndex)) {
      const id = m.term.owner;
      let h = hits.get(id);
      if (!h) {
        h = {
          strongKeys: new Set(),
          weakKeys: new Set(),
          inSkills: false,
          level: 1,
          evidence: null,
          terms: new TermCounter(),
        };
        hits.set(id, h);
      }
      if (isUnguardedMake(m.term.lower, kind[i] as SectionKind, line)) continue;
      h.terms.add(line.slice(m.start, m.end));
      // Distinct terms across the document: the same word on two lines is one weak hit.
      const key = m.term.lower.join(' ');
      if (m.term.strong && !m.loose) h.strongKeys.add(key);
      else h.weakKeys.add(key);
      if (kind[i] === 'skills') h.inSkills = true;
      if (kind[i] === 'experience' && !dropped.has(i) && (entryYears[i] as number) >= 2)
        h.level = 2;
      const strongHit = m.term.strong && !m.loose;
      if (!h.evidence || (strongHit && !h.evidence.strong)) {
        h.evidence = { line: i, text: line.slice(m.start, m.end), strong: strongHit };
      }
    }
  }
  const skills: SkillSuggestion[] = [];
  for (const [skillId, h] of hits) {
    const strong = h.strongKeys.size >= 1;
    if (!(strong || h.weakKeys.size >= 2 || h.inSkills)) continue;
    skills.push({
      skillId,
      level: h.level,
      strength: strong ? 'strong' : 'weak',
      checked: strong || h.inSkills,
      evidence: h.evidence ? snippet(lines[h.evidence.line] as string, h.evidence.text) : '',
      terms: h.terms.top(),
    });
  }
  skills.sort(
    (a, b) =>
      Number(b.checked) - Number(a.checked) ||
      b.level - a.level ||
      a.skillId.localeCompare(b.skillId),
  );

  // Education: the Education section when there is one, otherwise every line outside the
  // experience section.
  const hasEduSection = kind.some((k, i) => k === 'education' && !isHeading(i));
  let education: EducationSuggestion | null = null;
  {
    let bestRank = 0;
    for (let i = 0; i < n; i += 1) {
      if (isHeading(i)) continue;
      const inScope = hasEduSection
        ? kind[i] === 'education'
        : kind[i] !== 'experience' || !hasHeadings;
      if (!inScope) continue;
      for (const m of matchLine(lines[i] as string, EDU_INDEX)) {
        const rank = EDU_RANK[m.term.owner];
        if (rank > bestRank) {
          bestRank = rank;
          education = {
            value: m.term.owner,
            evidence: dropped.has(i)
              ? ''
              : snippet(lines[i] as string, (lines[i] as string).slice(m.start, m.end)),
          };
        }
      }
    }
  }

  // Tools.
  const toolHits = new Map<string, { evidence: string }>();
  for (let i = 0; i < n; i += 1) {
    if (isHeading(i)) continue;
    const line = lines[i] as string;
    for (const m of matchLine(line, toolIndex)) {
      if (isUnguardedMake(m.term.lower, kind[i] as SectionKind, line)) continue;
      const prev = toolHits.get(m.term.owner);
      if (!prev || (prev.evidence === '' && !dropped.has(i))) {
        toolHits.set(m.term.owner, {
          evidence: dropped.has(i) ? '' : snippet(line, line.slice(m.start, m.end)),
        });
      }
    }
  }
  const toolOrder = options.tools ?? catalogToolLabels();
  const tools: ToolSuggestion[] = toolOrder
    .filter((label) => toolHits.has(label))
    .map((tool) => ({ tool, evidence: (toolHits.get(tool) as { evidence: string }).evidence }));

  // Years: union of experience date ranges.
  const allRanges = ranges.flat();
  const yearsExperience =
    allRanges.length > 0 ? Math.min(MAX_YEARS, roundHalf(unionYears(allRanges))) : null;

  // Roles: matched first, no duplicates, capped.
  const seen = new Set<string>();
  const rolesHeld = [
    ...roleCandidates.filter((r) => r.roleId),
    ...roleCandidates.filter((r) => !r.roleId),
  ]
    .filter((r) => {
      const key = `${r.roleId ?? ''}|${r.title.toLowerCase()}|${r.years ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ROLES_HELD);

  return { skills, rolesHeld, yearsExperience, education, tools };
}
