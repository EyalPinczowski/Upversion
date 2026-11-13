import { compareDates } from '../dates';
import { parsePlanFile } from '../schemas';
import { certificateBudgetReason } from './budget';
import { indexCatalog, skillName, type BuildCatalog } from './catalog';
import { linkNeedsCheck, type BuildContext, type Root } from './context';
import { itemCostOf } from './cost';
import { fitOptions, fitRoots, coveredGaps, type Compose, type Draft } from './fit';
import { canonicalJson, hashText } from './hash';
import { enforceLimit } from './limit';
import { orderMembers } from './order';
import { resolveRoots } from './resolve';
import {
  BuildInputSchema,
  type BuildDraft,
  type BuildInputShape,
  type BuildItem,
  type BuildWarning,
  type OfferedCertificate,
  type SkillNotCovered,
} from './schemas';
import { ExclusionLog, selectCertificates, selectCourses, selectPractice } from './select';
import { composeTasks, priceNeedsCheck, priceVaries } from './tasks';
import { computeTargets } from './targets';
import { BuildRequestError, validateBuildRequest } from './validate';
import { joinNames } from './why';

/** Written into the plan summary by the API so a later version can tell which rules built a plan. */
export const BUILDER_VERSION = 1;

const MAX_OFFERED_CERTIFICATES = 10;
const MAX_PLAN_SKILLS = 50;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validates the input and sets up the lookups every step shares (no planning happens here). */
export function createContext(input: BuildInputShape, catalog: BuildCatalog): BuildContext {
  const { request, today } = BuildInputSchema.parse(input);
  const index = indexCatalog(catalog);
  const issues = validateBuildRequest(request, index, today);
  if (issues.length > 0) throw new BuildRequestError(issues);

  const from = compareDates(request.startDate, today) >= 0 ? request.startDate : today;
  const targets = computeTargets(request, index);
  const coreIds = new Set<string>();
  for (const roleId of request.targetRoleIds) {
    const path = index.roles.get(roleId)?.suggested_path;
    if (!path) continue;
    for (const id of request.budget.mode === 'free' ? path.free_only : path.core) coreIds.add(id);
  }
  return {
    request,
    index,
    from,
    targets,
    targetById: new Map(targets.map((t) => [t.skillId, t])),
    gapIds: new Set(targets.filter((t) => t.gap > 0).map((t) => t.skillId)),
    excluded: new Set(request.exclude),
    coreIds,
    closureCache: new Map(),
    engineRuns: 0,
  };
}

/** Resolve, order and write the tasks for a set of roots (steps 4, 5, 7, 8 and 11). */
export function composeFor(ctx: BuildContext): Compose {
  return (roots): Draft => {
    const resolved = resolveRoots(ctx, roots);
    const ordering = orderMembers(ctx, resolved);
    const composed = composeTasks(ctx, resolved, ordering);
    return { roots, resolved, ordering, composed };
  };
}

/**
 * The plan builder (ADR 017 section 2): a pure, deterministic function. No I/O, no clock, no
 * randomness; `today` comes from the caller. The same input and catalog always give the same
 * draft, whatever the order of the catalog's items.
 *
 * Throws `BuildRequestError` when the request names something the catalog does not have or the
 * dates cannot work, and a `ZodError` when the input has the wrong shape.
 */
export function buildPlan(input: BuildInputShape, catalog: BuildCatalog): BuildDraft {
  const ctx = createContext(input, catalog);
  const { request, index, from, targets } = ctx;
  const log = new ExclusionLog();

  // Steps 2 to 6: the roots.
  const courseRoots = selectCourses(ctx, log);
  const certs = selectCertificates(ctx, courseRoots, log);
  const upgraded = new Set(certs.upgraded);
  const withCerts: Root[] = [
    ...courseRoots.map((r) => (upgraded.has(r.id) ? { ...r, paidCertificate: true } : r)),
    ...certs.roots,
  ];
  const practice = selectPractice(ctx, withCerts, log);
  const initialRoots = [...withCerts, ...practice];

  const compose = composeFor(ctx);
  const coveredInitial = new Set<string>();
  for (const m of resolveRoots(ctx, initialRoots).members) {
    for (const s of m.gapSkills) coveredInitial.add(s);
  }

  // Steps 9 and 10: fit, then the cost on the fitted schedule, then the limit rule.
  const fitted = fitRoots(ctx, compose, initialRoots);
  const limited = enforceLimit(ctx, compose, fitted, log);
  const final = limited.outcome;
  const { draft } = final;
  const fits = final.run.fits;
  const options = fits ? null : fitOptions(ctx, compose, final);

  // Items that were chosen and then given up.
  const finalIds = new Set(draft.resolved.members.map((m) => m.id));
  const budgetDropped = new Set(limited.droppedForBudget);
  for (const r of initialRoots) {
    if (finalIds.has(r.id) || log.has(r.id)) continue;
    const title = index.byId.get(r.id)?.title ?? r.id;
    if (budgetDropped.has(r.id)) {
      log.add({
        catalogId: r.id,
        reason: 'dropped_to_fit_budget',
        message: `"${title}" was left out to stay within your budget limit.`,
      });
    } else {
      log.add({
        catalogId: r.id,
        reason: 'dropped_to_fit_time',
        message: `"${title}" was left out to fit your deadline.`,
      });
    }
  }
  for (const e of request.examDates) {
    if (finalIds.has(e.catalogId) || log.has(e.catalogId)) continue;
    const title = index.byId.get(e.catalogId)?.title ?? e.catalogId;
    log.add({
      catalogId: e.catalogId,
      reason: 'exam_date_not_used',
      message: `The exam date for "${title}" was not used because the exam is not in the plan.`,
    });
  }

  // Skills: covered, already covered, and what is missing and why.
  const coveredFinal = coveredGaps(draft);
  const lostBudget = new Set(limited.lostForBudget);
  const skillsNotCovered: SkillNotCovered[] = [];
  for (const t of targets) {
    if (t.gap === 0 || coveredFinal.has(t.skillId)) continue;
    skillsNotCovered.push({
      skillId: t.skillId,
      name: skillName(index, t.skillId),
      reason: !coveredInitial.has(t.skillId)
        ? 'catalog_gap'
        : lostBudget.has(t.skillId)
          ? 'dropped_to_fit_budget'
          : 'dropped_to_fit_time',
    });
  }

  // Items for the review screen.
  const items: BuildItem[] = draft.ordering.order.flatMap((id) => {
    const m = draft.resolved.byId.get(id);
    if (!m) return [];
    const taskIds = draft.composed.itemTasks.get(id) ?? [];
    const hours = taskIds.reduce(
      (sum, tid) => sum + (draft.composed.tasks.find((t) => t.id === tid)?.estHours ?? 0),
      0,
    );
    const cost = itemCostOf(m, limited.cost);
    return [
      {
        catalogId: id,
        title: m.item.title,
        provider: m.item.provider,
        kind: m.kind,
        tier: m.tier,
        origin: m.origin,
        taskIds,
        hours: round2(hours),
        skillIds: m.gapSkills,
        priority: m.priority,
        why: draft.composed.why.get(id) ?? '',
        cost,
        needsCheckLink: linkNeedsCheck(m.item),
        needsCheckPrice: priceNeedsCheck(m.item, m.paidCertificate),
        priceVaries: priceVaries(m.item, m.paidCertificate),
        isCertificate: m.kind === 'exam' || m.paidCertificate,
      },
    ];
  });

  // Certificates offered but not included.
  const offered: OfferedCertificate[] = certs.offered
    .filter((c) => !finalIds.has(c.id))
    .map((c) => ({
      catalogId: c.id,
      title: c.title,
      provider: c.provider,
      price: c.price,
      priceVerified: c.price_verified,
    }));
  if (request.certPreference !== 'none') {
    for (const m of draft.resolved.members) {
      if (m.item.cost_type !== 'free_audit' || m.paidCertificate) continue;
      if (m.item.certificate_type === 'none' && m.item.certificate_price === null) continue;
      if (certificateBudgetReason(m.item, request.budget)) continue;
      offered.push({
        catalogId: m.id,
        title: m.item.title,
        provider: m.item.provider,
        price: m.item.certificate_price,
        priceVerified: false,
      });
    }
  }

  const warnings = buildWarnings(
    ctx,
    draft,
    fits,
    final.run.warnings.map((w) => w.kind),
    skillsNotCovered,
    limited.cost.assumedOneMonth,
  );

  const taskList = draft.composed.tasks;
  const plan = parsePlanFile({
    formatVersion: 1,
    name: `${joinPlanTitle(ctx)} plan`,
    startDate: request.startDate,
    endDate: request.deadline,
    weekPattern: request.weekPattern,
    overrides: [],
    tasks: taskList,
    skillIds: [...targets]
      .sort((a, b) => b.weight - a.weight || (a.skillId < b.skillId ? -1 : 1))
      .map((t) => t.skillId)
      .slice(0, MAX_PLAN_SKILLS),
  });

  const body: Omit<BuildDraft, 'draftHash'> = {
    plan,
    items,
    excluded: [...log.list].sort((a, b) =>
      a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : a.reason < b.reason ? -1 : 1,
    ),
    skippedPrerequisites: draft.resolved.skipped,
    summary: {
      scheduleFrom: from,
      deadline: request.deadline,
      finishDate: fits ? final.run.finishDate : (options?.finishOn.date ?? null),
      totalHours: round2(taskList.reduce((s, t) => s + t.estHours, 0)),
      cost: fits ? limited.cost : { ...limited.cost, mayBeHigher: true },
      skillsAsked: targets.length,
      skillsCovered: [...coveredFinal].sort(),
      skillsAlreadyCovered: targets
        .filter((t) => t.gap === 0)
        .map((t) => t.skillId)
        .sort(),
      skillsNotCovered,
      certificatesIncluded: draft.resolved.members
        .filter((m) => m.kind === 'exam' || m.paidCertificate)
        .map((m) => m.id),
      certificatesOffered: offered.slice(0, MAX_OFFERED_CERTIFICATES),
    },
    fits,
    options,
    overBudget: limited.overBudget,
    removeToFit: limited.removeToFit,
    warnings,
  };
  return { ...body, draftHash: hashText(canonicalJson(body)) };
}

function joinPlanTitle(ctx: BuildContext): string {
  return ctx.request.targetRoleIds.map((id) => ctx.index.roles.get(id)?.title ?? id).join(' + ');
}

function buildWarnings(
  ctx: BuildContext,
  draft: Draft,
  fits: boolean,
  engineKinds: readonly string[],
  notCovered: readonly SkillNotCovered[],
  assumedOneMonth: readonly string[],
): BuildWarning[] {
  const out: BuildWarning[] = [
    {
      code: 'estimates',
      message: 'Hours are estimates from the catalog; recalibration comes from your own logs.',
    },
  ];
  if (draft.resolved.members.some((m) => m.kind === 'exam')) {
    out.push({
      code: 'unknown_exam_length',
      message:
        "Each exam is planned as a block of at most 2 hours. Check the exam length on the provider's page.",
    });
  }
  for (const roleId of ctx.request.targetRoleIds) {
    const role = ctx.index.roles.get(roleId);
    if (!role) continue;
    if (role.suggested_path.core.length <= 3) {
      out.push({
        code: 'thin_role',
        message: `The catalog has only ${role.suggested_path.core.length} core items for "${role.title}", so the plan may be short.`,
      });
    }
    if (ctx.request.budget.mode === 'free' && role.suggested_path.free_only.length === 0) {
      out.push({
        code: 'no_free_items',
        message: `The catalog has no free-only items for "${role.title}".`,
      });
    }
  }
  const gaps = notCovered.filter((s) => s.reason === 'catalog_gap');
  if (gaps.length > 0) {
    out.push({
      code: 'catalog_gap',
      message: `The catalog has no matching item${ctx.request.budget.mode === 'free' ? ' that is free and' : ''} with a link for ${joinNames(
        gaps.map((g) => g.name),
        50,
      )}.`,
    });
  }
  if (assumedOneMonth.length > 0) {
    out.push({
      code: 'subscription_months_assumed',
      message: `A subscription that is not scheduled is counted as one month (${assumedOneMonth.join(', ')}).`,
    });
  }
  if (!fits) {
    out.push({
      code: 'cost_may_be_higher',
      message:
        'The cost covers only what fits before the deadline; subscriptions may run longer and cost more.',
    });
  }
  if (!fits) {
    const kinds = [...new Set(engineKinds)].sort();
    out.push({
      code: 'schedule',
      message:
        kinds.length > 0
          ? `The plan does not fit before your deadline (scheduling reported: ${kinds.join(', ')}).`
          : 'The plan does not finish before your deadline.',
    });
  }
  return out;
}
