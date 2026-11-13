import { closureOf, type BuildContext, type Root } from './context';
import { computeCost, spanFromBlocks, spanFromReport } from './cost';
import { coveredGaps, fitRoots, type Compose, type FitOutcome } from './fit';
import { droppedBy, resolveRoots, rootsWithout, type Member, type Resolved } from './resolve';
import type { CostReport } from './schemas';
import { rootIssue, type ExclusionLog } from './select';

/** Epsilon for comparing a sum of prices with the limit. */
const EPSILON = 0.005;

export interface LimitOutcome {
  outcome: FitOutcome;
  cost: CostReport;
  overBudget: boolean;
  /** When over budget: items to remove so the known cost is within the limit. */
  removeToFit: string[];
  /** Gap skills the covered set lost in the swap/drop pass. */
  lostForBudget: string[];
  /** Roots left out in the pass (for the exclusion log's reasons). */
  droppedForBudget: string[];
}

export function costOf(outcome: FitOutcome): CostReport {
  return computeCost(
    outcome.draft.resolved.members,
    spanFromBlocks(outcome.run.blocks, outcome.draft.composed.taskItem),
  );
}

function limitAmount(ctx: BuildContext): number | null {
  const { budget } = ctx.request;
  return budget.mode === 'limit' && budget.amount !== undefined ? budget.amount : null;
}

function costsMoney(m: Member): boolean {
  const { item } = m;
  if (m.paidCertificate && (item.certificate_price ?? 0) > 0) return true;
  return (
    (item.cost_type === 'one_time' || item.cost_type === 'subscription') && (item.price ?? 0) > 0
  );
}

/** Roots that cost money: they, or a prerequisite added around them, are priced and not free. */
function isPaidRoot(ctx: BuildContext, resolved: Resolved, m: Member): boolean {
  if (costsMoney(m)) return true;
  const closure = closureOf(ctx, m.item);
  if (!closure.ok) return false;
  return closure.required.some((id) => {
    const p = resolved.byId.get(id);
    return p ? costsMoney(p) : false;
  });
}

function estimate(ctx: BuildContext, roots: readonly Root[], previous: CostReport): number {
  return computeCost(resolveRoots(ctx, roots).members, spanFromReport(previous)).total;
}

/** Paid roots in the order they are given up: optional first, then lowest priority, then the dearer one. */
function paidByDropOrder(ctx: BuildContext, roots: readonly Root[]): Member[] {
  const resolved = resolveRoots(ctx, roots);
  return resolved.members
    .filter((m) => m.root !== null && isPaidRoot(ctx, resolved, m))
    .sort(
      (a, b) =>
        Number(a.tier === 'core') - Number(b.tier === 'core') ||
        a.priority - b.priority ||
        (b.item.price ?? 0) - (a.item.price ?? 0) ||
        (a.id < b.id ? 1 : -1),
    );
}

/**
 * Step 10, the limit rule: the known total must be at most the limit. When it is not, one pass:
 * swap a paid item for its first free alternative that teaches the same gap skills, else drop
 * optional paid items, else drop the lowest-priority core ones (listing the skills lost). Then
 * exactly one re-fit and cost check; if the total is still over, `overBudget` is set and the
 * items to remove are listed. It never loops again.
 */
export function enforceLimit(
  ctx: BuildContext,
  compose: Compose,
  outcome: FitOutcome,
  log: ExclusionLog,
): LimitOutcome {
  const amount = limitAmount(ctx);
  const cost = costOf(outcome);
  const unchanged: LimitOutcome = {
    outcome,
    cost,
    overBudget: false,
    removeToFit: [],
    lostForBudget: [],
    droppedForBudget: [],
  };
  if (amount === null || cost.total <= amount + EPSILON) return unchanged;

  let roots = outcome.draft.roots;
  const droppedForBudget: string[] = [];
  const within = () => estimate(ctx, roots, cost) <= amount + EPSILON;

  // (a) Swap a paid root for its first usable free alternative, the dearest first.
  const paidDearestFirst = [...paidByDropOrder(ctx, roots)].sort(
    (a, b) => (b.item.price ?? 0) - (a.item.price ?? 0) || (a.id < b.id ? -1 : 1),
  );
  for (const m of paidDearestFirst) {
    if (within()) break;
    const have = new Set(roots.map((r) => r.id));
    for (const altId of m.item.free_alternative_ids) {
      const alt = ctx.index.byId.get(altId);
      if (!alt || have.has(altId) || alt.type !== m.item.type) continue;
      if (!m.gapSkills.every((s) => alt.skills.includes(s))) continue;
      if (rootIssue(ctx, alt, null)) continue;
      log.add({
        catalogId: m.id,
        reason: 'over_budget',
        message: `"${m.item.title}" was replaced by its free alternative "${alt.title}" to stay within your limit.`,
        relatedId: alt.id,
      });
      const old = m.root as Root;
      roots = roots.map((r) =>
        r.id === m.id
          ? {
              id: alt.id,
              tier: old.tier,
              origin: 'free_alternative' as const,
              paidCertificate: false,
            }
          : r,
      );
      break;
    }
  }
  // (b) and (c) Drop paid roots: optional first, then the lowest-priority core ones.
  while (!within()) {
    const next = paidByDropOrder(ctx, roots)[0];
    if (!next) break;
    droppedForBudget.push(...droppedBy(ctx, roots, next.id));
    roots = rootsWithout(ctx, roots, next.id);
  }

  const beforeSkills = coveredGaps(outcome.draft);
  // The one re-fit and cost check.
  const refit = fitRoots(ctx, compose, roots);
  const recost = costOf(refit);
  const afterSkills = coveredGaps(refit.draft);
  const lostForBudget = [...beforeSkills].filter((s) => !afterSkills.has(s)).sort();
  const over = recost.total > amount + EPSILON;
  let removeToFit: string[] = [];
  if (over) {
    let probe = refit.draft.roots;
    while (estimate(ctx, probe, recost) > amount + EPSILON) {
      const next = paidByDropOrder(ctx, probe)[0];
      if (!next) break;
      removeToFit.push(...droppedBy(ctx, probe, next.id));
      probe = rootsWithout(ctx, probe, next.id);
    }
    removeToFit = [...new Set(removeToFit)].sort();
  }
  return {
    outcome: refit,
    cost: recost,
    overBudget: over,
    removeToFit,
    lostForBudget,
    droppedForBudget: [...new Set(droppedForBudget)].sort(),
  };
}
