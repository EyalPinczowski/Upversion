import {
  addDays,
  compareDates,
  diffDays,
  localDateOf,
  schedule,
  type Block,
  type Task,
  type WeekPattern,
} from '@upversion/shared';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import type { PlanDetail } from '../plans/schemas';
import { requireWritablePlan } from '../plans/guard';
import * as plansRepo from '../plans/repository';
import { loadCalendarInputs, withDayOffs, type CalendarInputs } from '../calendar/inputs';
import * as repo from './repository';
import type { Snapshot } from './repository';

/** Never freeze more than this many missed days in one read (a plan older than that is not replayed). */
const MAX_ROLLOVER_DAYS = 400;

/** The earliest day a read may freeze (and so plan): the plan's first day, or 400 days back. */
export function earliestFreezableDay(firstDay: string, today: string): string {
  const lastPast = addDays(today, -1);
  return diffDays(firstDay, lastPast) >= MAX_ROLLOVER_DAYS
    ? addDays(lastPast, 1 - MAX_ROLLOVER_DAYS)
    : firstDay;
}

export type DayStatus = 'not_started' | 'started' | 'ended';

export interface DayState {
  date: string;
  status: DayStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** The blocks that were planned for the date, once it is frozen; null before that. */
  frozen: { frozenAt: string; source: repo.SnapshotSource; blocks: Block[] } | null;
}

/** What a read needs: the plan, its pattern, the plan-local date and the stored past days. */
export interface DayContext {
  plan: PlanDetail;
  pattern: WeekPattern;
  /** Today's date in the plan's time zone. */
  today: string;
  /** The first date the app considers part of the plan (see `firstPlanDay`). */
  firstDay: string;
  snapshots: Snapshot[];
  /** The user's synced calendar (busy time, blocking all-day events, locked blocks); empty when none. */
  calendar: CalendarInputs;
}

const unprocessable = (message: string) => new HttpError(422, 'unprocessable', message);

/**
 * The first date that belongs to the plan: its start date, but never before the day it was
 * created in the plan's zone. Importing a plan whose start date is long past must not replay
 * months of days nobody studied.
 */
export function firstPlanDay(plan: PlanDetail, timezone: string): string {
  const createdDay = localDateOf(new Date(plan.createdAt), timezone);
  return compareDates(plan.startDate, createdDay) >= 0 ? plan.startDate : createdDay;
}

/** What the stored history says about tasks, for rebuilding the plan as of an earlier day. */
interface History {
  logs: { taskId: string; date: string; hours: number }[];
  /** Latest completion or skip per task that is done or skipped now (see `statusChangeDates`). */
  statusChanges: Map<string, { status: 'done' | 'skipped'; date: string }>;
}

async function loadHistory(
  ctx: UserContext,
  userId: string,
  planId: string,
  timezone: string,
  from: string,
): Promise<History> {
  return {
    logs: await repo.logsFrom(ctx, userId, planId, from),
    statusChanges: await repo.statusChangeDates(ctx, userId, planId, timezone),
  };
}

/**
 * The tasks as they stood at the start of `date`: work logged on or after that date does not
 * count yet, and a task finished or skipped on or after it is open again. This is what was
 * planned for the day, not what is left after the day's own work or decisions. A skipped task
 * with no recorded skip date (skipped before skips were recorded) stays skipped.
 */
function tasksAtStartOf(tasks: Task[], history: History, date: string): Task[] {
  const later = new Map<string, number>();
  for (const l of history.logs) {
    if (compareDates(l.date, date) >= 0) later.set(l.taskId, (later.get(l.taskId) ?? 0) + l.hours);
  }
  return tasks.map((t) => {
    const hours = later.get(t.id) ?? 0;
    const change = history.statusChanges.get(t.id);
    const changedLater =
      change !== undefined && change.status === t.status && compareDates(change.date, date) >= 0;
    if (t.status === 'skipped' && !changedLater) return t;
    if (hours === 0 && !changedLater) return t;
    const doneHours = Math.max(0, t.doneHours - hours);
    return { ...t, doneHours, status: doneHours > 0 ? 'in_progress' : 'pending' };
  });
}

/** Day state and the stored past days. Plans are read through the plans repository (same transaction). */
export function createDaysService(db: Database, now: () => Date = () => new Date()) {
  async function load(ctx: UserContext, userId: string, planId: string) {
    const plan = await plansRepo.loadPlan(ctx, userId, planId);
    if (!plan) throw new HttpError(404, 'not_found', 'Resource not found.');
    if (!plan.weekPattern) throw unprocessable('The plan has no week pattern yet.');
    const pattern = plan.weekPattern;
    const today = localDateOf(now(), pattern.timezone);
    const firstDay = firstPlanDay(plan, pattern.timezone);
    return {
      plan,
      pattern,
      today,
      firstDay,
      calendar: await loadCalendarInputs(ctx, userId, planId, pattern.timezone, {
        fromDate: earliestFreezableDay(firstDay, today),
      }),
    };
  }

  /** The blocks planned for `date`, from the plan as it stood at the start of that day. */
  function plannedFor(
    plan: PlanDetail,
    pattern: WeekPattern,
    date: string,
    snapshots: Snapshot[],
    history: History,
    calendar: CalendarInputs,
  ): Block[] {
    const result = schedule({
      tasks: tasksAtStartOf(plan.tasks, history, date),
      pattern,
      overrides: withDayOffs(plan.overrides, calendar.dayOffs),
      busy: calendar.busy,
      lockedBlocks: calendar.lockedBlocks,
      today: date,
      frozenBlocks: snapshots.flatMap((s) => s.blocks),
    });
    return result.blocks.filter((b) => b.date === date);
  }

  /**
   * Freezes every missed past day (from the plan's first day up to yesterday) that has no
   * snapshot yet, oldest first, each one planned with the earlier days already frozen. Runs
   * inside the caller's transaction. A per-plan lock plus ON CONFLICT DO NOTHING make
   * simultaneous reads freeze each day once and write its event once.
   */
  async function rollover(
    ctx: UserContext,
    userId: string,
    c: Omit<DayContext, 'snapshots'>,
  ): Promise<Snapshot[]> {
    const lastPast = addDays(c.today, -1);
    const from = earliestFreezableDay(c.firstDay, c.today);
    const missing = (have: Snapshot[]): string[] => {
      const known = new Set(have.map((s) => s.date));
      const dates: string[] = [];
      for (let d = from; compareDates(d, lastPast) <= 0; d = addDays(d, 1)) {
        if (!known.has(d)) dates.push(d);
      }
      return dates;
    };

    let snapshots = await repo.listSnapshots(ctx, userId, c.plan.id);
    if (missing(snapshots).length === 0) return snapshots;

    await repo.lockPlanDays(ctx, userId, c.plan.id);
    // The request that held the lock may have frozen them already.
    snapshots = await repo.listSnapshots(ctx, userId, c.plan.id);
    const todo = missing(snapshots);
    if (todo.length === 0) return snapshots;

    const history = await loadHistory(ctx, userId, c.plan.id, c.pattern.timezone, todo[0]!);
    for (const date of todo) {
      const blocks = plannedFor(c.plan, c.pattern, date, snapshots, history, c.calendar);
      if (await repo.insertSnapshot(ctx, userId, c.plan.id, date, blocks, 'auto_rollover')) {
        await plansRepo.insertEvent(ctx, userId, c.plan.id, 'day.rolled_over', {
          date,
          blockCount: blocks.length,
        });
      }
      snapshots = await repo.listSnapshots(ctx, userId, c.plan.id);
    }
    return snapshots;
  }

  async function dayState(
    ctx: UserContext,
    userId: string,
    planId: string,
    date: string,
  ): Promise<DayState> {
    // One after the other: a pg client runs a single query at a time.
    const session = await repo.getSession(ctx, userId, planId, date);
    const snapshots = await repo.listSnapshots(ctx, userId, planId);
    const snap = snapshots.find((s) => s.date === date);
    return {
      date,
      status: session?.endedAt ? 'ended' : session ? 'started' : 'not_started',
      startedAt: session?.startedAt.toISOString() ?? null,
      endedAt: session?.endedAt?.toISOString() ?? null,
      frozen: snap
        ? { frozenAt: snap.frozenAt.toISOString(), source: snap.source, blocks: snap.blocks }
        : null,
    };
  }

  /** A date the day actions accept: inside the plan and not after today (plan-local). */
  function requireActionable(c: { today: string; firstDay: string }, date: string, verb: string) {
    if (compareDates(date, c.today) > 0) throw unprocessable(`A future day cannot be ${verb}.`);
    if (compareDates(date, c.firstDay) < 0) {
      throw unprocessable(`A day before the plan began cannot be ${verb}.`);
    }
  }

  /**
   * Loads the plan and brings its stored past days up to date, inside the caller's transaction.
   * Every read that shows schedule or progress goes through here ("automatically on the first
   * visit the next day", spec 3.4).
   */
  async function open(ctx: UserContext, userId: string, planId: string): Promise<DayContext> {
    const c = await load(ctx, userId, planId);
    return { ...c, snapshots: await rollover(ctx, userId, c) };
  }

  return {
    open,

    /**
     * The plan's tasks as they stood at the start of `date`, for reads that show what was
     * planned for a day (the briefing). Inside the caller's transaction, like `open`.
     */
    async tasksAt(ctx: UserContext, userId: string, c: DayContext, date: string): Promise<Task[]> {
      const history = await loadHistory(ctx, userId, c.plan.id, c.pattern.timezone, date);
      return tasksAtStartOf(c.plan.tasks, history, date);
    },

    /** The same for a read that has no use for the schedule: nothing happens without a week pattern. */
    rolloverIfScheduled(userId: string, planId: string): Promise<void> {
      return db.withUser(userId, async (ctx) => {
        const plan = await plansRepo.loadPlan(ctx, userId, planId);
        // A missing plan is left to the caller to report.
        if (!plan?.weekPattern) return;
        const tz = plan.weekPattern.timezone;
        const today = localDateOf(now(), tz);
        const firstDay = firstPlanDay(plan, tz);
        await rollover(ctx, userId, {
          plan,
          pattern: plan.weekPattern,
          today,
          firstDay,
          calendar: await loadCalendarInputs(ctx, userId, planId, tz, {
            fromDate: earliestFreezableDay(firstDay, today),
          }),
        });
      });
    },

    /** Idempotent. `created` is false when the day had been started before. */
    start: (userId: string, planId: string, date: string) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        const c = await load(ctx, userId, planId);
        requireActionable(c, date, 'started');
        const created = await repo.insertSession(ctx, userId, planId, date);
        if (created) await plansRepo.insertEvent(ctx, userId, planId, 'day.started', { date });
        return { created, day: await dayState(ctx, userId, planId, date) };
      }),

    /**
     * Idempotent. Freezes the date's blocks (as planned at the start of that day) unless the day
     * is already frozen, marks the day ended and writes `day.ended` once.
     */
    end: (userId: string, planId: string, date: string) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        const c = await load(ctx, userId, planId);
        requireActionable(c, date, 'ended');
        // Earlier days first, so the day being ended is planned with them frozen. The lock also
        // serialises two simultaneous End requests: the second finds everything done.
        await repo.lockPlanDays(ctx, userId, planId);
        const snapshots = await rollover(ctx, userId, c);
        let source: repo.SnapshotSource = 'day_end';
        const existing = snapshots.find((s) => s.date === date);
        if (existing) {
          source = existing.source;
        } else {
          const history = await loadHistory(ctx, userId, planId, c.pattern.timezone, date);
          const blocks = plannedFor(c.plan, c.pattern, date, snapshots, history, c.calendar);
          await repo.insertSnapshot(ctx, userId, planId, date, blocks, 'day_end');
        }
        if (await repo.endSession(ctx, userId, planId, date)) {
          await plansRepo.insertEvent(ctx, userId, planId, 'day.ended', { date, source });
        }
        return dayState(ctx, userId, planId, date);
      }),

    /** Session state, plus the frozen blocks once the date is frozen. A past date is frozen first. */
    get: (userId: string, planId: string, date: string) =>
      db.withUser(userId, async (ctx) => {
        await open(ctx, userId, planId);
        return dayState(ctx, userId, planId, date);
      }),
  };
}

export type DaysService = ReturnType<typeof createDaysService>;
