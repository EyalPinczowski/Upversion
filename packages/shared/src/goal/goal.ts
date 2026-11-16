import { z } from 'zod';
import { LocalDateSchema, SkillIdSchema } from '../schemas';

/**
 * The goal of a plan (ADR 018): target roles and skills with the user's starting levels. Ids and
 * numbers only, no free text, so it can never carry personal data. It is stored under the `goal`
 * key of `plans.summary` (decision Q1: no new table, no migration).
 */

/** The key of `plans.summary` that holds the goal. */
export const PLAN_SUMMARY_GOAL_KEY = 'goal';
export const MAX_GOAL_ROLES = 2;
export const MAX_GOAL_SKILLS = 60;
/** Skill level scale: 0 none, 1 basic, 2 comfortable, 3 strong (`skill_levels`). */
export const MAX_SKILL_LEVEL = 3;
/** The app never suggests a level above this (owner, ADR 018 Q3): 2 = comfortable. */
export const MAX_SUGGESTED_LEVEL = 2;

const RoleIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, { message: 'Expected a role id' });
const LevelSchema = z.number().int().min(0).max(MAX_SKILL_LEVEL);

export const GOAL_ORIGINS = ['builder', 'import', 'manual'] as const;
export const GoalOriginSchema = z.enum(GOAL_ORIGINS);

export const GoalSchema = z
  .strictObject({
    targetRoleIds: z.array(RoleIdSchema).max(MAX_GOAL_ROLES),
    skillIds: z.array(SkillIdSchema).max(MAX_GOAL_SKILLS),
    /** Skill id to the level the user had when the goal was set. */
    startLevels: z.record(SkillIdSchema, LevelSchema).default({}),
    /** The deadline the goal was set with (a date, never text). */
    deadline: LocalDateSchema.optional(),
    /** How the plan came to be. */
    createdFrom: GoalOriginSchema.optional(),
  })
  .superRefine((goal, ctx) => {
    const inGoal = new Set(goal.skillIds);
    const keys = Object.keys(goal.startLevels);
    if (keys.length > MAX_GOAL_SKILLS) {
      ctx.addIssue({ code: 'custom', message: 'Too many start levels', path: ['startLevels'] });
    }
    for (const key of keys) {
      if (!inGoal.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'A start level needs its skill in skillIds',
          path: ['startLevels', key],
        });
      }
    }
  });

export type Goal = z.infer<typeof GoalSchema>;
export type GoalInput = z.input<typeof GoalSchema>;

function unique(list: readonly unknown[], max: number, valid: (v: string) => boolean): string[] {
  const out: string[] = [];
  for (const v of list) {
    if (out.length >= max) break;
    if (typeof v === 'string' && valid(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

const idOk = (v: string) => SkillIdSchema.safeParse(v).success;

export interface CreateGoalInput {
  targetRoleIds: readonly string[];
  skillIds: readonly string[];
  startLevels?: Readonly<Record<string, number>>;
  deadline?: string;
  createdFrom?: (typeof GOAL_ORIGINS)[number];
}

/**
 * Builds a valid goal from loose input: duplicate and malformed ids are dropped, lists are
 * capped, and levels for skills that are not in the goal are left out. Throws (zod) when a
 * remaining field is invalid (for example a bad deadline).
 */
export function createGoal(input: CreateGoalInput): Goal {
  const skillIds = unique(input.skillIds, MAX_GOAL_SKILLS, idOk);
  const pick = (levels: Readonly<Record<string, number>> | undefined, min: number) => {
    const out: Record<string, number> = {};
    for (const id of skillIds) {
      const v = levels && Object.hasOwn(levels, id) ? levels[id] : undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const level = Math.min(MAX_SKILL_LEVEL, Math.max(0, Math.round(v)));
      if (level >= min) out[id] = level;
    }
    return out;
  };
  return GoalSchema.parse({
    targetRoleIds: unique(input.targetRoleIds, MAX_GOAL_ROLES, idOk),
    skillIds,
    startLevels: pick(input.startLevels, 0),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
  });
}

/** The plan summary with the goal written under `goal` (a new object; the input is not changed). */
export function withGoal(summary: Record<string, unknown>, goal: Goal): Record<string, unknown> {
  return { ...summary, [PLAN_SUMMARY_GOAL_KEY]: GoalSchema.parse(goal) };
}

function fallbackGoal(roles: readonly unknown[], skills: readonly unknown[]): Goal | null {
  const skillIds = unique(skills, MAX_GOAL_SKILLS, idOk);
  if (skillIds.length === 0) return null;
  return { targetRoleIds: unique(roles, MAX_GOAL_ROLES, idOk), skillIds, startLevels: {} };
}

/**
 * The goal of a plan, from its `summary` (jsonb as stored). Uses `summary.goal` when it is valid.
 * Otherwise falls back to what older plans hold: `summary.skillIds` (imports) plus the optional
 * `planSkillIds`, and `summary.targetRoleIds` (builder plans), with no start levels. Returns null
 * when no skill id is found (a plan without a goal).
 */
export function deriveGoal(summary: unknown, planSkillIds?: readonly string[]): Goal | null {
  const extra = planSkillIds ?? [];
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    return fallbackGoal([], extra);
  }
  const s = summary as Record<string, unknown>;
  const direct = GoalSchema.safeParse(s[PLAN_SUMMARY_GOAL_KEY]);
  if (direct.success) return direct.data;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return fallbackGoal(list(s.targetRoleIds), [...list(s.skillIds), ...extra]);
}
