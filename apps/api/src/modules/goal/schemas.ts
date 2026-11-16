import { GoalSchema, MAX_SUGGESTED_LEVEL } from '@upversion/shared';
import { z } from 'zod';
import { planStatusSchema } from '../plans/schemas';

const skillId = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const goalProgressParams = z.object({ id: z.uuid() });

/** No query parameters exist: a `userId` (or anything else) is a 400. */
export const emptyQuery = z.strictObject({});

const practiceSchema = z.object({ average: z.number(), count: z.number().int() }).nullable();

export const skillProgressSchema = z.object({
  skillId: z.string(),
  plannedHours: z.number(),
  doneHours: z.number(),
  coverage: z.number(),
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
  status: z.enum(['not_started', 'in_progress', 'done']),
  level: z.number().int(),
  practice: practiceSchema,
});

export const planProgressSchema = z.object({
  label: z.literal('plan coverage'),
  skills: z.array(skillProgressSchema),
  coverage: z.number(),
  plannedHours: z.number(),
  doneHours: z.number(),
  unattributedHours: z.number(),
  unattributedTasks: z.number().int(),
});

export const levelSuggestionSchema = z.object({
  skillId: z.string(),
  fromLevel: z.number().int(),
  toLevel: z.number().int(),
  reason: z.literal('all_tasks_done'),
  tasksDone: z.number().int(),
  practice: practiceSchema,
});

/**
 * `goal` and `progress` are null for a plan that names no skill (nothing to measure).
 * `suggestions` is empty for an archived plan (it is read-only; restore it first).
 */
export const goalProgressSchema = z.object({
  planId: z.uuid(),
  planStatus: planStatusSchema,
  goal: GoalSchema.nullable(),
  progress: planProgressSchema.nullable(),
  suggestions: z.array(levelSuggestionSchema),
});

/** Strict: a `userId` or any other key is a 400. The level can only be 1 or 2 (the suggestion cap). */
export const approveBody = z.strictObject({
  planId: z.uuid(),
  skillId,
  toLevel: z.number().int().min(1).max(MAX_SUGGESTED_LEVEL),
});

export const approveResult = z.object({
  skillId: z.string(),
  fromLevel: z.number().int(),
  level: z.number().int(),
  source: z.literal('manual'),
});

export type GoalProgress = z.infer<typeof goalProgressSchema>;
