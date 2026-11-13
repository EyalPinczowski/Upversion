import { compareDates, diffDays, type LocalDate } from '../dates';
import { schedule, type ScheduleWarning } from '../scheduling/engine';
import { studyWindow, totalMinutes } from '../scheduling/capacity';
import type { Block, Task, WeekPattern } from '../schemas';
import type { BuildContext, Root } from './context';
import type { Resolved } from './resolve';
import { droppedBy, rootsWithout } from './resolve';
import type { Composed } from './tasks';
import type { Ordering } from './order';
import type { FitOptions } from './schemas';

/** One composed draft: the roots, their members, the order and the tasks. */
export interface Draft {
  roots: Root[];
  resolved: Resolved;
  ordering: Ordering;
  composed: Composed;
}

export type Compose = (roots: Root[]) => Draft;

/** Most engine runs one fit may use (a bound on the trim loops; the engine itself is fast). */
export const MAX_FIT_RUNS = 80;
/** The engine never looks further ahead than this many days (the longest deadline the builder accepts). */
export const FINISH_HORIZON_DAYS = 730;
/** Most engine runs one `buildPlan` may use in all its loops together. */
export const MAX_TOTAL_ENGINE_RUNS = 300;

/** Engine warnings that mean a task could not be placed. Anything else (e.g. an anchored exam on a non-study day) is not a failure to fit. */
const BLOCKING_WARNINGS: ReadonlySet<ScheduleWarning['kind']> = new Set([
  'unscheduled',
  'anchor_at_risk',
  'anchor_in_past',
  'dependency_cycle',
]);

export interface FitRun {
  fits: boolean;
  finishDate: LocalDate | null;
  blocks: Block[];
  warnings: ScheduleWarning[];
}

/**
 * Step 9: runs the real engine on the draft (pattern, window, lunch, breaks and minimum block all
 * apply). It fits when the finish date is on or before the deadline and the engine reports nothing
 * it could not place. The engine only looks as far as the deadline, so a plan that is far too
 * long is still a cheap run.
 */
export function runFit(
  ctx: BuildContext,
  tasks: readonly Task[],
  pattern: WeekPattern = ctx.request.weekPattern,
  horizonDays?: number,
): FitRun {
  const deadline = ctx.request.deadline;
  const horizon = Math.min(
    horizonDays ?? Math.max(0, diffDays(ctx.from, deadline)),
    FINISH_HORIZON_DAYS,
  );
  ctx.engineRuns += 1;
  const result = schedule({ tasks: [...tasks], pattern, today: ctx.from, horizonDays: horizon });
  const fits =
    !result.warnings.some((w) => BLOCKING_WARNINGS.has(w.kind)) &&
    result.finishDate !== null &&
    compareDates(result.finishDate, deadline) <= 0;
  return { fits, finishDate: result.finishDate, blocks: result.blocks, warnings: result.warnings };
}

export interface FitOutcome {
  draft: Draft;
  run: FitRun;
  /** Roots left out to fit the deadline (an optional item and what needed it), in drop order. */
  droppedForTime: string[];
  runs: number;
}

/** Order in which items are given up: lowest priority first, then the longer one, then the higher id. */
function dropOrder(
  a: { priority: number; item: { est_hours: number }; id: string },
  b: typeof a,
): number {
  return (
    a.priority - b.priority ||
    b.item.est_hours - a.item.est_hours ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** The next root to give up, or null. `optionalOnly`: only roots whose effective tier is optional. */
export function nextToDrop(
  draft: Draft,
  optionalOnly: boolean,
  canDrop: (id: string) => boolean = () => true,
): string | null {
  const candidates = draft.resolved.members
    .filter((m) => m.root !== null && (!optionalOnly || m.tier === 'optional') && canDrop(m.id))
    .sort(dropOrder);
  return candidates[0]?.id ?? null;
}

/**
 * Step 9: check the draft against the deadline; if it does not fit, drop optional items one at a
 * time (lowest priority first), re-running the engine each time. Core items are never dropped here.
 */
export function fitRoots(ctx: BuildContext, compose: Compose, roots: Root[]): FitOutcome {
  let current = roots;
  let draft = compose(current);
  let run = runFit(ctx, draft.composed.tasks);
  let runs = 1;
  const droppedForTime: string[] = [];
  while (!run.fits && runs < MAX_FIT_RUNS && ctx.engineRuns < MAX_TOTAL_ENGINE_RUNS) {
    const id = nextToDrop(draft, true);
    if (!id) break;
    droppedForTime.push(...droppedBy(ctx, current, id));
    current = rootsWithout(ctx, current, id);
    draft = compose(current);
    run = runFit(ctx, draft.composed.tasks);
    runs += 1;
  }
  return { draft, run, droppedForTime, runs };
}

/** The most hours a day can hold in the pattern's window (lunch excluded), on the 0.5 h grid. */
function windowHours(pattern: WeekPattern): number {
  return Math.floor(totalMinutes(studyWindow(pattern)) / 30) / 2;
}

/** The option sets the same hours on every study day: per-weekday overrides are cleared (and the option says so). */
function withHours(pattern: WeekPattern, hours: number): WeekPattern {
  return { ...pattern, defaultHours: hours, hoursByWeekday: {} };
}

/**
 * The smallest hours per day on a 0.5 h grid that fits, found by binary search between the
 * current value and the window length (about 6 engine runs); null when even a full window does not fit.
 */
export function hoursPerDayThatFits(ctx: BuildContext, tasks: readonly Task[]): number | null {
  const pattern = ctx.request.weekPattern;
  const max = windowHours(pattern);
  let lo = Math.floor(pattern.defaultHours * 2) / 2 + 0.5;
  if (lo > max) return null;
  if (!runFit(ctx, tasks, withHours(pattern, max)).fits) return null;
  let hi = max;
  while (lo < hi) {
    const mid = Math.floor(((lo + hi) / 2) * 2) / 2;
    const probe = mid < lo ? lo : mid;
    if (runFit(ctx, tasks, withHours(pattern, probe)).fits) hi = probe;
    else lo = probe + 0.5;
  }
  return hi;
}

/** The skills of the gap that this draft covers. */
export function coveredGaps(draft: Draft): Set<string> {
  const covered = new Set<string>();
  for (const m of draft.resolved.members) for (const s of m.gapSkills) covered.add(s);
  return covered;
}

/** Exams and items the user asked for by name (opt-in, exam date, mustInclude) are never offered to be dropped. */
function isProtected(draft: Draft, id: string): boolean {
  const origin = draft.resolved.byId.get(id)?.origin;
  return origin === 'opt_in' || origin === 'must_include';
}

/**
 * The three options when the plan does not fit (spec 3.0), all computed by the engine. The
 * builder never applies one: the caller shows them and the user picks.
 */
export function fitOptions(ctx: BuildContext, compose: Compose, outcome: FitOutcome): FitOptions {
  const tasks = outcome.draft.composed.tasks;
  const unconstrained = runFit(ctx, tasks, ctx.request.weekPattern, FINISH_HORIZON_DAYS);
  const finishDate = unconstrained.warnings.some((w) => w.kind === 'unscheduled')
    ? null
    : unconstrained.finishDate;

  const hoursPerDay = hoursPerDayThatFits(ctx, tasks);

  // Keep only the essentials: give up the lowest-priority items until the engine says it fits.
  let current = outcome.draft.roots;
  let draft = outcome.draft;
  const dropped: string[] = [];
  let runs = 0;
  let fits = false;
  while (current.length > 0 && runs < MAX_FIT_RUNS && ctx.engineRuns < MAX_TOTAL_ENGINE_RUNS) {
    const roots = current;
    const id = nextToDrop(draft, false, (candidate) =>
      droppedBy(ctx, roots, candidate).every((r) => !isProtected(draft, r)),
    );
    if (!id) break;
    dropped.push(...droppedBy(ctx, current, id));
    current = rootsWithout(ctx, current, id);
    draft = compose(current);
    runs += 1;
    if (runFit(ctx, draft.composed.tasks).fits) {
      fits = true;
      break;
    }
  }
  const before = coveredGaps(outcome.draft);
  const after = coveredGaps(draft);
  const lost = [...before].filter((s) => !after.has(s)).sort();
  return {
    finishOn: { date: finishDate },
    hoursPerDay: { value: hoursPerDay, appliesToAllStudyDays: true },
    essentials: {
      possible: fits && current.length > 0,
      droppedItemIds: fits ? [...new Set(dropped)].sort() : [],
      lostSkillIds: fits ? lost : [],
    },
  };
}
