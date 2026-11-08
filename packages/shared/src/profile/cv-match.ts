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
 * first token of each term, no nested unbounded regexes.
 */

export const MAX_EVIDENCE_LENGTH = 80;
const MAX_LINE_LENGTH = 2000;
const MAX_TITLE_LINE_LENGTH = 120;

type SectionKind = 'experience' | 'education' | 'skills' | 'other';

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
    'references',
    'interests',
    'additional information',
  ].map((h): [string, SectionKind] => [h, 'other']),
]);

function headingKind(line: string): SectionKind | null {
  const t = line
    .trim()
    .replace(/[:\s]+$/u, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length === 0 || t.length > 40) return null;
  return HEADINGS.get(t) ?? null;
}

/** `Skills: Excel, SQL` on one line counts as a skills line even without a heading. */
const INLINE_SKILLS_RE = /^\s*(?:technical skills|key skills|skills|tools|technologies)\s*[:\-–]/iu;
const BULLET_RE = /^\s*[-•*▪◦·–]\s/u;

// ---------------------------------------------------------------- tokens and term index

interface Tok {
  raw: string;
  lower: string;
  start: number;
  end: number;
}

/** Words, with `.` kept inside (`ASP.NET`, `monday.com`) and trailing `+`/`#` (`C++`, `C#`). */
const TOKEN_RE = /[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*[+#]*/gu;

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
      for (let k = 0; k < n; k += 1) {
        const t = toks[i + k] as Tok;
        if (t.lower !== term.lower[k] || (term.cs && t.raw !== term.raw[k])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.push({
          term,
          start: (toks[i] as Tok).start,
          end: (toks[i + n - 1] as Tok).end,
          tokens: n,
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
const DATE = `(?:(?:${MONTHS})[a-z]{0,6}\\.?\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const RANGE_SOURCE =
  `(?<![\\d/])(${DATE})\\s*(?:-|–|—|to)\\s*` +
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
  const slash = /^(\d{1,2})\/(\d{4})$/.exec(t);
  const named = new RegExp(`^(${MONTHS})[a-z]{0,6}\\.?\\s+(\\d{4})$`).exec(t);
  if (slash) {
    const mm = Number(slash[1]);
    if (mm < 1 || mm > 12) return null;
    m = mm - 1;
    y = Number(slash[2]);
  } else if (named) {
    m = MONTHS.split('|').indexOf(named[1] as string);
    y = Number(named[2]);
  } else if (/^\d{4}$/.test(t)) {
    y = Number(t);
  } else {
    return null;
  }
  if (y < 1950 || y > now.getUTCFullYear() + 1) return null;
  return y + m / 12;
}

function findRanges(line: string, now: Date): DateRange[] {
  const out: DateRange[] = [];
  const nowFrac = now.getUTCFullYear() + now.getUTCMonth() / 12;
  for (const m of line.matchAll(new RegExp(RANGE_SOURCE, 'giu'))) {
    const start = parseDate(m[1] as string, now);
    let end = parseDate(m[2] as string, now);
    if (start === null || end === null) continue;
    end = Math.min(end, nowFrac);
    if (end < start) continue;
    out.push({ start, end });
  }
  return out;
}

function stripRanges(line: string): string {
  return line.replace(new RegExp(RANGE_SOURCE, 'giu'), ' ');
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

function snippet(line: string, needle: string | undefined): string {
  const red = redactPii(line.slice(0, MAX_LINE_LENGTH)).text.replace(/\s+/g, ' ').trim();
  if (red.length <= MAX_EVIDENCE_LENGTH) return red;
  const idx = needle ? red.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  const start = idx < 0 ? 0 : Math.max(0, idx - 30);
  return red.slice(start, start + MAX_EVIDENCE_LENGTH).trim();
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

interface SkillHits {
  strongKeys: Set<string>;
  weakKeys: Set<string>;
  inSkills: boolean;
  level: 1 | 2;
  evidence: { line: number; text: string; strong: boolean } | null;
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

  const lines = text.normalize('NFKC').split(/\r\n|\r|\n|\u2028|\u2029/u);
  const n = lines.length;

  // Sections. With no heading at all every line counts as experience (best effort) and the
  // first 2 non-empty lines are the contact block; otherwise everything before the first
  // heading is.
  const headingAt = lines.map((l) => headingKind(l));
  const hasHeadings = headingAt.some((h) => h !== null);
  const kind: SectionKind[] = new Array<SectionKind>(n);
  const dropped = new Set<number>();
  {
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
      if (hasHeadings) {
        if (!seenHeading) dropped.add(i);
      } else if (nonEmpty < 2 && (lines[i] as string).trim() !== '') {
        dropped.add(i);
        nonEmpty += 1;
      }
    }
  }
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
      const cleaned = stripRanges(line).replace(/^[\s|,;·•–—-]+|[\s|,;·•–—-]+$/gu, '');
      const isBullet = BULLET_RE.test(line);
      const own = ranges[i] as DateRange[];
      const nextRanges = i + 1 < n && !dropped.has(i + 1) ? (ranges[i + 1] as DateRange[]) : [];
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
      } else if (entryRanges.length > 0 && segments[0]) {
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
    if (isHeading(i)) continue;
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
        };
        hits.set(id, h);
      }
      const key = `${i}:${m.term.lower.join(' ')}`;
      if (m.term.strong) h.strongKeys.add(key);
      else h.weakKeys.add(key);
      if (kind[i] === 'skills') h.inSkills = true;
      if (kind[i] === 'experience' && !dropped.has(i) && (entryYears[i] as number) >= 2)
        h.level = 2;
      if (!dropped.has(i) && (!h.evidence || (m.term.strong && !h.evidence.strong))) {
        h.evidence = { line: i, text: line.slice(m.start, m.end), strong: m.term.strong };
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
      if (
        m.term.lower.length === 1 &&
        m.term.lower[0] === 'make' &&
        kind[i] !== 'skills' &&
        !MAKE_CONTEXT_RE.test(line)
      ) {
        continue;
      }
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
