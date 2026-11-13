import type { LocalDate } from '../dates';
import { itemBudgetReason, type BudgetReason } from './budget';
import { skillName, type CatalogIndex, type CatalogItem } from './catalog';
import type { BuildItemOrigin, BuildRequest, BuildTier, ExcludedReason } from './schemas';
import type { TargetSkill } from './targets';
import { LEVEL_COMFORTABLE } from './targets';

/** Labels of the `skill_levels` scale in `questions.json` (a test keeps them in step). */
export const LEVEL_LABELS = ['Never used', 'Basic', 'Comfortable', 'Could teach it'] as const;

export function levelLabel(level: number): string {
  return LEVEL_LABELS[Math.min(Math.max(Math.trunc(level), 0), 3)] ?? LEVEL_LABELS[0];
}

/** One chosen starting point of the plan; the closure of its required prerequisites is added around it. */
export interface Root {
  id: string;
  tier: BuildTier;
  origin: BuildItemOrigin;
  /** A `free_audit` item whose paid certificate the user opted into. */
  paidCertificate: boolean;
}

export type ClosureResult =
  | { ok: true; required: string[]; skipped: { catalogId: string; message: string }[] }
  | { ok: false; reason: ExcludedReason; relatedId: string };

export interface BuildContext {
  request: BuildRequest;
  index: CatalogIndex;
  /** The first day the schedule may use: the later of the start date and today. */
  from: LocalDate;
  targets: TargetSkill[];
  targetById: Map<string, TargetSkill>;
  /** Skills with a gap. */
  gapIds: Set<string>;
  excluded: Set<string>;
  /** Items on a target role's suggested core path (its free-only path when the budget is free). */
  coreIds: Set<string>;
  closureCache: Map<string, ClosureResult>;
}

/** Items without a link are never chosen, except practice templates (they run in the app). */
export function hasUsableLink(item: CatalogItem): boolean {
  return item.type === 'practice' || item.url !== null;
}

/** A link is shown on a task only when the catalog says it was verified. */
export function showsLink(item: CatalogItem): boolean {
  return item.url !== null && item.url_verified;
}

/** True when the task for this item must say "Needs check: link". Practice templates have no link by design. */
export function linkNeedsCheck(item: CatalogItem): boolean {
  if (showsLink(item)) return false;
  return !(item.type === 'practice' && item.url === null);
}

/**
 * Item-level reason an item cannot be in the plan on its own (before its prerequisites):
 * excluded by the user, no link, or outside the budget.
 */
export function itemIssue(ctx: BuildContext, item: CatalogItem): ExcludedReason | null {
  if (ctx.excluded.has(item.id)) return 'excluded_by_user';
  if (!hasUsableLink(item)) return 'no_link';
  const reason: BudgetReason | null = itemBudgetReason(item, ctx.request.budget);
  return reason;
}

function ratedAtLeastComfortable(ctx: BuildContext, item: CatalogItem): boolean {
  if (item.skills.length === 0) return false;
  return item.skills.every((s) => (ctx.request.skillLevels[s] ?? 0) >= LEVEL_COMFORTABLE);
}

/**
 * Step 4 for one item: every transitive `required` prerequisite that has to be added, in
 * dependency order (prerequisites first). A prerequisite whose skills the user rated Comfortable
 * is skipped (and reported), but never one of an exam. A prerequisite that fails the item filter
 * makes the closure fail: the item is dropped, never added around the filter.
 */
export function closureOf(ctx: BuildContext, item: CatalogItem): ClosureResult {
  const cached = ctx.closureCache.get(item.id);
  if (cached) return cached;
  const order: string[] = [];
  const seen = new Set<string>([item.id]);
  const skipped: { catalogId: string; message: string }[] = [];
  let failure = null as ClosureResult | null;

  const visit = (dependent: CatalogItem): void => {
    for (const pid of dependent.prerequisites) {
      if (failure) return;
      if (dependent.prerequisite_kinds[pid] === 'recommended') continue;
      const p = ctx.index.byId.get(pid);
      if (!p || seen.has(pid)) continue;
      seen.add(pid);
      if (dependent.type !== 'cert_exam' && ratedAtLeastComfortable(ctx, p)) {
        const lowest = Math.min(...p.skills.map((s) => ctx.request.skillLevels[s] ?? 0));
        const names = p.skills.map((s) => skillName(ctx.index, s)).join(', ');
        skipped.push({
          catalogId: p.id,
          message: `Skipped "${p.title}": you rated ${names} ${levelLabel(lowest)}.`,
        });
        continue;
      }
      const issue = itemIssue(ctx, p);
      if (issue) {
        failure = { ok: false, reason: issue, relatedId: p.id };
        return;
      }
      visit(p);
      if (failure) return;
      order.push(p.id);
    }
  };
  visit(item);
  const result: ClosureResult = failure ?? { ok: true, required: order, skipped };
  ctx.closureCache.set(item.id, result);
  return result;
}

/** Why a prerequisite problem is reported in words ("needs X, which is outside your budget"). */
export function prerequisiteMessage(
  ctx: BuildContext,
  item: CatalogItem,
  reason: ExcludedReason,
  relatedId: string,
): string {
  const title = ctx.index.byId.get(relatedId)?.title ?? relatedId;
  const because: Record<string, string> = {
    excluded_by_user: 'which you excluded',
    free_only: 'which is not free',
    price_unknown: 'whose price is not known, so it cannot count against your limit',
    over_item_price: 'whose price is above your per-item limit',
    over_budget: 'which is outside your budget',
    no_link: 'which has no link in the catalog',
  };
  return `Needs "${title}", ${because[reason] ?? 'which cannot be added'}; "${item.title}" is left out.`;
}
