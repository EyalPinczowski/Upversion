import {
  DayOverrideSchema,
  LocalDateSchema,
  TaskSchema,
  WeekPatternSchema,
  type DayOverride,
  type Task,
  type WeekPattern,
} from '@upversion/shared';
import { z } from 'zod';
import { replacesPlanIds } from '../plan-builder/schemas';

/** Limits that keep one import small enough for the free tiers. */
export const MAX_IMPORT_BODY_BYTES = 512 * 1024;
export const MAX_TASKS_PER_PLAN = 500;
export const MAX_OVERRIDES_PER_PLAN = 1000;

export const planIdParams = z.object({ id: z.uuid() });
export const dayOverrideParams = z.object({ id: z.uuid(), date: LocalDateSchema });

export const startDateBody = z.object({ startDate: LocalDateSchema }).strict();
export const startDateResult = z.object({
  startDate: LocalDateSchema,
  endDate: LocalDateSchema.nullable(),
});

export const planStatusSchema = z.enum(['draft', 'active', 'archived', 'done']);

/**
 * The import body is a plan file (shared `PlanFileSchema`, formatVersion 1) plus two envelope
 * fields. The plan file itself is validated by `parsePlanFile` in the handler, so a bad plan
 * answers 422 with the field paths. Unknown keys (for example a `user_id`) are never read.
 */
export const importPlanBody = z.looseObject({
  /** Client-generated plan id: a retry with the same id and content returns the same plan. */
  id: z.uuid(),
  /** `active` unless the body says `draft`. */
  status: z.enum(['draft', 'active']).optional(),
  /**
   * Exactly the plans that are active now (what the user confirmed in the archive dialog), as for
   * a build (ADR 018 Q2). Used only for an `active` import; omitted means none. A different set
   * answers 409 `active_plan_changed`.
   */
  replacesPlanIds: replacesPlanIds.optional(),
});

export const planSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: planStatusSchema,
  createdFrom: z.enum(['builder', 'import']),
  startDate: LocalDateSchema,
  endDate: LocalDateSchema.nullable(),
  summary: z.record(z.string(), z.unknown()),
  taskCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const planDetailSchema = planSummarySchema.extend({
  weekPattern: WeekPatternSchema.nullable(),
  overrides: z.array(DayOverrideSchema),
  tasks: z.array(TaskSchema),
});

export const planListSchema = z.object({ plans: z.array(planSummarySchema) });

export const dayOverrideBody = DayOverrideSchema.omit({ date: true });

export type PlanSummary = z.infer<typeof planSummarySchema>;
export interface PlanDetail extends PlanSummary {
  weekPattern: WeekPattern | null;
  overrides: DayOverride[];
  tasks: Task[];
}
