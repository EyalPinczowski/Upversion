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
  | 'assurance'
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
/**
 * Strict on purpose: ANY mention of price, cost, money or "free" is refused, because whether it is
 * true depends on a price the catalog may not have verified. The template line carries the price
 * facts; the AI line never does.
 */
const PRICE_RE =
  /(?:[$€£₪¥]|\b(?:usd|eur|ils|dollars?|euros?|shekels?|prices?|priced|pricing|costs?|costly|cost-?free|cheap\w*|affordabl\w*|discount\w*|fees?|subscriptions?|paid|pays?|payment|money|free|gratis|complimentary|charge[sd]?|nothing|zero|budget\w*|sale|deals?|bargain\w*|offers?|offered|premium|trial|worth)\b)/iu;
/**
 * Verification and assurance wording: a line must never say a link, price or detail is checked,
 * confirmed, current, safe, official or trusted (the catalog marks unverified items "needs check").
 */
const ASSURANCE_RE =
  /\b(?:verif\w*|confirm\w*|up[\s-]*to[\s-]*date|current\w*|latest|newest|safe\w*|secur\w*|trust\w*|official\w*|recogni[sz]\w*|accredit\w*|guarantee\w*|reliabl\w*|legit\w*|check\w*|needs?\s+check|valid\w*|authentic\w*|endors\w*|approv\w*|certified|renown\w*|reputable|leading|world[\s-]*class|top|best|proven|genuine|real|actual\w*|accurate\w*|correct\w*)\b/iu;
const CONTACT_RE =
  /\b(?:linkedin|contact\w*|ask\w*|e-?mail\w*|messag\w*|call\w*|phone\w*|dm|follow\w*|subscribe\w*|visit\w*|click\w*|sign\s?up|regist\w*|enrol\w*|enroll\w*|apply|applying|refund\w*|support|instructor\w*|teacher\w*|professor\w*|mentor\w*|universit\w*|college\w*|school\w*)\b/iu;
const CERT_RE =
  /\b(?:certificates?|certificat\w*|certified|certify|certifications?|exams?|diplomas?|degrees?|badges?|credentials?|accredit\w*)\b/iu;
const OVERCLAIM_RE =
  /\b(?:promise[sd]?|hired|hiring|job offers?|salary|salaries|earn|income|expert|master(?:y|ed)?|fluent|number one)\b/iu;
const INJECTION_RE =
  /(?:\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instruction|prompt|rules?|above|previous|earlier)|system prompt|as an ai\b|language model|\bi (?:cannot|can't|can not|am unable|am sorry|apologi[sz]e)\b|^\s*(?:sorry|unfortunately)\b)/iu;
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|hundred|thousand|million|dozen|half|twice|double|triple)\b/iu;
// Latin letters, numbers, punctuation and spaces only: no markup, symbols, emoji, other scripts or control characters.
const ALLOWED_CHARS = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]*$/u;
const MARKUP = /[`*_#<>[\]{}|\\~^@=+]/u;

/** Words any line may use besides the item's own words: function words and a few plain teaching words. */
const COMMON_WORDS = new Set(
  `a an the and or but so yet nor to of in on at for with without by from as into onto up down out over under about around
   across after before during until while once then than too very much many more most less least also just only even still
   again already soon later next first second last each every all any some both either neither other another such same
   is are was were be been being am it its this that these those there here now how what which who whom whose when where why
   i me my we us our you your yours he she him her his they them their will would can could shall should may might must do does
   did done have has had having not no yes if else because since though although whether
   s ll re ve d t m
   skill skills basic basics step steps learn learns learning learned teach teaches teaching taught build builds building built
   practice practise practises practising course courses lesson lessons item items plan plans role roles target targets goal goals
   need needs needed get gets getting started start starts ready solid strong foundation foundations understand understands
   understanding cover covers covering covered introduce introduces introduction work works working hands confidence
   comfortable short quick focused key core main important essential help helps helping make makes making let lets use uses using
   prepare prepares preparing practical daily day week weeks days towards toward along way move moving progress ahead fit fits
   good great useful lay lays gain gains develop develops grow grows deepen deepens sharpen sharpens train trains topic topics
   concept concepts tool tools data one path stage stages part parts piece pieces gap gaps level levels weight weights
   rated rate rates early beginning begin begins fundamentals fundamental ground groundwork complete finishes finish finishing
   well easy easily clear clearly simple simply new`
    .split(/\s+/u)
    .filter((w) => w.length > 0),
);

const wordsOf = (text: string): string[] =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .match(/\p{L}+/gu) ?? [];

/* eslint-disable no-misleading-character-class */
const INVISIBLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;
/* eslint-enable no-misleading-character-class */

/** The numeral and the unit word after it ("6 hours"), as `6|hours`; `6|` when no word follows. */
function numeralKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(?:[ \t]+(\p{L}+))?/gu)) {
    keys.push(`${m[1]}|${(m[2] ?? '').toLowerCase()}`);
  }
  return keys;
}

/**
 * Checks one line the model wrote for one item. Returns the cleaned text, or why it was refused.
 * A refused line is replaced by the template line by the caller. The text is normalised first
 * (NFKC, invisible characters removed), then checked in order: length and characters, links and
 * personal details, instructions, price/cost/"free" words (any mention), verification and
 * assurance wording, contact words, certificates, numbers (only a numeral+unit that the template
 * line itself has), catalog names outside the item, over-claims, and finally a strict vocabulary:
 * every word must belong to the item (title, provider, skills, roles, template words) or be a
 * common function or teaching word, and no capitalised word may appear inside a sentence unless it
 * belongs to the item. A false drop only means the template line stays.
 */
export function checkExplainLine(
  rawText: string,
  entry: PlanExplainItem,
  input: Pick<PlanExplainInput, 'roles'>,
  catalog: BuildCatalog,
  options: RedactOptions = {},
): ExplainCheck {
  let text = rawText
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
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
  if (PRICE_RE.test(rest)) return { ok: false, reason: 'price' };
  if (ASSURANCE_RE.test(rest)) return { ok: false, reason: 'assurance' };
  if (CONTACT_RE.test(rest)) return { ok: false, reason: 'unknown_name' };
  if (!entry.certificate && entry.kind !== 'exam' && CERT_RE.test(rest)) {
    return { ok: false, reason: 'certificate' };
  }
  const templateKeys = new Set(
    numeralKeys(entry.baseline.normalize('NFKC')).flatMap((k) => [k, `${k.split('|')[0]}|`]),
  );
  for (const key of numeralKeys(rest)) {
    if (!templateKeys.has(key)) return { ok: false, reason: 'number' };
  }
  if (NUMBER_WORDS.test(rest)) return { ok: false, reason: 'number' };
  for (const m of foreignMatchers(catalog)) {
    if (m.re.test(rest)) return { ok: false, reason: 'unknown_name' };
  }
  if (OVERCLAIM_RE.test(rest)) return { ok: false, reason: 'overclaim' };

  // Strict vocabulary: the item's own words plus common words; capitalised words only if the item's.
  const own = new Set(
    wordsOf(
      [
        entry.title,
        entry.provider,
        ...entry.skills.map((s) => s.name),
        ...input.roles,
        entry.baseline,
      ].join(' '),
    ),
  );
  for (const m of rest.matchAll(/\p{L}+/gu)) {
    const word = m[0];
    const lower = word.toLowerCase();
    const before = rest.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.!?:]$/u.test(before);
    const tail = word.slice(1);
    const capitalised = word !== lower && !(sentenceStart && tail === tail.toLowerCase());
    if (capitalised && !own.has(lower)) return { ok: false, reason: 'unknown_name' };
    if (!own.has(lower) && !COMMON_WORDS.has(lower)) return { ok: false, reason: 'unknown_name' };
  }
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
