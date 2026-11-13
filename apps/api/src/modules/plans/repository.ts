import type { DayOverride, PlanFile, Task, WeekPattern } from '@upversion/shared';
import { advisoryKey, type UserContext } from '../../db/database';
import type { PlanDetail, PlanSummary } from './schemas';

/**
 * SQL for plans, week patterns, day overrides and tasks. Every function takes the context of
 * `db.withUser`, so row-level security applies; the user id passed in comes from the verified
 * token and is only a second filter (and the owner of new rows), never the only protection.
 */

interface PlanRow {
  id: string;
  status: PlanSummary['status'];
  created_from: PlanSummary['createdFrom'];
  name: string;
  start_date: string;
  end_date: string | null;
  summary: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  task_count: string;
}

interface WeekPatternRow {
  study_weekdays: number[];
  default_hours: string;
  hours_by_weekday: Record<string, number>;
  window_start: string;
  window_end: string;
  lunch_start: string | null;
  lunch_end: string | null;
  break_every_hours: string;
  break_minutes: number;
  min_block_minutes: number;
  timezone: string;
}

interface TaskRow {
  id: string;
  title: string;
  type: Task['type'];
  provider: string | null;
  url: string | null;
  est_hours: string;
  done_hours: string;
  status: Task['status'];
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
  lessons: Task['lessons'];
  how_to_steps: string[];
  prompt_template: string | null;
  practice_kind: string | null;
  notes: string | null;
  source: Task['source'];
  external_ref: string | null;
}

/** `time` columns come back as HH:MM:SS; the API speaks HH:MM. */
const hhmm = (time: string) => time.slice(0, 5);
const hhmmOrUndefined = (time: string | null) => (time === null ? undefined : hhmm(time));

function toSummary(row: PlanRow): PlanSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdFrom: row.created_from,
    startDate: row.start_date,
    endDate: row.end_date,
    summary: row.summary,
    taskCount: Number(row.task_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toWeekPattern(row: WeekPatternRow): WeekPattern {
  return {
    studyWeekdays: row.study_weekdays,
    defaultHours: Number(row.default_hours),
    hoursByWeekday: row.hours_by_weekday,
    windowStart: hhmm(row.window_start),
    windowEnd: hhmm(row.window_end),
    lunchStart: hhmmOrUndefined(row.lunch_start),
    lunchEnd: hhmmOrUndefined(row.lunch_end),
    breakEveryHours: Number(row.break_every_hours),
    breakMinutes: row.break_minutes,
    minBlockMinutes: row.min_block_minutes,
    timezone: row.timezone,
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    provider: row.provider ?? undefined,
    url: row.url ?? undefined,
    estHours: Number(row.est_hours),
    doneHours: Number(row.done_hours),
    status: row.status,
    order: row.sort_order,
    dependsOn: row.depends_on,
    isAnchor: row.is_anchor,
    anchorDate: row.anchor_date ?? undefined,
    anchorStartTime: hhmmOrUndefined(row.anchor_start_time),
    pinnedStart:
      row.pinned_start_date && row.pinned_start_time
        ? { date: row.pinned_start_date, start: hhmm(row.pinned_start_time) }
        : undefined,
    notBefore: row.not_before ?? undefined,
    splittable: row.splittable,
    isCertificate: row.is_certificate,
    certificateName: row.certificate_name ?? undefined,
    lessons: row.lessons,
    howToSteps: row.how_to_steps,
    promptTemplate: row.prompt_template ?? undefined,
    practiceKind: row.practice_kind ?? undefined,
    notes: row.notes ?? undefined,
    source: row.source,
    externalRef: row.external_ref ?? undefined,
  };
}

const PLAN_SELECT = (schema: string) => `
  select p.*, (select count(*) from ${schema}.tasks t
               where t.user_id = p.user_id and t.plan_id = p.id) as task_count
  from ${schema}.plans p`;

export async function listPlans(ctx: UserContext, userId: string): Promise<PlanSummary[]> {
  const { rows } = await ctx.client.query<PlanRow>(
    `${PLAN_SELECT(ctx.schema)} where p.user_id = $1 order by p.created_at desc, p.id`,
    [userId],
  );
  return rows.map(toSummary);
}

/** The plan with its pattern, overrides and tasks; null when it is not the user's (or absent). */
export async function loadPlan(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<PlanDetail | null> {
  const { rows } = await ctx.client.query<PlanRow>(
    `${PLAN_SELECT(ctx.schema)} where p.user_id = $1 and p.id = $2`,
    [userId, planId],
  );
  if (rows.length === 0) return null;
  const [pattern, overrides, tasks] = await Promise.all([
    ctx.client.query<WeekPatternRow>(
      `select * from ${ctx.schema}.week_patterns where user_id = $1 and plan_id = $2`,
      [userId, planId],
    ),
    ctx.client.query<{ date: string; is_study_day: boolean; capacity_hours: string | null }>(
      `select date, is_study_day, capacity_hours from ${ctx.schema}.day_overrides
       where user_id = $1 and plan_id = $2 order by date`,
      [userId, planId],
    ),
    ctx.client.query<TaskRow>(
      `select * from ${ctx.schema}.tasks where user_id = $1 and plan_id = $2
       order by sort_order, id`,
      [userId, planId],
    ),
  ]);
  return {
    ...toSummary(rows[0]!),
    weekPattern: pattern.rows[0] ? toWeekPattern(pattern.rows[0]) : null,
    overrides: overrides.rows.map((o) => ({
      date: o.date,
      isStudyDay: o.is_study_day,
      capacityHours: o.capacity_hours === null ? undefined : Number(o.capacity_hours),
    })),
    tasks: tasks.rows.map(toTask),
  };
}

export async function planExists(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<boolean> {
  const { rowCount } = await ctx.client.query(
    `select 1 from ${ctx.schema}.plans where user_id = $1 and id = $2`,
    [userId, planId],
  );
  return rowCount === 1;
}

export async function deletePlan(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<boolean> {
  const { rowCount } = await ctx.client.query(
    `delete from ${ctx.schema}.plans where user_id = $1 and id = $2`,
    [userId, planId],
  );
  return rowCount === 1;
}

/** The plan's own dates and the time zone of its week pattern (null before it has one). */
export async function planDates(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<{ startDate: string; endDate: string | null; timezone: string | null } | null> {
  const { rows } = await ctx.client.query<{
    start_date: string;
    end_date: string | null;
    timezone: string | null;
  }>(
    `select p.start_date::text, p.end_date::text, w.timezone
     from ${ctx.schema}.plans p
     left join ${ctx.schema}.week_patterns w on w.user_id = p.user_id and w.plan_id = p.id
     where p.user_id = $1 and p.id = $2`,
    [userId, planId],
  );
  const r = rows[0];
  return r ? { startDate: r.start_date, endDate: r.end_date, timezone: r.timezone } : null;
}

/** The earliest date that has a started, ended or frozen day for the plan; null when none. */
export async function earliestDayState(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<string | null> {
  const { rows } = await ctx.client.query<{ d: string | null }>(
    `select least(
       (select min(date) from ${ctx.schema}.day_sessions where user_id = $1 and plan_id = $2),
       (select min(date) from ${ctx.schema}.schedule_days where user_id = $1 and plan_id = $2)
     )::text as d`,
    [userId, planId],
  );
  return rows[0]?.d ?? null;
}

/** The open (not done, not skipped) anchor task with the earliest date, if any. */
export async function earliestOpenAnchor(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<{ title: string; date: string } | null> {
  const { rows } = await ctx.client.query<{ title: string; date: string }>(
    `select title, anchor_date::text as date from ${ctx.schema}.tasks
     where user_id = $1 and plan_id = $2 and is_anchor and anchor_date is not null
       and status in ('pending', 'in_progress')
     order by anchor_date, sort_order limit 1`,
    [userId, planId],
  );
  return rows[0] ?? null;
}

export async function updateStartDate(
  ctx: UserContext,
  userId: string,
  planId: string,
  startDate: string,
): Promise<void> {
  await ctx.client.query(
    `update ${ctx.schema}.plans set start_date = $3, updated_at = now() where user_id = $1 and id = $2`,
    [userId, planId, startDate],
  );
}

export async function touchPlan(ctx: UserContext, userId: string, planId: string): Promise<void> {
  await ctx.client.query(
    `update ${ctx.schema}.plans set updated_at = now() where user_id = $1 and id = $2`,
    [userId, planId],
  );
}

export async function insertPlan(
  ctx: UserContext,
  userId: string,
  planId: string,
  status: 'draft' | 'active',
  plan: PlanFile,
  summary: Record<string, unknown>,
  createdFrom: 'import' | 'builder' = 'import',
): Promise<void> {
  await ctx.client.query(
    `insert into ${ctx.schema}.plans (user_id, id, status, created_from, name, start_date, end_date, summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      planId,
      status,
      createdFrom,
      plan.name,
      plan.startDate,
      plan.endDate ?? null,
      JSON.stringify(summary),
    ],
  );
}

export async function upsertWeekPattern(
  ctx: UserContext,
  userId: string,
  planId: string,
  p: WeekPattern,
): Promise<void> {
  await ctx.client.query(
    `insert into ${ctx.schema}.week_patterns
       (user_id, plan_id, study_weekdays, default_hours, hours_by_weekday, window_start, window_end,
        lunch_start, lunch_end, break_every_hours, break_minutes, min_block_minutes, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (user_id, plan_id) do update set
       study_weekdays = excluded.study_weekdays, default_hours = excluded.default_hours,
       hours_by_weekday = excluded.hours_by_weekday, window_start = excluded.window_start,
       window_end = excluded.window_end, lunch_start = excluded.lunch_start,
       lunch_end = excluded.lunch_end, break_every_hours = excluded.break_every_hours,
       break_minutes = excluded.break_minutes, min_block_minutes = excluded.min_block_minutes,
       timezone = excluded.timezone`,
    [
      userId,
      planId,
      p.studyWeekdays,
      p.defaultHours,
      JSON.stringify(p.hoursByWeekday),
      p.windowStart,
      p.windowEnd,
      p.lunchStart ?? null,
      p.lunchEnd ?? null,
      p.breakEveryHours,
      p.breakMinutes,
      p.minBlockMinutes,
      p.timezone,
    ],
  );
}

export async function upsertDayOverride(
  ctx: UserContext,
  userId: string,
  planId: string,
  o: DayOverride,
): Promise<void> {
  await ctx.client.query(
    `insert into ${ctx.schema}.day_overrides (user_id, plan_id, date, is_study_day, capacity_hours)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id, plan_id, date) do update set
       is_study_day = excluded.is_study_day, capacity_hours = excluded.capacity_hours`,
    [userId, planId, o.date, o.isStudyDay, o.capacityHours ?? null],
  );
}

export async function deleteDayOverride(
  ctx: UserContext,
  userId: string,
  planId: string,
  date: string,
): Promise<void> {
  await ctx.client.query(
    `delete from ${ctx.schema}.day_overrides where user_id = $1 and plan_id = $2 and date = $3`,
    [userId, planId, date],
  );
}

export async function dayOverrideExists(
  ctx: UserContext,
  userId: string,
  planId: string,
  date: string,
): Promise<boolean> {
  const { rowCount } = await ctx.client.query(
    `select 1 from ${ctx.schema}.day_overrides where user_id = $1 and plan_id = $2 and date = $3`,
    [userId, planId, date],
  );
  return rowCount === 1;
}

export async function countDayOverrides(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<number> {
  const { rows } = await ctx.client.query<{ n: string }>(
    `select count(*) as n from ${ctx.schema}.day_overrides where user_id = $1 and plan_id = $2`,
    [userId, planId],
  );
  return Number(rows[0]!.n);
}

const TASK_COLUMNS = [
  'user_id',
  'plan_id',
  'id',
  'title',
  'type',
  'provider',
  'url',
  'est_hours',
  'done_hours',
  'status',
  'sort_order',
  'depends_on',
  'is_anchor',
  'anchor_date',
  'anchor_start_time',
  'pinned_start_date',
  'pinned_start_time',
  'not_before',
  'splittable',
  'is_certificate',
  'certificate_name',
  'lessons',
  'how_to_steps',
  'prompt_template',
  'practice_kind',
  'notes',
  'source',
  'external_ref',
] as const;

const TASK_CHUNK = 100;

export async function insertTasks(
  ctx: UserContext,
  userId: string,
  planId: string,
  tasks: Task[],
): Promise<void> {
  for (let i = 0; i < tasks.length; i += TASK_CHUNK) {
    const chunk = tasks.slice(i, i + TASK_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((t) => {
      params.push(
        userId,
        planId,
        t.id,
        t.title,
        t.type,
        t.provider ?? null,
        t.url ?? null,
        t.estHours,
        t.doneHours,
        t.status,
        t.order,
        t.dependsOn,
        t.isAnchor,
        t.anchorDate ?? null,
        t.anchorStartTime ?? null,
        t.pinnedStart?.date ?? null,
        t.pinnedStart?.start ?? null,
        t.notBefore ?? null,
        t.splittable,
        t.isCertificate,
        t.certificateName ?? null,
        JSON.stringify(t.lessons),
        JSON.stringify(t.howToSteps),
        t.promptTemplate ?? null,
        t.practiceKind ?? null,
        t.notes ?? null,
        t.source,
        t.externalRef ?? null,
      );
      const base = params.length - TASK_COLUMNS.length;
      return `(${TASK_COLUMNS.map((_, c) => `$${base + c + 1}`).join(', ')})`;
    });
    await ctx.client.query(
      `insert into ${ctx.schema}.tasks (${TASK_COLUMNS.join(', ')}) values ${tuples.join(', ')}`,
      params,
    );
  }
}

export async function insertOverrides(
  ctx: UserContext,
  userId: string,
  planId: string,
  overrides: DayOverride[],
): Promise<void> {
  for (const o of overrides) await upsertDayOverride(ctx, userId, planId, o);
}

export async function insertEvent(
  ctx: UserContext,
  userId: string,
  planId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.client.query(
    `insert into ${ctx.schema}.events (user_id, plan_id, type, payload) values ($1, $2, $3, $4)`,
    [userId, planId, type, JSON.stringify(payload)],
  );
}

/** Locks the plan row against other writers of the same plan; false when it is not the user's. */
export async function lockPlan(ctx: UserContext, userId: string, planId: string): Promise<boolean> {
  // NO KEY UPDATE conflicts with itself but not with the key-share lock a log insert takes on
  // the plan row, so a log being written never waits on (or deadlocks with) a review or an accept.
  const { rowCount } = await ctx.client.query(
    `select 1 from ${ctx.schema}.plans where user_id = $1 and id = $2 for no key update`,
    [userId, planId],
  );
  return rowCount === 1;
}

export async function updateTaskEstimate(
  ctx: UserContext,
  userId: string,
  planId: string,
  taskId: string,
  estHours: number,
): Promise<void> {
  await ctx.client.query(
    `update ${ctx.schema}.tasks set est_hours = $4, updated_at = now()
     where user_id = $1 and plan_id = $2 and id = $3`,
    [userId, planId, taskId, estHours],
  );
}

export async function updateTaskOrder(
  ctx: UserContext,
  userId: string,
  planId: string,
  taskId: string,
  order: number,
): Promise<void> {
  await ctx.client.query(
    `update ${ctx.schema}.tasks set sort_order = $4, updated_at = now()
     where user_id = $1 and plan_id = $2 and id = $3`,
    [userId, planId, taskId, order],
  );
}

/** The content hash recorded when the plan was imported, or null if it was not imported. */
export async function importHashOf(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<string | null> {
  const { rows } = await ctx.client.query<{ hash: string | null }>(
    `select payload ->> 'payloadHash' as hash from ${ctx.schema}.events
     where user_id = $1 and plan_id = $2 and type = 'plan.imported'
     order by created_at, id limit 1`,
    [userId, planId],
  );
  return rows[0]?.hash ?? null;
}

/** The plan's time zone (from its week pattern); null when the plan has no week pattern yet. */
export async function planTimezone(
  ctx: UserContext,
  userId: string,
  planId: string,
): Promise<string | null> {
  const { rows } = await ctx.client.query<{ timezone: string }>(
    `select timezone from ${ctx.schema}.week_patterns where user_id = $1 and plan_id = $2`,
    [userId, planId],
  );
  return rows[0]?.timezone ?? null;
}

/**
 * The per-user lock that serialises everything that decides which plan is active: a build, a
 * restore and an import (ADR 017 section 4.1). A row lock on the active plans alone would lock
 * nothing when none is active, so two builds could both succeed. Held until the transaction
 * ends. Always the first lock a transaction takes. The schema is in the key, because the same
 * user id exists in both environments (one Supabase Auth, ADR 003).
 */
export async function lockUserPlans(ctx: UserContext, userId: string): Promise<void> {
  await ctx.client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
    advisoryKey(ctx, 'active-plan', userId),
  ]);
}

/**
 * Locks the plan row and returns its status; null when it is not the user's. `exclusive` is the
 * `for no key update` of `lockPlan` (serialises with other plan writers). `shared` is
 * `for key share`: it does not wait for a review or an accept that holds the exclusive lock (a
 * log must never wait for one), and it does not wait for a build or a restore either, because
 * they only update non-key columns. A write that slips in beside an archive is the same as one
 * that came just before it.
 */
export async function lockPlanStatus(
  ctx: UserContext,
  userId: string,
  planId: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<PlanSummary['status'] | null> {
  const lock = mode === 'exclusive' ? 'no key update' : 'key share';
  const { rows } = await ctx.client.query<{ status: PlanSummary['status'] }>(
    `select status from ${ctx.schema}.plans where user_id = $1 and id = $2 for ${lock}`,
    [userId, planId],
  );
  return rows[0]?.status ?? null;
}

/** The ids of the user's active plans (locked, so the set cannot change under the caller). */
export async function lockActivePlanIds(ctx: UserContext, userId: string): Promise<string[]> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `select id from ${ctx.schema}.plans where user_id = $1 and status = 'active'
     order by id for no key update`,
    [userId],
  );
  return rows.map((r) => r.id);
}

export async function setPlanStatus(
  ctx: UserContext,
  userId: string,
  planId: string,
  status: PlanSummary['status'],
): Promise<void> {
  await ctx.client.query(
    `update ${ctx.schema}.plans set status = $3, updated_at = now() where user_id = $1 and id = $2`,
    [userId, planId, status],
  );
}
