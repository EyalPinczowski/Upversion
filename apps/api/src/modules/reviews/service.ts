import {
  TaskSchema,
  addDays,
  applySuggestion,
  compareDates,
  diffDays,
  isStudyDay,
  suggestAdjustments,
  suggestionOptions,
  type AdjustableInputs,
  type DayReview,
  type Suggestion,
  type TaskOutcome,
} from '@upversion/shared';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import * as daysRepo from '../days/repository';
import type { DayContext, DaysService } from '../days/service';
import { requireWritablePlan } from '../plans/guard';
import * as plansRepo from '../plans/repository';
import { MAX_OVERRIDES_PER_PLAN, MAX_TASKS_PER_PLAN } from '../plans/schemas';
import type { SchedulingService } from '../scheduling/service';
import * as repo from './repository';
import type { StoredAdjustment, StoredReview } from './repository';
import type { AdjustmentView, ReviewView } from './schemas';

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');
const unprocessable = (message: string) => new HttpError(422, 'unprocessable', message);
const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** The engine looks back at most a week plus a gap of study days; this is generous. */
const REVIEW_LOOKBACK_DAYS = 60;
/** A review can be changed on its own day and on the day after (plan-local dates). */
export const REVIEW_EDIT_WINDOW_DAYS = 1;
/** The history endpoint never returns more than this many days. */
const HISTORY_LIMIT = 366;
/** Earlier than any plan date, so "all logs" is one query. */
const EPOCH = '0001-01-01';

const STALE = 'This suggestion is no longer available. Fetch the current suggestions.';

export const toReviewView = (r: StoredReview): ReviewView => ({
  date: r.date,
  difficulty: r.difficulty,
  density: r.density,
  energy: r.energy,
  note: r.note,
  outcomes: r.outcomes,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toAdjustmentView = (a: StoredAdjustment): AdjustmentView => ({
  suggestionId: a.suggestionId,
  rule: a.rule,
  status: a.status,
  option: a.option,
  decidedAt: a.decidedAt.toISOString(),
});

/** One comparable string per outcome list, so a retry with the same content is recognised. */
const outcomeKey = (o: TaskOutcome) =>
  JSON.stringify([o.taskId, o.outcome, o.hours ?? null, o.reason ?? null]);
const sameContent = (a: DayReview, b: DayReview) =>
  a.difficulty === b.difficulty &&
  a.density === b.density &&
  a.energy === b.energy &&
  a.note === b.note &&
  a.outcomes.length === b.outcomes.length &&
  a.outcomes.every((o, i) => outcomeKey(o) === outcomeKey(b.outcomes[i]!));

const round2 = (n: number) => Math.round(n * 100) / 100;

type Logs = { taskId: string; date: string; hours: number }[];

/** The end-of-day review and the adjustment suggestions (spec 3.4). */
export function createReviewService(
  db: Database,
  days: DaysService,
  scheduling: SchedulingService,
) {
  /**
   * For writes only (the review, accept and reject): locks the plan against other writers and
   * refuses an archived one (409 `plan_archived`), then loads it with its stored past days.
   */
  async function openLocked(ctx: UserContext, userId: string, planId: string): Promise<DayContext> {
    await requireWritablePlan(ctx, userId, planId);
    return days.open(ctx, userId, planId);
  }

  /** The open suggestions, recomputed from what is stored. Nothing is saved for them. */
  async function openSuggestions(
    ctx: UserContext,
    userId: string,
    c: DayContext,
    logs?: Logs,
  ): Promise<{ suggestions: Suggestion[]; adjustments: StoredAdjustment[] }> {
    const planLogs = logs ?? (await daysRepo.logsFrom(ctx, userId, c.plan.id, EPOCH));
    const reviews = await repo.listReviewsSince(
      ctx,
      userId,
      c.plan.id,
      addDays(c.today, -REVIEW_LOOKBACK_DAYS),
    );
    const adjustments = await repo.listAdjustments(ctx, userId, c.plan.id);
    const suggestions = suggestAdjustments({
      reviews,
      logs: planLogs,
      tasks: c.plan.tasks,
      pattern: c.pattern,
      overrides: c.plan.overrides,
      today: c.today,
      decided: adjustments.map(repo.toDecided),
    });
    return { suggestions, adjustments };
  }

  const pickSuggestion = (suggestions: Suggestion[], id: string, option: number) => {
    const suggestion = suggestions.find((s) => s.id === id);
    if (!suggestion) throw conflict(STALE);
    if (option >= suggestionOptions(suggestion).length) {
      throw unprocessable(`This suggestion has no option ${option}.`);
    }
    return suggestion;
  };

  /**
   * The inputs after applying one option, checked against the shared task rules so a change the
   * database would refuse (for example a longer anchor task that no longer ends by 23:59) is a
   * clear 422 instead of a failed write.
   */
  function applied(c: DayContext, suggestion: Suggestion, option: number): AdjustableInputs {
    const result = applySuggestion(c.plan.tasks, c.pattern, c.plan.overrides, suggestion, option);
    const before = new Map(c.plan.tasks.map((t) => [t.id, t]));
    for (const task of result.tasks) {
      const old = before.get(task.id);
      if (old && old.estHours === task.estHours && old.order === task.order) continue;
      const valid = TaskSchema.safeParse(task);
      if (!valid.success) {
        throw unprocessable(
          `This change cannot be applied to "${task.title}": ${valid.error.issues[0]?.message ?? 'invalid task'}.`,
        );
      }
    }
    if (result.tasks.length > MAX_TASKS_PER_PLAN) {
      throw unprocessable(`A plan can have at most ${MAX_TASKS_PER_PLAN} tasks.`);
    }
    if (result.overrides.length > MAX_OVERRIDES_PER_PLAN) {
      throw unprocessable(`A plan can have at most ${MAX_OVERRIDES_PER_PLAN} day overrides.`);
    }
    return result;
  }

  /** Writes only what differs from the stored plan: tasks, week pattern and day overrides. */
  async function persist(
    ctx: UserContext,
    userId: string,
    c: DayContext,
    next: AdjustableInputs,
  ): Promise<void> {
    const planId = c.plan.id;
    const tasks = new Map(c.plan.tasks.map((t) => [t.id, t]));
    const added = [];
    for (const task of next.tasks) {
      const old = tasks.get(task.id);
      if (!old) {
        added.push(task);
        continue;
      }
      if (old.estHours !== task.estHours) {
        await plansRepo.updateTaskEstimate(ctx, userId, planId, task.id, task.estHours);
      }
      if (old.order !== task.order) {
        await plansRepo.updateTaskOrder(ctx, userId, planId, task.id, task.order);
      }
    }
    if (added.length > 0) await plansRepo.insertTasks(ctx, userId, planId, added);
    if (JSON.stringify(next.pattern) !== JSON.stringify(c.pattern)) {
      await plansRepo.upsertWeekPattern(ctx, userId, planId, next.pattern);
    }
    const overrides = new Map(c.plan.overrides.map((o) => [o.date, JSON.stringify(o)]));
    for (const o of next.overrides) {
      if (overrides.get(o.date) !== JSON.stringify(o)) {
        await plansRepo.upsertDayOverride(ctx, userId, planId, o);
      }
    }
  }

  return {
    /**
     * Creates or re-saves the review of a day. Idempotent: the same content answers the stored
     * review and writes nothing. Never logs hours or closes a task.
     */
    put: (userId: string, planId: string, date: string, input: DayReview) =>
      db.withUser(userId, async (ctx) => {
        const c = await openLocked(ctx, userId, planId);
        if (input.date !== date) throw unprocessable('The date in the body must match the URL.');
        if (compareDates(date, c.today) > 0)
          throw unprocessable('A future day cannot be reviewed.');
        if (compareDates(date, c.firstDay) < 0) {
          throw unprocessable('A day before the plan began cannot be reviewed.');
        }
        const known = new Set(c.plan.tasks.map((t) => t.id));
        if (input.outcomes.some((o) => !known.has(o.taskId))) {
          throw unprocessable('An outcome refers to a task that is not in this plan.');
        }
        const logs = await daysRepo.logsFrom(ctx, userId, planId, EPOCH);
        const existing = await repo.getReview(ctx, userId, planId, date);

        let created = false;
        if (!existing) {
          const worked =
            isStudyDay(date, c.pattern, c.plan.overrides) ||
            logs.some((l) => l.date === date) ||
            (await daysRepo.getSession(ctx, userId, planId, date)) !== null;
          if (!worked) throw unprocessable('Only a study day can be reviewed.');
          created = await repo.insertReview(ctx, userId, planId, date, input);
          await plansRepo.insertEvent(ctx, userId, planId, 'review.submitted', eventPayload(input));
        } else if (!sameContent(existing, input)) {
          if (diffDays(date, c.today) > REVIEW_EDIT_WINDOW_DAYS) {
            throw conflict('A review can be changed only on its day and the day after.');
          }
          await repo.updateReview(ctx, userId, planId, date, input);
          await plansRepo.insertEvent(ctx, userId, planId, 'review.updated', eventPayload(input));
        }

        const stored = (await repo.getReview(ctx, userId, planId, date))!;
        const { suggestions } = await openSuggestions(ctx, userId, c, logs);

        const missingLogs = input.outcomes.flatMap((o) => {
          if (o.outcome !== 'partial' || o.hours === undefined) return [];
          const logged = logs
            .filter((l) => l.taskId === o.taskId && l.date === date)
            .reduce((sum, l) => sum + l.hours, 0);
          return logged + 1e-9 < o.hours
            ? [
                {
                  taskId: o.taskId,
                  reportedHours: o.hours,
                  loggedHours: round2(logged),
                  missingHours: round2(o.hours - logged),
                },
              ]
            : [];
        });
        const status = new Map(c.plan.tasks.map((t) => [t.id, t.status]));
        const notMarkedDone = input.outcomes
          .filter((o) => o.outcome === 'done' && status.get(o.taskId) !== 'done')
          .map((o) => o.taskId);

        return {
          created,
          review: toReviewView(stored),
          missingLogs,
          notMarkedDone,
          suggestions,
        };
      }),

    getReview: (userId: string, planId: string, date: string) =>
      db.withUser(userId, async (ctx) => {
        if (!(await plansRepo.planExists(ctx, userId, planId))) throw notFound();
        const review = await repo.getReview(ctx, userId, planId, date);
        if (!review) throw notFound();
        return toReviewView(review);
      }),

    history: (userId: string, planId: string, from?: string, to?: string) =>
      db.withUser(userId, async (ctx) => {
        if (!(await plansRepo.planExists(ctx, userId, planId))) throw notFound();
        return { reviews: await repo.listRatings(ctx, userId, planId, from, to, HISTORY_LIMIT) };
      }),

    suggestions: (userId: string, planId: string) =>
      db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const { suggestions } = await openSuggestions(ctx, userId, c);
        return { today: c.today, suggestions };
      }),

    /** Applies the option to a copy and compares the two schedules. Saves nothing. */
    preview: (userId: string, planId: string, id: string, option: number) =>
      db.withUser(userId, async (ctx) => {
        const c = await days.open(ctx, userId, planId);
        const { suggestions } = await openSuggestions(ctx, userId, c);
        const suggestion = pickSuggestion(suggestions, id, option);
        const comparison = scheduling.compareProposal(c, applied(c, suggestion, option));
        return {
          suggestionId: suggestion.id,
          option,
          change: suggestionOptions(suggestion)[option]!,
          summary: comparison.summary,
          currentFinishDate: comparison.current.finishDate,
          proposedFinishDate: comparison.proposed.finishDate,
        };
      }),

    /**
     * The client sends the suggestion id and the option, nothing else. The suggestion is
     * recomputed here from stored state; one that is not in the recomputed list (stale evidence,
     * unknown id) is refused. Idempotent on the suggestion id.
     */
    accept: (userId: string, planId: string, id: string, option: number) =>
      db.withUser(userId, async (ctx) => {
        const c = await openLocked(ctx, userId, planId);
        const { suggestions, adjustments } = await openSuggestions(ctx, userId, c);
        const prior = adjustments.find((a) => a.suggestionId === id);
        if (prior) {
          if (prior.status === 'accepted' && prior.option === option) {
            return { created: false, adjustment: toAdjustmentView(prior), summary: prior.summary };
          }
          throw conflict(`This suggestion was already ${prior.status}.`);
        }
        const suggestion = pickSuggestion(suggestions, id, option);
        const next = applied(c, suggestion, option);
        const { summary } = scheduling.compareProposal(c, next);

        await persist(ctx, userId, c, next);
        const stored = await repo.insertAdjustment(ctx, userId, planId, {
          suggestionId: suggestion.id,
          rule: suggestion.rule,
          key: suggestion.key,
          evidence: suggestion.evidence,
          status: 'accepted',
          option,
          appliedChange: suggestionOptions(suggestion)[option]!,
          summary,
        });
        if (!stored) throw conflict('This suggestion was already decided.');
        await plansRepo.insertEvent(ctx, userId, planId, 'schedule.changed', {
          source: 'adjustment',
          suggestionId: suggestion.id,
          rule: suggestion.rule,
          option,
          summary: summary.text,
          finishBefore: summary.finishBefore,
          finishAfter: summary.finishAfter,
        });
        await plansRepo.touchPlan(ctx, userId, planId);
        return { created: true, adjustment: toAdjustmentView(stored), summary };
      }),

    /** Stores the rejection so the same evidence is not offered again. Idempotent. */
    reject: (userId: string, planId: string, id: string) =>
      db.withUser(userId, async (ctx) => {
        const c = await openLocked(ctx, userId, planId);
        const { suggestions, adjustments } = await openSuggestions(ctx, userId, c);
        const prior = adjustments.find((a) => a.suggestionId === id);
        if (prior) {
          if (prior.status === 'rejected') {
            return { created: false, adjustment: toAdjustmentView(prior), summary: null };
          }
          throw conflict(`This suggestion was already ${prior.status}.`);
        }
        const suggestion = pickSuggestion(suggestions, id, 0);
        const stored = await repo.insertAdjustment(ctx, userId, planId, {
          suggestionId: suggestion.id,
          rule: suggestion.rule,
          key: suggestion.key,
          evidence: suggestion.evidence,
          status: 'rejected',
          option: null,
          appliedChange: null,
          summary: null,
        });
        if (!stored) throw conflict('This suggestion was already decided.');
        await plansRepo.insertEvent(ctx, userId, planId, 'suggestion.rejected', {
          suggestionId: suggestion.id,
          rule: suggestion.rule,
        });
        return { created: true, adjustment: toAdjustmentView(stored), summary: null };
      }),
  };
}

/** Event payloads hold the ratings and counts, never the free-text note. */
function eventPayload(r: DayReview): Record<string, unknown> {
  return {
    date: r.date,
    difficulty: r.difficulty,
    density: r.density,
    energy: r.energy,
    outcomeCount: r.outcomes.length,
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
