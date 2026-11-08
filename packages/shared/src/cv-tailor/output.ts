import { findCatalogMentions } from '../profile/cv-match';
import { CATALOG_TAXONOMY, catalogToolLabels } from '../profile/catalog';
import type { MatchTaxonomy } from '../profile/types';
import type { RedactOptions } from '../practice/redact';
import { MAX_CV_TAILOR_OUTPUT } from './limits';
import { redactCvPii, removeControlChars } from './prepare';

/**
 * Reading and checking the model's answer (ADR 016 section 4, WP-E). Pure, deterministic, linear:
 * every scan is a single regex pass or a hash lookup; no nested unbounded quantifiers.
 */

// ---------------------------------------------------------------- parser

export const MAX_NOTE_LENGTH = 200;
const MAX_NOTES_EACH = 20;

export interface TailorSections {
  summary: string;
  experience: string;
  skills: string;
}

export type ParsedTailorOutput =
  | {
      ok: true;
      sections: TailorSections;
      /** The three sections as plain text with their headings; this is what is checked and copied. */
      text: string;
      /** `gap:` lines: job requirements the CV does not show. */
      gaps: string[];
      /** `keyword:` lines: job terms the CV shows in other words. */
      keywords: string[];
      /** False when the answer had no `===NOTES===` marker (the text is still usable). */
      hasNotes: boolean;
      /** How many personal-detail spans were removed from the notes. */
      notesRedacted: number;
    }
  | {
      ok: false;
      /** The whole answer, trimmed and with personal details removed, to show as plain text. */
      plainText: string;
      /** How many personal-detail spans were removed from it. */
      redacted: number;
    };

/** A heading alone on its line, any case, optional markdown decoration and colon. */
const HEADING_ALONE_RE = /^[\s#*_]*(SUMMARY|EXPERIENCE|SKILLS)[\s*_]*:?[\s*_]*$/iu;
/** `SUMMARY: text`: the heading in capitals exactly as specified, text on the same line. */
const HEADING_INLINE_RE = /^[\s#*_]*(SUMMARY|EXPERIENCE|SKILLS)[\s*_]*:[\s*_]*(\S.*)$/u;
/** Longer lines are never headings (also keeps the heading regexes cheap). */
const MAX_HEADING_LINE = 200;
const NOTES_RE = /^[\s#*_]*={2,}\s*NOTES\s*={2,}[\s*_]*$/iu;
const NOTE_RE = /^\s*(?:[-*•]\s*)?[*_]*(gap|keyword)s?[*_]*\s*:\s*(.*)$/iu;

/**
 * Splits the answer into SUMMARY / EXPERIENCE / SKILLS and the notes after `===NOTES===`.
 * Tolerant of case, extra spaces, markdown decoration around headings (`## Summary`,
 * `**SKILLS:**`), text on the heading line, and a short preamble. When any of the three sections
 * is missing or empty it returns `{ ok: false, plainText }`, and the caller shows the answer as
 * plain text with a warning. A missing `===NOTES===` still parses (`hasNotes: false`).
 */
export function parseTailorOutput(raw: string, options: RedactOptions = {}): ParsedTailorOutput {
  const lines = raw.split(/\r\n|\r|\n/u);
  let notesRedacted = 0;
  const body: Record<'summary' | 'experience' | 'skills', string[]> = {
    summary: [],
    experience: [],
    skills: [],
  };
  const gaps: string[] = [];
  const keywords: string[] = [];
  let state: keyof typeof body | 'notes' | null = null;
  let hasNotes = false;
  for (const line of lines) {
    if (NOTES_RE.test(line)) {
      state = 'notes';
      hasNotes = true;
      continue;
    }
    const h =
      state === 'notes' || line.length > MAX_HEADING_LINE
        ? null
        : (HEADING_ALONE_RE.exec(line) ?? HEADING_INLINE_RE.exec(line));
    if (h) {
      state = (h[1] as string).toLowerCase() as keyof typeof body;
      if (h[2] && h[2].trim() !== '') body[state].push(h[2].trim());
      continue;
    }
    if (state === 'notes') {
      const n = NOTE_RE.exec(line);
      const red = redactCvPii(removeControlChars(n?.[2]?.trim() ?? '').slice(0, 1000), options);
      const text = red.text.slice(0, MAX_NOTE_LENGTH).trim();
      if (n && text) {
        notesRedacted += red.count;
        const list = (n[1] as string).toLowerCase() === 'gap' ? gaps : keywords;
        if (list.length < MAX_NOTES_EACH) list.push(text);
      }
    } else if (state) {
      body[state].push(line.trimEnd());
    }
  }
  const sections: TailorSections = {
    summary: body.summary.join('\n').trim(),
    experience: body.experience.join('\n').trim(),
    skills: body.skills.join('\n').trim(),
  };
  if (!sections.summary || !sections.experience || !sections.skills) {
    const red = redactCvPii(raw.trim(), options);
    return { ok: false, plainText: red.text, redacted: red.count };
  }
  const text = `SUMMARY\n${sections.summary}\n\nEXPERIENCE\n${sections.experience}\n\nSKILLS\n${sections.skills}`;
  return { ok: true, sections, text, gaps, keywords, hasNotes, notesRedacted };
}

// ---------------------------------------------------------------- checks

export type TailorFlagKind = 'number' | 'skill' | 'certificate' | 'degree' | 'term' | 'placeholder';

export interface TailorFlag {
  kind: TailorFlagKind;
  /** The text as it appears in the output, so the UI can highlight it. */
  text: string;
}

export interface TailorCheckResult {
  /** The output with personal details removed, controls removed, cut at MAX_CV_TAILOR_OUTPUT. */
  text: string;
  /** Items not found in the CV (or a forbidden placeholder), for the user to verify or delete. */
  flags: TailorFlag[];
  /** How many `[number?]` placeholders remain (allowed; the UI highlights each). */
  numberPlaceholders: number;
  /** How many `[removed]` markers the output holds. */
  removedMarkers: number;
  /** How many personal-detail spans were replaced (the model invented or leaked something). */
  redacted: number;
  /** True when the output was cut at the length limit. */
  truncated: boolean;
}

export interface TailorCheckOptions extends RedactOptions {
  taxonomy?: MatchTaxonomy;
  /** Labels of the `tools_known` options; default: from `questions.json`. */
  tools?: readonly string[];
  /** The catalog role title shown to the model; capitalised phrases inside it are allowed. */
  targetRole?: string;
}

function cutAtLine(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const nl = head.lastIndexOf('\n');
  return { text: (nl > 0 ? head.slice(0, nl) : head).trimEnd(), cut: true };
}

/** Lower-case, dots and apostrophes removed (`B.Sc` equals `BSc`), whitespace collapsed. */
function norm(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[.'’]/gu, '').replace(/\s+/gu, ' ');
}

function containsWord(haystackNorm: string, needleNorm: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystackNorm.indexOf(needleNorm, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : (haystackNorm[at - 1] as string);
    const after = haystackNorm[at + needleNorm.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}

const NUMBER_RE = /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)*(?:\s?%)?/gu;
/** `25%` and `25` are different numbers: the percent sign stays in the key. */
const numberKey = (s: string): string => s.replace(/[,\s]/gu, '');

const SPELLED_NUMBER = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|' +
    'fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|' +
    'eighty|ninety|hundred|thousand|million)(?![\\p{L}\\p{N}])',
  'giu',
);

const CERT_ACRONYMS =
  'PMP|PMI-ACP|CAPM|CISSP|CISA|CISM|CPA|CFA|CCNA|CCNP|CSM|PSM|ITIL|PRINCE2|TOGAF|CEH|OSCP|PHR|SPHR|SHRM-CP|CKA|CKAD|CKS|Security\\+|Network\\+';
const CERT_RES: RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${CERT_ACRONYMS})(?![\\p{L}\\p{N}])`, 'gu'),
  /(?<![\p{L}\p{N}])certified\s+\p{L}[\p{L}\p{N}-]*(?:\s+\p{Lu}[\p{L}\p{N}-]*){0,3}/giu,
  /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}&-]+\s+){1,4}(?:certification|certificate)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:lean\s+)?six\s+sigma\s+(?:white|yellow|green|black)\s+belt/giu,
];
const DEGREE_RES: RegExp[] = [
  /(?<![\p{L}\p{N}.])(?:B\.?Sc|M\.?Sc|B\.?A|M\.?A|MBA|B\.?Eng|M\.?Eng|LLB|LLM|PhD|Ph\.D)(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:bachelor|master)(?:['’]?s)?\s+(?:of|in|degree)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])(?:doctorate|diploma)(?![\p{L}\p{N}])/giu,
];

const COMPANY_SUFFIX = new Set(
  'ltd inc corp corporation llc llp gmbh co company group university college institute bank systems technologies solutions labs'.split(
    ' ',
  ),
);
const ACTION_VERB = /^\p{Lu}\p{Ll}+(?:ed|ing)$/u;
const IRREGULAR_VERBS = new Set(
  'Led Ran Built Drove Wrote Oversaw Made Taught Set Won Kept Sold Grew Cut Began Brought Chose Found Gave Held Taught Took Sent Spoke Wrote'.split(
    ' ',
  ),
);
const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
/** A capitalised word that is not a month name (dates sit next to employers). */
const CAP = `(?!${MONTH}(?![\\p{L}\\p{N}]))\\p{Lu}\\p{Ll}[\\p{L}\\p{N}'’-]*`;
const CAP_LEFT = `(?<![\\p{L}\\p{N}.'’-])`;
/** Two or more capitalised words separated by single spaces (and `of` / `and` / `&`). */
const CAP_RUN = new RegExp(`${CAP_LEFT}${CAP}(?:(?: (?:of|and|&))? ${CAP})+`, 'gu');
/** One capitalised word. */
const CAP_WORD = new RegExp(`${CAP_LEFT}${CAP}`, 'gu');
const CONNECTORS = new Set(['of', 'and', '&']);
/** A modifier before a CV phrase (`Senior Operations Analyst`) does not make a new phrase. */
const MODIFIERS = new Set(
  'former senior junior lead bilingual associate assistant chief head principal interim acting'.split(
    ' ',
  ),
);
/** Capitalised words that are not names of employers. */
const COMMON_CAPITALISED = new Set(
  (
    'i english hebrew arabic russian french spanish german italian chinese present current ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april ' +
    'june july august september october november december mr ms mrs dr'
  ).split(' '),
);
/** Headings of the answer and generic CV words that are not employer-like phrases. */
const IGNORED_PHRASES = new Set(['work experience', 'technical skills', 'key skills']);

const PLACEHOLDER_RE = /\[[^[\]\n]{0,80}\]/gu;
/** Other placeholder shapes: `{Company}`, `<Your Name>`, `XX%`, `____`. */
const OTHER_PLACEHOLDER_RES: RegExp[] = [
  /\{[^{}\n]{1,60}\}/gu,
  /<[^<>\n]{1,60}>/gu,
  /(?<![\p{L}\p{N}])X{2,}%?(?![\p{L}\p{N}])/gu,
  /_{3,}/gu,
];
const NUMBER_PLACEHOLDER = /^\[\s*number\s*\?\s*\]$/iu;
const REMOVED_MARKER = /^\[removed\]$/iu;

/**
 * A certificate phrase is in the CV when the phrase, or its last two words (`data certificate`
 * after `Hold a Google Data certificate`), appears there.
 */
function certInCv(cvNorm: string, phrase: string): boolean {
  const words = norm(phrase).split(' ');
  for (let k = 0; k <= Math.max(0, words.length - 2); k += 1) {
    if (containsWord(cvNorm, words.slice(k).join(' '))) return true;
  }
  return false;
}

const catalogWordCache = new WeakMap<MatchTaxonomy, Set<string>>();

/** Every lower-case word of a catalog skill name, keyword or tool label. */
function catalogWords(taxonomy: MatchTaxonomy, tools: readonly string[] | undefined): Set<string> {
  const base =
    catalogWordCache.get(taxonomy) ??
    new Set(
      taxonomy.skills
        .flatMap((sk) => [sk.name, ...sk.keywords])
        .flatMap((t) => norm(t).split(/[^\p{L}\p{N}+#]+/u))
        .filter(Boolean),
    );
  catalogWordCache.set(taxonomy, base);
  const labels = tools ?? catalogToolLabels();
  const all = new Set(base);
  for (const w of labels.flatMap((t) => norm(t).split(/[^\p{L}\p{N}+#]+/u))) if (w) all.add(w);
  return all;
}

function isSentenceStart(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /[ \t\-•*▪◦·–]/u.test(text.charAt(i))) i -= 1;
  return i < 0 || /[\n.!?:]/u.test(text.charAt(i));
}

function* matches(re: RegExp, text: string): Generator<RegExpMatchArray> {
  yield* text.matchAll(re);
}

/**
 * Checks an answer against the CV it was made from. Returns the cleaned text and the items for
 * the user to verify; nothing is rejected.
 * - Personal details are removed (`redactCvPii`, so tool names like `ASP.NET` survive).
 * - Flags every number, catalog skill or tool, certificate, degree and employer-like phrase (two or
 *   more capitalised words in a row, for example `Acme Widgets Ltd`) that the CV does not contain
 *   (case-insensitive, whole words). A single capitalised word that is not a catalog name is not
 *   flagged: that is a known gap.
 * - `[number?]` is allowed and counted; every other bracketed placeholder is flagged.
 * Pass the tailored text (`parseTailorOutput(raw).text`), not the notes: `gap:` lines name things
 * the CV lacks on purpose.
 */
export function checkTailoredOutput(
  output: string,
  cvText: string,
  options: TailorCheckOptions = {},
): TailorCheckResult {
  const taxonomy = options.taxonomy ?? CATALOG_TAXONOMY;
  const cleaned = removeControlChars(output);
  const red = redactCvPii(cleaned, options);
  const cut = cutAtLine(red.text, MAX_CV_TAILOR_OUTPUT);
  const text = cut.text;

  const flags: TailorFlag[] = [];
  const seen = new Set<string>();
  const add = (kind: TailorFlagKind, t: string): void => {
    const key = `${kind}|${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push({ kind, text: t });
  };

  const cvNorm = norm(cvText);

  // Numbers.
  const cvNumbers = new Set<string>();
  for (const m of matches(NUMBER_RE, cvText)) cvNumbers.add(numberKey(m[0]));
  for (const m of matches(NUMBER_RE, text)) {
    if (!cvNumbers.has(numberKey(m[0]))) add('number', m[0].trim());
  }

  // Catalog skills and tools.
  const mine = { taxonomy, tools: options.tools };
  const inCv = findCatalogMentions(cvText, mine);
  const inOut = findCatalogMentions(text, mine);
  const skillNames = new Map(taxonomy.skills.map((s) => [s.id, s.name]));
  const cvSkills = new Set(inCv.skills);
  const cvTools = new Set(inCv.tools);
  for (const id of inOut.skills) if (!cvSkills.has(id)) add('skill', skillNames.get(id) ?? id);
  for (const tool of inOut.tools) if (!cvTools.has(tool)) add('skill', tool);

  // Certificates and degrees: the matched phrase must be in the CV.
  for (const re of CERT_RES) {
    for (const m of matches(re, text)) {
      if (!certInCv(cvNorm, m[0])) add('certificate', m[0].trim());
    }
  }
  for (const re of DEGREE_RES) {
    for (const m of matches(re, text)) {
      if (!containsWord(cvNorm, norm(m[0]))) add('degree', m[0].trim());
    }
  }

  // Employer-like phrases: two or more capitalised words in a row.
  const roleNorm = norm(options.targetRole ?? '');
  const known = catalogWords(taxonomy, options.tools);
  const runRanges: [number, number][] = [];
  for (const m of matches(CAP_RUN, text)) {
    const at = m.index ?? 0;
    runRanges.push([at, at + m[0].length]);
    let phrase = m[0];
    // The first word of a bullet is capitalised anyway and is usually an action verb
    // (`Led Weekly Reviews`, `Managed Vendor Contracts`): leave it out of the phrase.
    if (isSentenceStart(text, at)) {
      const first = phrase.slice(0, phrase.indexOf(' '));
      if (ACTION_VERB.test(first) || IRREGULAR_VERBS.has(first)) {
        phrase = phrase.slice(first.length + 1);
        const words = phrase.split(' ');
        const last = (words[words.length - 1] ?? '').toLowerCase();
        // What is left of a bullet is an employer only when it is long or ends like a company.
        if (words.length < 3 && !COMPANY_SUFFIX.has(last)) continue;
      }
    }
    // `Senior Operations Analyst` when the CV has `Operations Analyst`.
    const head = phrase.slice(0, phrase.indexOf(' ')).toLowerCase();
    if (MODIFIERS.has(head)) {
      const rest = phrase.slice(phrase.indexOf(' ') + 1);
      if (containsWord(cvNorm, norm(rest)) || !rest.includes(' ')) continue;
      phrase = rest;
    }
    const key = norm(phrase);
    // `Tableau and Python`: only catalog names.
    if (
      phrase
        .split(' ')
        .filter((w) => !CONNECTORS.has(w))
        .every((w) => known.has(norm(w)))
    ) {
      continue;
    }
    if (IGNORED_PHRASES.has(key) || containsWord(cvNorm, key) || containsWord(roleNorm, key)) {
      continue;
    }
    // An expansion of an acronym the CV has (`Project Management Professional` for `PMP`).
    const initials = phrase
      .split(' ')
      .filter((w) => !CONNECTORS.has(w))
      .map((w) => w.charAt(0))
      .join('');
    if (
      initials.length >= 2 &&
      /^\p{Lu}+$/u.test(initials) &&
      new RegExp(`(?<![\\p{L}\\p{N}])${initials}(?![\\p{L}\\p{N}])`, 'u').test(cvText)
    ) {
      continue;
    }
    add('term', phrase);
  }

  // A single capitalised word in the middle of a sentence that is not in the CV, not a catalog
  // name and not a common word: possibly an invented employer or tool. Noisy by design.
  for (const m of matches(CAP_WORD, text)) {
    const at = m.index ?? 0;
    if (runRanges.some(([s0, e0]) => at >= s0 && at < e0)) continue;
    if (isSentenceStart(text, at)) continue;
    const lower = norm(m[0]);
    if (
      COMMON_CAPITALISED.has(lower) ||
      known.has(lower) ||
      containsWord(cvNorm, lower) ||
      containsWord(roleNorm, lower)
    ) {
      continue;
    }
    add('term', m[0]);
  }

  // Numbers written as words (`thirty`), unless the CV uses the word.
  for (const m of matches(SPELLED_NUMBER, text)) {
    const word = norm(m[0]);
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 8);
    if (word === 'one' && /^\s+(?:of|another|or)\b/iu.test(after)) continue;
    if (!containsWord(cvNorm, word)) add('number', m[0]);
  }

  // Placeholders.
  let numberPlaceholders = 0;
  let removedMarkers = 0;
  for (const m of matches(PLACEHOLDER_RE, text)) {
    if (NUMBER_PLACEHOLDER.test(m[0])) numberPlaceholders += 1;
    else if (REMOVED_MARKER.test(m[0])) removedMarkers += 1;
    else add('placeholder', m[0]);
  }
  for (const re of OTHER_PLACEHOLDER_RES) {
    for (const m of matches(re, text)) add('placeholder', m[0]);
  }

  return {
    text,
    flags,
    numberPlaceholders,
    removedMarkers,
    redacted: red.count,
    truncated: cut.cut,
  };
}
