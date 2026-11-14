import type { PlanFile } from '../schemas';
import { findPii, type RedactOptions } from '../practice/redact';
import { indexCatalog, type BuildCatalog } from './catalog';
import { levelLabel } from './context';
import type { BuildDraft, BuildItem, BuildRequest } from './schemas';
import { computeTargets } from './targets';

/**
 * Optional AI explanations of the plan builder (ADR 017 section 3, WP-4). Pure and deterministic.
 *
 * What a model may see is decided HERE, from the draft the server rebuilt itself: `planExplainInput`
 * copies an allowlist of fields (catalog ids, titles, providers, skill names, role titles, hours,
 * weights, level names, fixed booleans) and nothing else. The request has no free text, and
 * nothing from the profile or CV is read. What comes back is checked line by line
 * (`checkExplainLine`): a line that names anything outside the input is dropped and the template
 * line stays. The model only ever rewrites one short sentence per item.
 */

export const PLAN_EXPLAIN_MAX_ITEMS = 30;
export const PLAN_EXPLAIN_MAX_SKILLS = 4;
export const PLAN_EXPLAIN_MIN_LINE = 15;
export const PLAN_EXPLAIN_MAX_LINE = 200;
const MAX_RAW_LINES = 200;

export interface PlanExplainSkill {
  /** Catalog skill name. */
  name: string;
  /** The role's weight for the skill, 1 to 5 (4 for a skill the user asked for by name). */
  weight: number;
  /** One of the four level labels (`LEVEL_LABELS`). */
  level: string;
  /** True when the user asked for this skill by name. */
  extra: boolean;
}

export interface PlanExplainItem {
  /** The catalog id. */
  id: string;
  title: string;
  provider: string;
  kind: 'course' | 'exam' | 'practice';
  tier: 'core' | 'optional';
  origin: string;
  hours: number;
  free: boolean;
  certificate: boolean;
  skills: PlanExplainSkill[];
  /** The template "why" line (built from catalog names and numbers only): the facts to rewrite. */
  baseline: string;
}

export interface PlanExplainInput {
  /** Catalog role titles. */
  roles: string[];
  items: PlanExplainItem[];
}

/**
 * The exact keys a model can ever be given (tests pin them). Anything not listed here cannot be
 * sent: add a key only after checking that it can hold no user text.
 */
export const PLAN_EXPLAIN_ROOT_KEYS = ['items', 'roles'] as const;
export const PLAN_EXPLAIN_ITEM_KEYS = [
  'baseline',
  'certificate',
  'free',
  'hours',
  'id',
  'kind',
  'origin',
  'provider',
  'skills',
  'tier',
  'title',
] as const;
export const PLAN_EXPLAIN_SKILL_KEYS = ['extra', 'level', 'name', 'weight'] as const;

/**
 * The allowlisted input for a draft. `request` supplies the role ids and the user's levels (small
 * integers); every string in the result is a catalog string. At most `maxItems` items (the first
 * in plan order); the others keep their template line.
 */
export function planExplainInput(
  draft: BuildDraft,
  request: BuildRequest,
  catalog: BuildCatalog,
  maxItems: number = PLAN_EXPLAIN_MAX_ITEMS,
): PlanExplainInput {
  const index = indexCatalog(catalog);
  const targets = new Map(computeTargets(request, index).map((t) => [t.skillId, t]));
  const roles = request.targetRoleIds
    .map((id) => index.roles.get(id)?.title)
    .filter((t): t is string => t !== undefined);
  const items = draft.items.slice(0, Math.max(0, maxItems)).map((i): PlanExplainItem => ({
    id: i.catalogId,
    title: i.title,
    provider: i.provider,
    kind: i.kind,
    tier: i.tier,
    origin: i.origin,
    hours: i.hours,
    free: i.cost.kind === 'free',
    certificate: i.isCertificate,
    skills: i.skillIds.slice(0, PLAN_EXPLAIN_MAX_SKILLS).flatMap((id) => {
      const t = targets.get(id);
      if (!t) return [];
      return [
        {
          name: index.skillNames.get(id) ?? id,
          weight: t.weight,
          level: levelLabel(t.level),
          extra: t.extra,
        },
      ];
    }),
    baseline: i.why,
  }));
  return { roles, items };
}

/** The instructions: fixed text, no user data. */
export const PLAN_EXPLAIN_SYSTEM = [
  'You write one short "why this is here" sentence for each item of a study plan.',
  'The user message is JSON with "roles" and "items". Each item has an "id" and a "baseline" sentence that is already correct.',
  'Rewrite each baseline as one friendly sentence of at most 25 words, in the second person.',
  'Use only facts from that item: its title, provider, skills, weights, levels, hours, free and certificate flags, and the baseline text.',
  'Never mention another item, a skill that is not listed for that item, a price, a link, a certificate (unless "certificate" is true), a date, or any number that is not in the item.',
  'Never promise a result. No markdown, no quotes, no lists inside a sentence.',
  'Answer with exactly one line per item, in the same order, in the form: <id>: <sentence>',
  'Print nothing else.',
].join('\n');

/** The user message: the input as compact JSON (key order is fixed, so the same draft gives the same text). */
export function planExplainUserMessage(input: PlanExplainInput): string {
  return JSON.stringify(input);
}

// ---------------------------------------------------------------- parsing

const LINE_RE =
  /^\s*(?:[-*•]\s*|\d{1,3}[.)]\s+)?[`*_"']*([a-z0-9][a-z0-9-]{0,79})[`*_"']*\s*[:|]\s*(.+?)\s*$/u;

/**
 * Splits an answer into `id: text` lines. Only ids in `ids` count; the first line for an id wins;
 * anything else (a preamble, an invented id, a refusal) is ignored. The text is not checked here.
 */
export function parseExplainOutput(raw: string, ids: readonly string[]): Map<string, string> {
  const known = new Set(ids);
  const out = new Map<string, string>();
  for (const line of raw.split(/\r\n|\r|\n/u).slice(0, MAX_RAW_LINES)) {
    if (line.length > 2000) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const id = m[1] as string;
    if (known.has(id) && !out.has(id)) out.set(id, m[2] as string);
  }
  return out;
}

// ---------------------------------------------------------------- checking

export type ExplainRejection =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'format'
  | 'link'
  | 'personal'
  | 'number'
  | 'price'
  | 'certificate'
  | 'unknown_name'
  | 'overclaim'
  | 'injection';

export type ExplainCheck = { ok: true; text: string } | { ok: false; reason: ExplainRejection };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

function nameRegex(name: string): RegExp {
  return new RegExp(`${BOUNDARY_BEFORE}${escapeRe(name)}${BOUNDARY_AFTER}`, 'giu');
}

/** Names shorter than this are not looked for (single letters would match everywhere). */
const MIN_NAME = 3;

/** Every catalog name a line could wrongly mention: item titles, providers, skills, roles. */
function catalogNames(catalog: BuildCatalog): string[] {
  const names = new Set<string>();
  for (const i of catalog.items) {
    names.add(i.title);
    names.add(i.provider);
  }
  for (const s of catalog.skills) names.add(s.name);
  for (const r of catalog.roles) names.add(r.title);
  return [...names].filter((n) => n.trim().length >= MIN_NAME);
}

const nameCache = new WeakMap<BuildCatalog, { name: string; re: RegExp }[]>();
function foreignMatchers(catalog: BuildCatalog): { name: string; re: RegExp }[] {
  let list = nameCache.get(catalog);
  if (!list) {
    list = catalogNames(catalog)
      .sort((a, b) => b.length - a.length)
      .map((name) => ({ name, re: nameRegex(name) }));
    nameCache.set(catalog, list);
  }
  return list;
}

/** The names a line about `entry` may use: its own title, provider, skills, the role titles, and the names its baseline uses. */
function allowedNames(
  entry: PlanExplainItem,
  roles: readonly string[],
  catalog: BuildCatalog,
): string[] {
  const own = [entry.title, entry.provider, ...entry.skills.map((s) => s.name), ...roles];
  const inBaseline = foreignMatchers(catalog)
    .filter((m) => entry.baseline.match(m.re) !== null)
    .map((m) => m.name);
  return [...new Set([...own, ...inBaseline])].filter((n) => n.trim().length > 0);
}

function stripNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(nameRegex(name), ' ');
  }
  return out;
}

const URL_LIKE =
  /(?:https?:|www\.|\/\/|[\p{L}\p{N}-]{2,}\.[\p{L}]{2,}(?![\p{L}\p{N}])|\.[\p{L}]{2,}\/)/iu;
const PRICE_RE =
  /(?:[$€£₪¥]|\b(?:usd|eur|ils|dollars?|euros?|shekels?|prices?|priced|pricing|costs?|costly|cheap\w*|affordabl\w*|discount\w*|fees?|subscriptions?|paid|pay|pays|payment|money)\b)/iu;
const CERT_RE =
  /\b(?:certificates?|certificat\w*|certified|certify|certifications?|exams?|diplomas?|degrees?|badges?|credentials?|accredit\w*)\b/iu;
const OVERCLAIM_RE =
  /\b(?:guarantee[sd]?|promise[sd]?|hired|hiring|job offers?|salary|salaries|earn|income|expert|master(?:y|ed)?|fluent|best|top-rated|number one)\b/iu;
const INJECTION_RE =
  /(?:\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instruction|prompt|rules?|above|previous|earlier)|system prompt|as an ai\b|language model|\bi (?:cannot|can't|can not|am unable|am sorry|apologi[sz]e)\b|^\s*(?:sorry|unfortunately)\b)/iu;
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|hundred|thousand|million|dozen|half|twice|double|triple)\b/iu;
const FREE_RE = /\bfree\b/iu;
// Letters, numbers, punctuation and spaces only: no markup characters, symbols, emoji or control characters.
const ALLOWED_CHARS = /^[\p{L}\p{N}\p{P}\p{Zs}]*$/u;
const MARKUP = /[`*_#<>[\]{}|\\~^@=+]/u;

function numeralsOf(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/gu) ?? []);
}

/** The numbers an item's own line may use: its hours, weights and its baseline's numbers. */
function allowedNumbers(entry: PlanExplainItem): Set<string> {
  const set = numeralsOf(entry.baseline);
  const add = (n: number) => {
    set.add(String(n));
    if (Number.isInteger(n)) set.add(`${n}.0`);
  };
  add(entry.hours);
  for (const s of entry.skills) add(s.weight);
  return set;
}

/**
 * Checks one line the model wrote for one item. Returns the cleaned text, or why it was refused.
 * A refused line is replaced by the template line by the caller. The checks, in order: length and
 * characters, links and personal details, prices, certificates, spelled-out and written numbers,
 * names of anything outside the item's own entry, over-claims, and instructions or refusals.
 */
export function checkExplainLine(
  rawText: string,
  entry: PlanExplainItem,
  input: Pick<PlanExplainInput, 'roles'>,
  catalog: BuildCatalog,
  options: RedactOptions = {},
): ExplainCheck {
  let text = rawText
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  // A pair of quotes around the whole sentence is decoration.
  text = text.replace(/^(["'“”‘’])(.*)\1$/u, '$2').trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length < PLAN_EXPLAIN_MIN_LINE) return { ok: false, reason: 'too_short' };
  if (text.length > PLAN_EXPLAIN_MAX_LINE) return { ok: false, reason: 'too_long' };

  const names = allowedNames(entry, input.roles, catalog);
  // What is left once the item's own catalog names are taken out: names may hold dots, digits and symbols.
  const rest = stripNames(text, names);

  if (!ALLOWED_CHARS.test(rest) || MARKUP.test(rest)) return { ok: false, reason: 'format' };
  if (URL_LIKE.test(rest)) return { ok: false, reason: 'link' };
  if (findPii(rest, options).length > 0 || findPii(text, options).includes('identifier')) {
    return { ok: false, reason: 'personal' };
  }
  if (INJECTION_RE.test(text)) return { ok: false, reason: 'injection' };
  if (PRICE_RE.test(rest) || (!entry.free && FREE_RE.test(rest))) {
    return { ok: false, reason: 'price' };
  }
  if (!entry.certificate && entry.kind !== 'exam' && CERT_RE.test(rest)) {
    return { ok: false, reason: 'certificate' };
  }
  const allowed = allowedNumbers(entry);
  for (const n of rest.match(/\d+(?:\.\d+)?/gu) ?? []) {
    if (!allowed.has(n)) return { ok: false, reason: 'number' };
  }
  if (NUMBER_WORDS.test(rest)) return { ok: false, reason: 'number' };
  for (const m of foreignMatchers(catalog)) {
    if (m.re.test(rest)) return { ok: false, reason: 'unknown_name' };
  }
  if (OVERCLAIM_RE.test(rest)) return { ok: false, reason: 'overclaim' };
  return { ok: true, text };
}

export interface ExplainedLine {
  itemId: string;
  text: string;
  source: 'ai' | 'template';
}

export interface ExplainOutcome {
  /** One line per item of the DRAFT, in plan order. */
  lines: ExplainedLine[];
  /** How many lines are the model's. */
  aiCount: number;
}

/**
 * The lines of an answer: the model's line where it passed every check, the template line
 * (`item.why`) everywhere else, for every item of the draft (also the ones that were not sent).
 */
export function explainedLines(
  raw: string | null,
  draft: Pick<BuildDraft, 'items'>,
  input: PlanExplainInput,
  catalog: BuildCatalog,
  options: RedactOptions = {},
): ExplainOutcome {
  const parsed =
    raw === null
      ? new Map<string, string>()
      : parseExplainOutput(
          raw,
          input.items.map((i) => i.id),
        );
  const sent = new Map(input.items.map((i) => [i.id, i]));
  let aiCount = 0;
  const lines = draft.items.map((item: BuildItem): ExplainedLine => {
    const entry = sent.get(item.catalogId);
    const candidate = parsed.get(item.catalogId);
    if (entry && candidate !== undefined) {
      const checked = checkExplainLine(candidate, entry, input, catalog, options);
      if (checked.ok) {
        aiCount += 1;
        return { itemId: item.catalogId, text: checked.text, source: 'ai' };
      }
    }
    return { itemId: item.catalogId, text: item.why, source: 'template' };
  });
  return { lines, aiCount };
}

/**
 * The plan file with the AI lines in the task notes. Only the template "why" sentence at the
 * start of a note is replaced; every other note, and every id, order, hour, cost and link, stays
 * as `buildPlan` made it. `lines` must come from `explainedLines` (never from a client).
 */
export function applyExplainLines(
  draft: Pick<BuildDraft, 'plan' | 'items'>,
  lines: readonly ExplainedLine[],
): PlanFile {
  const aiText = new Map(lines.filter((l) => l.source === 'ai').map((l) => [l.itemId, l.text]));
  const replace = new Map<string, { why: string; text: string }>();
  for (const item of draft.items) {
    const text = aiText.get(item.catalogId);
    if (text === undefined || item.why.length === 0) continue;
    for (const taskId of item.taskIds) replace.set(taskId, { why: item.why, text });
  }
  return {
    ...draft.plan,
    tasks: draft.plan.tasks.map((task) => {
      const r = replace.get(task.id);
      if (!r || typeof task.notes !== 'string' || !task.notes.startsWith(r.why)) return task;
      return { ...task, notes: r.text + task.notes.slice(r.why.length) };
    }),
  };
}
