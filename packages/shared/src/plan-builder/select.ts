import { certificateBudgetReason } from './budget';
import type { CatalogItem } from './catalog';
import { closureOf, itemIssue, prerequisiteMessage, type BuildContext, type Root } from './context';
import type { BuildTier, ExcludedItem, ExcludedReason } from './schemas';
import { gapSkillsOf } from './resolve';

/** Collects the items that were left out and why, one entry per item and reason. */
export class ExclusionLog {
  private readonly seen = new Set<string>();
  readonly list: ExcludedItem[] = [];

  add(entry: ExcludedItem): void {
    const key = `${entry.catalogId}:${entry.reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(entry);
  }

  has(catalogId: string): boolean {
    return this.list.some((e) => e.catalogId === catalogId);
  }
}

const ITEM_REASON_TEXT: Record<string, string> = {
  excluded_by_user: 'You excluded it.',
  free_only: 'Not free, and your budget is free only.',
  price_unknown: 'Its price is not known, so it cannot count against your limit.',
  over_item_price: 'Its price is above your per-item limit.',
  over_budget: 'Its price is above your budget.',
  no_link: 'The catalog has no link for it.',
};

/**
 * Checks one item as a root: item filter, then the closure of its required prerequisites. Returns
 * null when it can be added; otherwise logs why not (when `log` is given) and returns the reason.
 */
export function rootIssue(
  ctx: BuildContext,
  item: CatalogItem,
  log: ExclusionLog | null,
  options: { certificateOnly?: boolean } = {},
): ExcludedReason | null {
  const issue = options.certificateOnly ? itemIssueCertificate(ctx, item) : itemIssue(ctx, item);
  if (issue) {
    log?.add({
      catalogId: item.id,
      reason: issue,
      message: `"${item.title}" is left out. ${ITEM_REASON_TEXT[issue] ?? ''}`.trim(),
    });
    return issue;
  }
  const closure = closureOf(ctx, item);
  if (!closure.ok) {
    log?.add({
      catalogId: item.id,
      reason: 'needs_prerequisite',
      message: prerequisiteMessage(ctx, item, closure.reason, closure.relatedId),
      relatedId: closure.relatedId,
    });
    return 'needs_prerequisite';
  }
  return null;
}

/** For the paid certificate of a `free_audit` item: the course itself must be usable and the certificate must pass the budget. */
function itemIssueCertificate(ctx: BuildContext, item: CatalogItem): ExcludedReason | null {
  if (ctx.excluded.has(item.id)) return 'excluded_by_user';
  if (item.url === null) return 'no_link';
  return certificateBudgetReason(item, ctx.request.budget);
}

function tierFor(ctx: BuildContext, item: CatalogItem, base: BuildTier): BuildTier {
  const override = ctx.request.priorityOverrides[item.id];
  return override ?? base;
}

/** Core when the item is on the suggested core path or teaches a skill the user asked for by name. */
function courseTier(ctx: BuildContext, item: CatalogItem): BuildTier {
  const asked = item.skills.some((s) => ctx.gapIds.has(s) && ctx.targetById.get(s)?.extra);
  return tierFor(ctx, item, ctx.coreIds.has(item.id) || asked ? 'core' : 'optional');
}

/** Items on any target role's suggested paths: the ones worth reporting when they are left out. */
function suggestedIds(ctx: BuildContext): Set<string> {
  const ids = new Set<string>();
  for (const roleId of ctx.request.targetRoleIds) {
    const path = ctx.index.roles.get(roleId)?.suggested_path;
    if (!path) continue;
    for (const id of [...path.core, ...path.optional, ...path.free_only]) ids.add(id);
  }
  return ids;
}

/** Step 3: greedy set cover over the gap skills, plus the user's `mustInclude` courses. Returns course and practice roots. */
export function selectCourses(ctx: BuildContext, log: ExclusionLog): Root[] {
  const roots: Root[] = [];
  const uncovered = new Set(ctx.gapIds);
  const markCovered = (item: CatalogItem) => {
    for (const s of gapSkillsOf(ctx, item)) uncovered.delete(s);
  };

  for (const id of ctx.request.mustInclude) {
    const item = ctx.index.byId.get(id);
    if (!item || item.type === 'cert_exam') continue; // exams: see selectCertificates
    if (rootIssue(ctx, item, log)) continue;
    roots.push({
      id,
      tier: tierFor(ctx, item, 'core'),
      origin: 'must_include',
      paidCertificate: false,
    });
    markCovered(item);
  }
  const chosen = new Set(roots.map((r) => r.id));

  const reportable = suggestedIds(ctx);
  const candidates: CatalogItem[] = [];
  for (const item of ctx.index.items) {
    if (item.type !== 'course' || chosen.has(item.id)) continue;
    if (!item.skills.some((s) => ctx.gapIds.has(s))) continue;
    if (rootIssue(ctx, item, reportable.has(item.id) ? log : null)) continue;
    candidates.push(item);
  }

  const level = (skillId: string) => ctx.request.skillLevels[skillId] ?? 0;
  const supersetOf = (a: CatalogItem, b: CatalogItem) =>
    b.skills.every((s) => a.skills.includes(s));
  const score = (item: CatalogItem): number => {
    let sum = 0;
    for (const s of item.skills) if (uncovered.has(s)) sum += ctx.targetById.get(s)?.priority ?? 0;
    if (sum === 0) return 0;
    let total = sum;
    if (ctx.coreIds.has(item.id)) total += 3;
    if (item.url_verified) total += 1;
    const beginner = item.level === 'beginner' || item.level === 'unspecified';
    if (
      beginner &&
      item.skills.length > 0 &&
      item.skills.every((s) => level(s) >= 1) &&
      candidates.some((c) => c.level === 'intermediate' && supersetOf(c, item))
    ) {
      total -= 1;
    }
    return total;
  };

  const pool = candidates.slice();
  while (uncovered.size > 0 && pool.length > 0) {
    let bestIndex = -1;
    let best = 0;
    for (let i = 0; i < pool.length; i++) {
      const s = score(pool[i] as CatalogItem);
      // Ties go to the lower catalog id: the pool is in id order and only a larger score replaces.
      if (s > best) {
        best = s;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const [item] = pool.splice(bestIndex, 1) as [CatalogItem];
    roots.push({
      id: item.id,
      tier: courseTier(ctx, item),
      origin: 'gap',
      paidCertificate: false,
    });
    markCovered(item);
  }
  return roots;
}

/**
 * Exam score bonus for how well the credential is recognised (the catalog's `recognition`):
 * high +2, medium +1, low 0. It only breaks ties between exams that teach the same role skills;
 * the role's skill weights, +3 for the core path and +1 for a verified link carry the rest.
 */
const RECOGNITION_BONUS: Record<string, number> = { high: 2, medium: 1, low: 0 };

export interface CertificateSelection {
  /** New exam roots, and course roots whose paid certificate was opted into. */
  roots: Root[];
  /** Ids of existing roots that got `paidCertificate` set. */
  upgraded: string[];
  offered: CatalogItem[];
}

/** Score of an exam for one role: skill weights it teaches, recognition, path and verification. */
function examScore(ctx: BuildContext, roleId: string, item: CatalogItem): number {
  const role = ctx.index.roles.get(roleId);
  if (!role) return 0;
  let sum = 0;
  for (const s of role.skills) if (item.skills.includes(s.skill)) sum += s.weight;
  if (sum === 0) return 0;
  sum += RECOGNITION_BONUS[item.recognition] ?? 0;
  if (role.suggested_path.core.includes(item.id)) sum += 3;
  if (item.url_verified) sum += 1;
  return sum;
}

/**
 * Step 5: exams. `must` includes the best exam per target role, `nice` offers them, `none`
 * offers nothing. The user's opt-ins, `mustInclude` exams and exams with a date are included.
 */
export function selectCertificates(
  ctx: BuildContext,
  existing: readonly Root[],
  log: ExclusionLog,
): CertificateSelection {
  const { request } = ctx;
  const roots: Root[] = [];
  const upgraded: string[] = [];
  const inRoots = new Set(existing.map((r) => r.id));
  const reportable = suggestedIds(ctx);

  const addExam = (item: CatalogItem, origin: Root['origin']) => {
    if (inRoots.has(item.id)) return;
    if (rootIssue(ctx, item, log)) return;
    inRoots.add(item.id);
    roots.push({ id: item.id, tier: tierFor(ctx, item, 'core'), origin, paidCertificate: false });
  };

  // The user's own choices first, so they win the origin label.
  const own: { id: string; origin: Root['origin'] }[] = [
    ...request.certificateOptIns.map((id) => ({ id, origin: 'opt_in' as const })),
    ...request.examDates.map((e) => ({ id: e.catalogId, origin: 'opt_in' as const })),
    ...request.mustInclude.map((id) => ({ id, origin: 'must_include' as const })),
  ];
  for (const { id, origin } of own) {
    const item = ctx.index.byId.get(id);
    if (!item) continue;
    if (item.type === 'cert_exam') {
      addExam(item, origin);
    } else if (item.cost_type === 'free_audit' && origin === 'opt_in') {
      // The paid certificate of a free_audit course.
      if (upgraded.includes(id) || roots.some((r) => r.id === id)) continue;
      if (rootIssue(ctx, item, log, { certificateOnly: true })) continue;
      const closure = closureOf(ctx, item);
      if (!closure.ok) continue;
      if (inRoots.has(id)) {
        upgraded.push(id);
      } else {
        inRoots.add(id);
        roots.push({
          id,
          tier: tierFor(ctx, item, 'core'),
          origin: 'opt_in',
          paidCertificate: true,
        });
      }
    }
  }

  const candidates: CatalogItem[] = [];
  if (request.certPreference !== 'none') {
    const targetIds = new Set(ctx.targets.map((t) => t.skillId));
    for (const item of ctx.index.items) {
      if (item.type !== 'cert_exam') continue;
      if (!item.skills.some((s) => targetIds.has(s))) continue;
      if (rootIssue(ctx, item, reportable.has(item.id) ? log : null)) continue;
      candidates.push(item);
    }
  }
  if (request.certPreference === 'must') {
    for (const roleId of request.targetRoleIds) {
      let best: CatalogItem | null = null;
      let bestScore = 0;
      for (const item of candidates) {
        const s = examScore(ctx, roleId, item);
        if (s > bestScore) {
          best = item;
          bestScore = s;
        }
      }
      if (best) addExam(best, 'certificate');
    }
  }
  const bestScoreOf = (item: CatalogItem) =>
    Math.max(0, ...request.targetRoleIds.map((r) => examScore(ctx, r, item)));
  const offered = candidates
    .filter((c) => !inRoots.has(c.id))
    .sort((a, b) => bestScoreOf(b) - bestScoreOf(a) || (a.id < b.id ? -1 : 1));
  return { roots, upgraded, offered };
}

/** Step 6: the target roles' practice templates (at most 4 per role). Practice items may have no link. */
export function selectPractice(
  ctx: BuildContext,
  existing: readonly Root[],
  log: ExclusionLog,
): Root[] {
  if (ctx.request.interviewPrep === 'no') return [];
  const have = new Set(existing.map((r) => r.id));
  const roots: Root[] = [];
  for (const roleId of ctx.request.targetRoleIds) {
    const role = ctx.index.roles.get(roleId);
    if (!role) continue;
    for (const id of role.suggested_path.practice.slice(0, 4)) {
      const item = ctx.index.byId.get(id);
      if (!item || have.has(id)) continue;
      if (rootIssue(ctx, item, log)) continue;
      have.add(id);
      roots.push({
        id,
        tier: tierFor(ctx, item, 'optional'),
        origin: 'practice',
        paidCertificate: false,
      });
    }
  }
  return roots;
}
