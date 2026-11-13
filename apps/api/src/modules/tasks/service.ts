import { localDateOf, TaskSchema } from '@upversion/shared';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { requireWritablePlan } from '../plans/guard';
import { createsCycle } from './graph';
import type { LogBody, LogView, PatchTaskBody, TaskView } from './schemas';

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');
const unprocessable = (message: string) => new HttpError(422, 'unprocessable', message);

/** Task columns as the API reads them: numbers as floats, times as HH:MM. Fixed text only. */
const TASK_COLUMNS = `id, title, type, provider, url, est_hours::float8 as est_hours,
  done_hours::float8 as done_hours, status, sort_order, depends_on, is_anchor, anchor_date,
  to_char(anchor_start_time, 'HH24:MI') as anchor_start_time, pinned_start_date,
  to_char(pinned_start_time, 'HH24:MI') as pinned_start_time, not_before, splittable,
  is_certificate, certificate_name, lessons, how_to_steps, prompt_template, practice_kind, notes,
  source, external_ref, created_at, updated_at`;

const LOG_COLUMNS = `id, plan_id, task_id, date, hours::float8 as hours, result,
  score::float8 as score, note, created_at`;

interface TaskRow {
  id: string;
  title: string;
  type: TaskView['type'];
  provider: string | null;
  url: string | null;
  est_hours: number;
  done_hours: number;
  status: TaskView['status'];
  sort_order: number;
  depends_on: string[];
  is_anchor: boolean;
  anchor_date: string | null;
  anchor_start_time: string | null;
  pinned_start_date: string | null;
  pinned_start_time: string | null;
  not_before: string | null;
  splittable: boolean;
  is_certificate: boolean;
  certificate_name: string | null;
  lessons: TaskView['lessons'];
  how_to_steps: string[];
  prompt_template: string | null;
  practice_kind: string | null;
  notes: string | null;
  source: TaskView['source'];
  external_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LogRow {
  id: string;
  plan_id: string;
  task_id: string;
  date: string;
  hours: number;
  result: string | null;
  score: number | null;
  note: string | null;
  created_at: Date;
}

/** Null columns become absent fields, like the optional fields of the shared task schema. */
const opt = <T>(value: T | null): T | undefined => value ?? undefined;

export function toTaskView(r: TaskRow): TaskView {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    provider: opt(r.provider),
    url: opt(r.url),
    estHours: r.est_hours,
    doneHours: r.done_hours,
    status: r.status,
    order: r.sort_order,
    dependsOn: r.depends_on,
    isAnchor: r.is_anchor,
    anchorDate: opt(r.anchor_date),
    anchorStartTime: opt(r.anchor_start_time),
    pinnedStart:
      r.pinned_start_date && r.pinned_start_time
        ? { date: r.pinned_start_date, start: r.pinned_start_time }
        : undefined,
    notBefore: opt(r.not_before),
    splittable: r.splittable,
    isCertificate: r.is_certificate,
    certificateName: opt(r.certificate_name),
    lessons: r.lessons,
    howToSteps: r.how_to_steps,
    promptTemplate: opt(r.prompt_template),
    practiceKind: opt(r.practice_kind),
    notes: opt(r.notes),
    source: r.source,
    externalRef: opt(r.external_ref),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toLogView(r: LogRow): LogView {
  return {
    id: r.id,
    planId: r.plan_id,
    taskId: r.task_id,
    date: r.date,
    hours: r.hours,
    result: opt(r.result),
    score: opt(r.score),
    note: opt(r.note),
    createdAt: r.created_at.toISOString(),
  };
}

/** The app suggests; the user decides. True while the task is open and the hours reach the estimate. */
const suggestDone = (t: Pick<TaskView, 'status' | 'doneHours' | 'estHours'>) =>
  (t.status === 'pending' || t.status === 'in_progress') && t.doneHours >= t.estHours;

/** Event types are fixed strings from this file; the payload never holds personal details. */
async function writeEvent(
  ctx: UserContext,
  userId: string,
  planId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.client.query(
    `insert into ${ctx.schema}.events (user_id, plan_id, type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [userId, planId, type, JSON.stringify(payload)],
  );
}

/** Task serial per (user, plan, task): row lock, so concurrent writes see each other's result. */
async function lockTask(
  ctx: UserContext,
  userId: string,
  planId: string,
  taskId: string,
): Promise<TaskRow> {
  const { rows } = await ctx.client.query<TaskRow>(
    `select ${TASK_COLUMNS} from ${ctx.schema}.tasks
     where user_id = $1 and plan_id = $2 and id = $3 for update`,
    [userId, planId, taskId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function requirePlan(ctx: UserContext, userId: string, planId: string) {
  const { rows } = await ctx.client.query(
    `select 1 from ${ctx.schema}.plans where user_id = $1 and id = $2`,
    [userId, planId],
  );
  if (rows.length === 0) throw notFound();
}

/** Editable API field to its column and the SQL cast of its parameter. */
const EDITABLE: ReadonlyArray<readonly [keyof PatchTaskBody, string, string]> = [
  ['title', 'title', ''],
  ['provider', 'provider', ''],
  ['url', 'url', ''],
  ['estHours', 'est_hours', ''],
  ['order', 'sort_order', ''],
  ['dependsOn', 'depends_on', '::text[]'],
  ['notBefore', 'not_before', '::date'],
  ['splittable', 'splittable', ''],
  ['certificateName', 'certificate_name', ''],
  ['lessons', 'lessons', '::jsonb'],
  ['howToSteps', 'how_to_steps', '::jsonb'],
  ['promptTemplate', 'prompt_template', ''],
  ['practiceKind', 'practice_kind', ''],
  ['notes', 'notes', ''],
];

/** Task, log and progress operations. Every query runs inside db.withUser (row-level security). */
/**
 * Today's date in the plan's time zone, for events that the day snapshots read ("this task was
 * completed or skipped on that day"). Null when the plan has no week pattern yet.
 */
async function planLocalToday(
  ctx: UserContext,
  userId: string,
  planId: string,
  now: () => Date,
): Promise<string | null> {
  const { rows } = await ctx.client.query<{ timezone: string }>(
    `select timezone from ${ctx.schema}.week_patterns where user_id = $1 and plan_id = $2`,
    [userId, planId],
  );
  return rows[0] ? localDateOf(now(), rows[0].timezone) : null;
}

export function createTaskService(db: Database, now: () => Date = () => new Date()) {
  const run = <T>(userId: string, fn: (ctx: UserContext) => Promise<T>) => db.withUser(userId, fn);

  /**
   * Transaction-scoped variants: the caller owns the transaction (db.withUser), so it can
   * combine them with its own writes atomically. Same rules and events as addLog / completeTask.
   */
  const inCtx = {
    getTaskIn: async (ctx: UserContext, userId: string, planId: string, taskId: string) => {
      const { rows } = await ctx.client.query<TaskRow>(
        `select ${TASK_COLUMNS} from ${ctx.schema}.tasks
         where user_id = $1 and plan_id = $2 and id = $3`,
        [userId, planId, taskId],
      );
      if (!rows[0]) throw notFound();
      return toTaskView(rows[0]);
    },

    addLogIn: async (
      ctx: UserContext,
      userId: string,
      planId: string,
      taskId: string,
      input: LogBody,
    ) => {
      const before = await lockTask(ctx, userId, planId, taskId);

      const inserted = await ctx.client.query<LogRow>(
        `insert into ${ctx.schema}.logs (user_id, id, plan_id, task_id, date, hours, result, score, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (user_id, id) do nothing
           returning ${LOG_COLUMNS}`,
        [
          userId,
          input.id,
          planId,
          taskId,
          input.date,
          input.hours,
          input.result ?? null,
          input.score ?? null,
          input.note ?? null,
        ],
      );

      if (!inserted.rows[0]) {
        // A retry: the same id must carry the same payload, otherwise it is a different request.
        const { rows } = await ctx.client.query<LogRow>(
          `select ${LOG_COLUMNS} from ${ctx.schema}.logs where user_id = $1 and id = $2`,
          [userId, input.id],
        );
        const existing = rows[0]!;
        const same =
          existing.plan_id === planId &&
          existing.task_id === taskId &&
          existing.date === input.date &&
          existing.hours === input.hours &&
          existing.result === (input.result ?? null) &&
          existing.score === (input.score ?? null) &&
          existing.note === (input.note ?? null);
        if (!same) {
          throw new HttpError(409, 'conflict', 'This log id was already used for different data.');
        }
        const task = toTaskView(before);
        return { replayed: true, log: toLogView(existing), task, suggestDone: suggestDone(task) };
      }

      // Added to the stored value (under the row lock), not recomputed from the logs: an
      // imported plan can carry doneHours that have no log rows, and those must not be lost.
      const { rows } = await ctx.client.query<TaskRow>(
        `update ${ctx.schema}.tasks set
             done_hours = done_hours + $4::numeric,
             status = case when status = 'pending' then 'in_progress' else status end,
             updated_at = now()
           where user_id = $1 and plan_id = $2 and id = $3
           returning ${TASK_COLUMNS}`,
        [userId, planId, taskId, input.hours],
      );
      const task = toTaskView(rows[0]!);
      if (before.status === 'pending' && task.status === 'in_progress') {
        await writeEvent(ctx, userId, planId, 'task.started', { taskId, logId: input.id });
      }
      await writeEvent(ctx, userId, planId, 'task.logged', {
        taskId,
        logId: input.id,
        date: input.date,
        hours: input.hours,
        doneHours: task.doneHours,
      });
      return {
        replayed: false,
        log: toLogView(inserted.rows[0]),
        task,
        suggestDone: suggestDone(task),
      };
    },
    /** Explicit user action. Idempotent: completing a done task changes and writes nothing. */
    completeTaskIn: async (ctx: UserContext, userId: string, planId: string, taskId: string) => {
      const before = await lockTask(ctx, userId, planId, taskId);
      if (before.status === 'done') return toTaskView(before);
      const { rows } = await ctx.client.query<TaskRow>(
        `update ${ctx.schema}.tasks set status = 'done', updated_at = now()
           where user_id = $1 and plan_id = $2 and id = $3 returning ${TASK_COLUMNS}`,
        [userId, planId, taskId],
      );
      const task = toTaskView(rows[0]!);
      await writeEvent(ctx, userId, planId, 'task.completed', {
        taskId,
        doneHours: task.doneHours,
        date: await planLocalToday(ctx, userId, planId, now),
      });
      if (task.isCertificate) {
        // A reopened and re-completed certificate is still one certificate.
        const earned = await ctx.client.query(
          `select 1 from ${ctx.schema}.events
             where user_id = $1 and plan_id = $2 and type = 'certificate.earned'
               and payload ->> 'taskId' = $3`,
          [userId, planId, taskId],
        );
        if (earned.rows.length === 0) {
          await writeEvent(ctx, userId, planId, 'certificate.earned', {
            taskId,
            certificateName: task.certificateName ?? null,
          });
        }
      }
      return task;
    },
  };

  return {
    ...inCtx,
    // The public writes refuse an archived plan (ADR 017 section 4.1); the `...In` variants above
    // do not, because they also serve closing a practice session that was open at archive time.
    addLog: (userId: string, planId: string, taskId: string, input: LogBody) =>
      run(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId, 'shared');
        return inCtx.addLogIn(ctx, userId, planId, taskId, input);
      }),
    completeTask: (userId: string, planId: string, taskId: string) =>
      run(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId, 'shared');
        return inCtx.completeTaskIn(ctx, userId, planId, taskId);
      }),
    listTasks: (userId: string, planId: string) =>
      run(userId, async (ctx) => {
        await requirePlan(ctx, userId, planId);
        const { rows } = await ctx.client.query<TaskRow>(
          `select ${TASK_COLUMNS} from ${ctx.schema}.tasks
           where user_id = $1 and plan_id = $2 order by sort_order, id`,
          [userId, planId],
        );
        return rows.map(toTaskView);
      }),

    getTask: (userId: string, planId: string, taskId: string) =>
      run(userId, (ctx) => inCtx.getTaskIn(ctx, userId, planId, taskId)),

    /** The user's own explicit edit. Status, done hours and ownership are not editable here. */
    patchTask: (userId: string, planId: string, taskId: string, patch: PatchTaskBody) =>
      run(userId, async (ctx) => {
        // The plan lock serializes edits of one plan, so two edits cannot close a loop together.
        await requireWritablePlan(ctx, userId, planId);
        const current = toTaskView(await lockTask(ctx, userId, planId, taskId));

        const all = await ctx.client.query<{ id: string; depends_on: string[] }>(
          `select id, depends_on from ${ctx.schema}.tasks where user_id = $1 and plan_id = $2`,
          [userId, planId],
        );
        const known = new Set(all.rows.map((r) => r.id));
        const dependsOn = patch.dependsOn ? [...new Set(patch.dependsOn)] : undefined;
        if (dependsOn) {
          if (dependsOn.some((id) => !known.has(id))) {
            throw unprocessable('A dependency is not a task of this plan.');
          }
          const others = new Map(
            all.rows.filter((r) => r.id !== taskId).map((r) => [r.id, r.depends_on]),
          );
          if (createsCycle(taskId, dependsOn, others)) {
            throw unprocessable('These dependencies would create a loop.');
          }
        }

        // The edited task must still satisfy the shared task rules (anchor end time, no self-loop).
        const merged = TaskSchema.safeParse({
          ...current,
          ...Object.fromEntries(
            Object.entries({ ...patch, dependsOn }).map(([k, v]) => [k, v ?? undefined]),
          ),
        });
        if (!merged.success) {
          throw unprocessable(merged.error.issues[0]?.message ?? 'The task would be invalid.');
        }

        const sets: string[] = [];
        const params: unknown[] = [userId, planId, taskId];
        for (const [key, column, cast] of EDITABLE) {
          if (!(key in patch)) continue;
          let value: unknown = key === 'dependsOn' ? dependsOn : patch[key];
          if (key === 'lessons' || key === 'howToSteps') value = JSON.stringify(value);
          params.push(value);
          sets.push(`${column} = $${params.length}${cast}`);
        }
        const { rows } = await ctx.client.query<TaskRow>(
          `update ${ctx.schema}.tasks set ${sets.join(', ')}, updated_at = now()
           where user_id = $1 and plan_id = $2 and id = $3 returning ${TASK_COLUMNS}`,
          params,
        );
        return toTaskView(rows[0]!);
      }),

    /**
     * Deletes a task in one transaction (the user's explicit action). Tasks that depend on it
     * block the delete (409 has_dependents, listing them) unless `removeDependencies` is set, which
     * drops the id from their dependsOn first. Its logs and practice sessions go with it (foreign
     * keys cascade), so progress totals only count tasks that still exist.
     */
    deleteTask: (userId: string, planId: string, taskId: string, removeDependencies: boolean) =>
      run(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId);
        await lockTask(ctx, userId, planId, taskId);
        const { rows: dependents } = await ctx.client.query<{ id: string; title: string }>(
          `select id, title from ${ctx.schema}.tasks
           where user_id = $1 and plan_id = $2 and $3 = any(depends_on)
           order by sort_order, id`,
          [userId, planId, taskId],
        );
        if (dependents.length > 0) {
          if (!removeDependencies) {
            throw new HttpError(409, 'has_dependents', 'Other tasks depend on this task.', {
              dependents,
            });
          }
          await ctx.client.query(
            `update ${ctx.schema}.tasks
             set depends_on = array_remove(depends_on, $3), updated_at = now()
             where user_id = $1 and plan_id = $2 and $3 = any(depends_on)`,
            [userId, planId, taskId],
          );
        }
        await ctx.client.query(
          `delete from ${ctx.schema}.tasks where user_id = $1 and plan_id = $2 and id = $3`,
          [userId, planId, taskId],
        );
        await writeEvent(ctx, userId, planId, 'task.deleted', {
          taskId,
          removedDependencyFrom: dependents.map((d) => d.id),
        });
      }),

    /**
     * Adds a log in one transaction: the log, done_hours raised by its hours, pending to
     * in_progress on the first log, and the events. Never closes the task by itself.
     */

    /** Back to in_progress when hours were logged, otherwise pending. Idempotent. */
    reopenTask: (userId: string, planId: string, taskId: string) =>
      run(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId, 'shared');
        const before = await lockTask(ctx, userId, planId, taskId);
        if (before.status !== 'done' && before.status !== 'skipped') return toTaskView(before);
        const { rows } = await ctx.client.query<TaskRow>(
          `update ${ctx.schema}.tasks
           set status = case when done_hours > 0 then 'in_progress' else 'pending' end,
               updated_at = now()
           where user_id = $1 and plan_id = $2 and id = $3 returning ${TASK_COLUMNS}`,
          [userId, planId, taskId],
        );
        return toTaskView(rows[0]!);
      }),

    /** Idempotent. A done task has to be reopened first, so a finished task is not skipped by mistake. */
    skipTask: (userId: string, planId: string, taskId: string) =>
      run(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, planId, 'shared');
        const before = await lockTask(ctx, userId, planId, taskId);
        if (before.status === 'skipped') return toTaskView(before);
        if (before.status === 'done') {
          throw new HttpError(409, 'conflict', 'Reopen the task before skipping it.');
        }
        const { rows } = await ctx.client.query<TaskRow>(
          `update ${ctx.schema}.tasks set status = 'skipped', updated_at = now()
           where user_id = $1 and plan_id = $2 and id = $3 returning ${TASK_COLUMNS}`,
          [userId, planId, taskId],
        );
        // The day snapshots read this to know the task was still open earlier that day.
        await writeEvent(ctx, userId, planId, 'task.skipped', {
          taskId,
          date: await planLocalToday(ctx, userId, planId, now),
        });
        return toTaskView(rows[0]!);
      }),

    listLogs: (userId: string, planId: string, from?: string, to?: string) =>
      run(userId, async (ctx) => {
        await requirePlan(ctx, userId, planId);
        const { rows } = await ctx.client.query<LogRow>(
          `select ${LOG_COLUMNS} from ${ctx.schema}.logs
           where user_id = $1 and plan_id = $2
             and ($3::date is null or date >= $3::date)
             and ($4::date is null or date <= $4::date)
           order by date, created_at, id`,
          [userId, planId, from ?? null, to ?? null],
        );
        return rows.map(toLogView);
      }),

    /** Pure SQL aggregation. Planned hours leave out skipped tasks. */
    progress: (userId: string, planId: string) =>
      run(userId, async (ctx) => {
        await requirePlan(ctx, userId, planId);
        const s = ctx.schema;
        const args = [userId, planId];
        const totals = await ctx.client.query<{
          planned: number;
          done: number;
          total: number;
          tasks_done: number;
          skipped: number;
        }>(
          `select coalesce(sum(est_hours) filter (where status <> 'skipped'), 0)::float8 as planned,
                  coalesce(sum(done_hours), 0)::float8 as done,
                  count(*)::int as total,
                  (count(*) filter (where status = 'done'))::int as tasks_done,
                  (count(*) filter (where status = 'skipped'))::int as skipped
           from ${s}.tasks where user_id = $1 and plan_id = $2`,
          args,
        );
        const byType = await ctx.client.query<{
          type: TaskView['type'];
          planned: number;
          done: number;
          total: number;
          tasks_done: number;
        }>(
          `select type,
                  coalesce(sum(est_hours) filter (where status <> 'skipped'), 0)::float8 as planned,
                  coalesce(sum(done_hours), 0)::float8 as done,
                  count(*)::int as total,
                  (count(*) filter (where status = 'done'))::int as tasks_done
           from ${s}.tasks where user_id = $1 and plan_id = $2
           group by type order by type`,
          args,
        );
        const byDay = await ctx.client.query<{ date: string; hours: number; entries: number }>(
          `select date, sum(hours)::float8 as hours, count(*)::int as entries
           from ${s}.logs where user_id = $1 and plan_id = $2
           group by date order by date`,
          args,
        );
        const certs = await ctx.client.query<{ id: string; certificate_name: string | null }>(
          `select id, certificate_name from ${s}.tasks
           where user_id = $1 and plan_id = $2 and is_certificate and status = 'done'
           order by sort_order, id`,
          args,
        );
        const t = totals.rows[0]!;
        return {
          hours: { planned: t.planned, done: t.done },
          tasks: { total: t.total, done: t.tasks_done, skipped: t.skipped },
          certificatesEarned: certs.rows.length,
          certificates: certs.rows.map((c) => ({ taskId: c.id, name: c.certificate_name })),
          byType: byType.rows.map((r) => ({
            type: r.type,
            plannedHours: r.planned,
            doneHours: r.done,
            tasksTotal: r.total,
            tasksDone: r.tasks_done,
          })),
          byDay: byDay.rows.map((r) => ({ date: r.date, hours: r.hours, entries: r.entries })),
        };
      }),
  };
}
