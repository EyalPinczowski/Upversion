import { catalogToolLabels, CATALOG_TAXONOMY } from '../profile/catalog';
import { dropContactLines, splitCvLines } from '../profile/cv-match';
import { neutraliseMarkup } from '../practice/prompt';
import type { PiiKind, RedactOptions } from '../practice/redact';
import { findPii, redactPii } from '../practice/redact';

/**
 * Cleaning of CV and job-post text before it can go to an AI model (ADR 016 section 2.2).
 * Pure: no I/O, no network, no new dependency; `redactPii` itself is unchanged.
 *
 * ONE shared allowance for name-like tool names. `redactPii` treats `ASP.NET` and `monday.com`
 * as hosts. Both functions here (`redactCvPii` for the browser, `findCvPii` for the server's
 * strict check) first swap such catalog names for a letters-only stand-in, run `redactPii` /
 * `findPii` on that, and put the names back. The server must call `findCvPii` (not `findPii`)
 * on CV and job text, or it would reject text the browser accepted.
 *
 * Limits of the allowance (by design, so it cannot hide a real host):
 * - Only names in `skills.json` (name and keywords) and the `tools_known` labels that
 *   `redactPii` would otherwise touch are allowed.
 * - Whole tokens only: the name must not touch a letter, digit, `@`, `/`, `_`, `-`, `:` or a
 *   further `.label`. `jo@monday.com`, `https://monday.com/x`, `www.monday.com`, `monday.com.evil.io`
 *   and `monday.com/login` are still found. A trailing full stop ("I used monday.com.") is fine.
 * - Matching is on the raw text. Look-alike characters (full-width letters, zero-width
 *   characters inside the name) are not allowed, so they are redacted as before.
 * - A name that contains one of the user's known identifiers (a user called "Monday") is not
 *   allowed, so the identifier is still removed.
 */

/**
 * Well-known dotted tool names that are NOT in the catalog (checked: `skills.json` and
 * `tools_known` hold only `monday.com`), so a CV or job post naming them is not mangled.
 * Only names `redactPii` would touch matter (`Node.js` and `Vue.js` already pass). Extend in review.
 */
export const EXTRA_ALLOWED_TOOL_NAMES: readonly string[] = [
  'ASP.NET',
  'VB.NET',
  'Socket.IO',
  'Node.js',
  'Vue.js',
  'Next.js',
  'Nuxt.js',
  'Express.js',
];

/** Names that `redactPii` would touch (hosts such as `ASP.NET`), longest first. */
let skipNames: string[] | null = null;

function splitAliases(text: string): string[] {
  return text
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowedNames(): readonly string[] {
  if (skipNames) return skipNames;
  const all = new Set<string>();
  for (const s of CATALOG_TAXONOMY.skills) {
    for (const t of [s.name, ...s.keywords].flatMap(splitAliases)) all.add(t);
  }
  for (const label of catalogToolLabels().flatMap(splitAliases)) all.add(label);
  for (const name of EXTRA_ALLOWED_TOOL_NAMES) all.add(name);
  skipNames = [...all]
    .filter((name) => name.includes('.') && redactPii(name).count > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return skipNames;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let skipRe: RegExp | null = null;
function skipPattern(): RegExp | null {
  const names = allowedNames();
  if (names.length === 0) return null;
  skipRe ??= new RegExp(
    `(?<![\\p{L}\\p{N}@/_:.-])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}@/_:-]|\\.[\\p{L}\\p{N}])`,
    'giu',
  );
  return skipRe;
}

/** A letters-only stand-in: no digit, dot or `@`, so no PII rule can match it. */
function standIn(index: number): string {
  let letters = '';
  let n = index;
  do {
    letters += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26);
  } while (n > 0);
  return `qzskipx${letters}xqz`;
}

interface Masked {
  text: string;
  names: string[];
}

function mask(text: string, options: RedactOptions): Masked {
  const re = skipPattern();
  if (!re) return { text, names: [] };
  const names: string[] = [];
  const index = new Map<string, number>();
  const blocked = new Map<string, boolean>();
  const ids = options.knownIdentifiers ?? [];
  const out = text.replace(re, (name: string) => {
    const key = name.toLowerCase();
    let isBlocked = blocked.get(key);
    if (isBlocked === undefined) {
      isBlocked = ids.length > 0 && redactPii(name.replace(/\./g, ' '), options).count > 0;
      blocked.set(key, isBlocked);
    }
    if (isBlocked) return name;
    let i = index.get(name);
    if (i === undefined) {
      i = names.length;
      names.push(name);
      index.set(name, i);
    }
    return standIn(i);
  });
  return { text: out, names };
}

function unmask(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  return text.replace(/qzskipx([a-z]+)xqz/g, (whole, letters: string) => {
    let n = 0;
    for (let k = letters.length - 1; k >= 0; k -= 1) n = n * 26 + (letters.charCodeAt(k) - 97);
    return names[n] ?? whole;
  });
}

/** `redactPii` with the shared tool-name allowance. Same result shape. */
export function redactCvPii(
  text: string,
  options: RedactOptions = {},
): { text: string; count: number } {
  const m = mask(text, options);
  const r = redactPii(m.text, options);
  return { text: unmask(r.text, m.names), count: r.count };
}

/** `findPii` with the shared tool-name allowance: what the server runs on CV and job text. */
export function findCvPii(text: string, options: RedactOptions = {}): PiiKind[] {
  return findPii(mask(text, options).text, options);
}

export interface PreparedText {
  /** The cleaned text, exactly what the preview shows and the server checks. */
  text: string;
  /** Lines removed as contact block or references (shown to the user, never sent). */
  dropped: string[];
  /** How many personal-detail spans were replaced by `[removed]`. */
  removed: number;
}

function collapseBlankLines(lines: readonly string[]): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/u, '');
    if (line === '') {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/** C0/C1 controls (except tab and newline), bidi overrides and zero-width characters. */
const CONTROL_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'gu',
);

export function removeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/**
 * Prepares CV text for an AI model: drops the contact block, a Contact / Personal details
 * section and a References section (the matcher's rule, `dropContactLines`), neutralises markup
 * and control characters, then removes personal details with `redactCvPii`.
 */
export function prepareCvForAi(text: string, options: RedactOptions = {}): PreparedText {
  const lines = splitCvLines(removeControlChars(text));
  const drop = dropContactLines(lines);
  const dropped = lines.filter((l, i) => drop.has(i) && l.trim() !== '').map((l) => l.trim());
  const kept = lines.filter((_, i) => !drop.has(i));
  const r = redactCvPii(neutraliseMarkup(collapseBlankLines(kept)), options);
  return { text: r.text, dropped, removed: r.count };
}

/**
 * Prepares a job post: the same steps without the contact-block drop (a post's first lines are
 * its title).
 */
export function prepareJobForAi(text: string, options: RedactOptions = {}): PreparedText {
  const clean = collapseBlankLines(splitCvLines(removeControlChars(text)));
  const r = redactCvPii(neutraliseMarkup(clean), options);
  return { text: r.text, dropped: [], removed: r.count };
}
