import {
  compareDates,
  localDateOf,
  type DayOverride,
  type PlanFile,
  type WeekPattern,
} from '@upversion/shared';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { requireWritablePlan } from './guard';
import { summarize, type ValidImport } from './import';
import * as repo from './repository';
import { MAX_OVERRIDES_PER_PLAN, type PlanDetail, type PlanSummary } from './schemas';

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === UNIQUE_VIOLATION;

/**
 * Where a new plan comes from. The import service owns the transaction: the per-user lock, the
 * idempotency check on `payloadHash` and the insert. `prepare` runs inside it, after the lock and
 * the idempotency check and before the insert, so a source can check state and archive other
 * plans atomically with the insert.
 */
export interface ImportSource {
  /** Compared with the hash stored by the first call that used the same plan id. */
  payloadHash: string;
  createdFrom: 'import' | 'builder';
  prepare(ctx: UserContext): Promise<{
    status: 'draft' | 'active';
    plan: PlanFile;
    /** Added to `plans.summary`. */
    summaryExtra?: Record<string, unknown>;
    /** Added to the `plan.imported` event payload. */
    eventExtra?: Record<string, unknown>;
  }>;
}

export interface ImportResult {
  /** False when the same plan had already been imported (an idempotent retry). */
  created: boolean;
  plan: PlanDetail;
}

/**
 * Plan operations. Every query runs inside db.withUser, so row-level security applies, and a
 * plan that is not the caller's looks exactly like one that does not exist.
 */
export function createPlanService(db: Database, now: () => Date = () => new Date()) {
  async function importOnce(userId: string, planId: string, source: ImportSource) {
    return db.withUser(userId, async (ctx): Promise<ImportResult> => {
      // First lock of the transaction: imports, builds and restores of one user run one at a time.
      await repo.lockUserPlans(ctx, userId);
      const existing = await repo.planExists(ctx, userId, planId);
      if (existing) {
        if ((await repo.importHashOf(ctx, userId, planId)) !== source.payloadHash) {
          throw new HttpError(
            409,
            'conflict',
            'A plan with this id already exists with different content.',
          );
        }
        return { created: false, plan: (await repo.loadPlan(ctx, userId, planId))! };
      }
      const { status, plan, summaryExtra, eventExtra } = await source.prepare(ctx);
      await repo.insertPlan(
        ctx,
        userId,
        planId,
        status,
        plan,
        summarize(plan, summaryExtra),
        source.createdFrom,
      );
      await repo.upsertWeekPattern(ctx, userId, planId, plan.weekPattern);
      await repo.insertOverrides(ctx, userId, planId, plan.overrides);
      await repo.insertTasks(ctx, userId, planId, plan.tasks);
      await repo.insertEvent(ctx, userId, planId, 'plan.imported', {
        payloadHash: source.payloadHash,
        taskCount: plan.tasks.length,
        overrideCount: plan.overrides.length,
        status,
        ...eventExtra,
      });
      return { created: true, plan: (await repo.loadPlan(ctx, userId, planId))! };
    });
  }

  /**
   * Shared by the file import and the plan builder. The same unique-violation retry applies:
   * the retry re-runs everything, including `prepare`, and then takes the "already exists" path.
   */
  async function importFrom(
    userId: string,
    planId: string,
    source: ImportSource,
  ): Promise<ImportResult> {
    try {
      return await importOnce(userId, planId, source);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return importOnce(userId, planId, source);
    }
  }

  return {
    /**
     * One transaction: plan, week pattern, overrides, tasks and the `plan.imported` event, or
     * nothing. Idempotent on the client's plan id: the same content returns the stored plan, other
     * content answers 409. Two simultaneous first calls collide on the primary key; the loser
     * runs once more and then takes the "already imported" path.
     */
    importPlan: (userId: string, planId: string, input: ValidImport): Promise<ImportResult> =>
      importFrom(userId, planId, {
        payloadHash: input.payloadHash,
        createdFrom: 'import',
        prepare: async () => ({ status: input.status, plan: input.plan }),
      }),

    /** The import transaction with a different source of the plan (the plan builder). */
    importFrom,

    list: (userId: string): Promise<PlanSummary[]> =>
      db.withUser(userId, (ctx) => repo.listPlans(ctx, userId)),

    async get(userId: string, planId: string): Promise<PlanDetail> {
      const plan = await db.withUser(userId, (ctx) => repo.loadPlan(ctx, userId, planId));
      if (!plan) throw notFound();
      return plan;
    },

    async remove(userId: string, planId: string): Promise<void> {
      const removed = await db.withUser(userId, (ctx) => repo.deletePlan(ctx, userId, planId));
      if (!removed) throw notFound();
    },

    putWeekPattern: (userId: string, planId: string, pattern: WeekPattern) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        await repo.upsertWeekPattern(ctx, userId, planId, pattern);
        await repo.touchPlan(ctx, userId, planId);
        return (await repo.loadPlan(ctx, userId, planId))!.weekPattern!;
      }),

    /**
     * Stores a new start date and nothing else; the schedule, which reads the plan on every
     * request, then starts from that day (the start-date semantics are unchanged). The date must
     * not be before today in the plan's time zone and not after the end date, if there is one.
     */
    putStartDate: (userId: string, planId: string, startDate: string) =>
      db.withUser(userId, async (ctx) => {
        // Serialises with task edits and other plan writes; refuses an archived plan.
        await requireWritablePlan(ctx, userId, planId);
        const dates = (await repo.planDates(ctx, userId, planId))!;
        // Nothing to change: no bounds check, no event.
        if (startDate === dates.startDate) return { startDate, endDate: dates.endDate };
        const today = localDateOf(now(), dates.timezone ?? 'UTC');
        if (compareDates(startDate, today) < 0) {
          throw new HttpError(
            422,
            'unprocessable',
            `The start date cannot be before today (${today}).`,
          );
        }
        if (dates.endDate && compareDates(startDate, dates.endDate) > 0) {
          throw new HttpError(
            422,
            'unprocessable',
            `The start date cannot be after the end date (${dates.endDate}).`,
          );
        }
        // A day that was started, ended or frozen cannot end up before the plan begins.
        const firstDayState = await repo.earliestDayState(ctx, userId, planId);
        if (firstDayState && compareDates(startDate, firstDayState) > 0) {
          throw new HttpError(
            409,
            'day_started',
            `The plan already has a day on ${firstDayState}, so it can't start later than that.`,
          );
        }
        // An exam that would fall before the plan begins can never be scheduled.
        const anchor = await repo.earliestOpenAnchor(ctx, userId, planId);
        if (anchor && compareDates(startDate, anchor.date) > 0) {
          throw new HttpError(
            422,
            'unprocessable',
            `The start date can't be after “${anchor.title}”, which is fixed on ${anchor.date}.`,
          );
        }
        await repo.updateStartDate(ctx, userId, planId, startDate);
        await repo.insertEvent(ctx, userId, planId, 'plan.start_date_changed', {
          from: dates.startDate,
          to: startDate,
        });
        return { startDate, endDate: dates.endDate };
      }),

    putDayOverride: (userId: string, planId: string, override: DayOverride) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        const known = await repo.dayOverrideExists(ctx, userId, planId, override.date);
        if (
          !known &&
          (await repo.countDayOverrides(ctx, userId, planId)) >= MAX_OVERRIDES_PER_PLAN
        ) {
          throw new HttpError(
            422,
            'unprocessable',
            `A plan can have at most ${MAX_OVERRIDES_PER_PLAN} day overrides.`,
          );
        }
        await repo.upsertDayOverride(ctx, userId, planId, override);
        await repo.touchPlan(ctx, userId, planId);
        return override;
      }),

    /** Idempotent: removing an override that is not there succeeds. The plan itself must exist. */
    removeDayOverride: (userId: string, planId: string, date: string) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        await repo.deleteDayOverride(ctx, userId, planId, date);
        await repo.touchPlan(ctx, userId, planId);
      }),
  };
}

export type PlanService = ReturnType<typeof createPlanService>;
