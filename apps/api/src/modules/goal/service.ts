import {
  deriveGoal,
  MAX_PROFILE_SKILLS,
  skillProgress,
  suggestLevelUps,
  taskSkills,
  TAXONOMY_SKILL_IDS,
  type PracticeScores,
  type ProgressCatalog,
  type UserProfile,
} from '@upversion/shared';
import { BUNDLED_CATALOG } from '@upversion/shared/plan-builder';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { requireWritablePlan } from '../plans/guard';
import * as plansRepo from '../plans/repository';
import type { PlanDetail } from '../plans/schemas';
import { createProfileRepository } from '../profile/repository';
import type { GoalProgress } from './schemas';

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');

/** Profile skill levels as a plain map (the user's own ratings, any source). */
const levelsOf = (profile: Pick<UserProfile, 'skills'>) =>
  Object.fromEntries(profile.skills.map((s) => [s.skillId, s.level]));

/**
 * Practice scores (0..10) per skill, as evidence only: each practice session's score is credited
 * to the skills of the task it was for. Sessions without a score are left out.
 */
async function practiceScores(
  ctx: UserContext,
  userId: string,
  plan: PlanDetail,
  catalog: ProgressCatalog,
): Promise<PracticeScores> {
  const { rows } = await ctx.client.query<{ task_id: string; score: number }>(
    `select s.task_id, f.score::float8 as score
       from ${ctx.schema}.practice_feedback f
       join ${ctx.schema}.practice_sessions s on s.user_id = f.user_id and s.id = f.session_id
      where f.user_id = $1 and s.plan_id = $2 and f.score is not null`,
    [userId, plan.id],
  );
  const itemSkills = new Map(catalog.items.map((i) => [i.id, i.skills]));
  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const out = new Map<string, number[]>();
  for (const row of rows) {
    const task = taskById.get(row.task_id);
    if (!task) continue;
    for (const skill of taskSkills(task, itemSkills)) {
      const list = out.get(skill) ?? [];
      list.push(row.score);
      out.set(skill, list);
    }
  }
  return Object.fromEntries(out);
}

/**
 * The goal, the plan coverage per skill and the level suggestions for one plan (ADR 018). Pure
 * given its inputs; the callers decide how the rows were locked.
 */
function compute(
  plan: PlanDetail,
  profile: Pick<UserProfile, 'skills'>,
  scores: PracticeScores,
  catalog: ProgressCatalog,
  approved: readonly string[],
): Pick<GoalProgress, 'goal' | 'progress' | 'suggestions'> {
  const goal = deriveGoal(plan.summary);
  if (!goal) return { goal: null, progress: null, suggestions: [] };
  const profileLevels = levelsOf(profile);
  const progress = skillProgress({
    tasks: plan.tasks,
    goal,
    profileLevels,
    catalog,
    practiceScores: scores,
  });
  // Only an active plan suggests (an archived one is read-only, ADR 017 4.1; a draft is not
  // being followed yet), and a skill is suggested at most once per plan.
  const suggestions =
    plan.status === 'active' ? suggestLevelUps(progress, profileLevels, approved) : [];
  return { goal, progress, suggestions };
}

/**
 * Goal progress and level approval. The user id is the verified token's; every query runs in
 * db.withUser (row-level security), and a plan that is not the caller's looks like one that does
 * not exist (404). `catalog` is injectable for tests only.
 */
export function createGoalService(
  db: Database,
  now: () => Date = () => new Date(),
  catalog: ProgressCatalog = BUNDLED_CATALOG,
) {
  return {
    /** Read only: nothing is written, whatever the suggestions say. */
    getProgress: (userId: string, planId: string): Promise<GoalProgress> =>
      db.withUser(userId, async (ctx) => {
        const plan = await plansRepo.loadPlan(ctx, userId, planId);
        if (!plan) throw notFound();
        const profile = await createProfileRepository(ctx).get(userId);
        const scores = await practiceScores(ctx, userId, plan, catalog);
        const approved = await plansRepo.approvedLevelUpSkills(ctx, userId, planId);
        return {
          planId: plan.id,
          planStatus: plan.status,
          ...compute(plan, profile, scores, catalog, approved),
        };
      }),

    /**
     * The only way a level is written from progress, and only on the user's explicit call. The
     * suggestion is recomputed here from the stored tasks and profile; the request's `toLevel`
     * must be exactly the one suggested now (one level above the current one, never above 2),
     * else 409 `not_suggested` and nothing is written. The plan row is locked (404 for another
     * user's plan, 409 `plan_archived` for an archived one) and its tasks are share-locked, so a
     * task cannot be reopened between the check and the write.
     */
    approveLevelUp: (userId: string, input: { planId: string; skillId: string; toLevel: number }) =>
      db.withUser(userId, async (ctx) => {
        await requireWritablePlan(ctx, userId, input.planId);
        await plansRepo.lockPlanTasksShared(ctx, userId, input.planId);
        const plan = (await plansRepo.loadPlan(ctx, userId, input.planId))!;
        const profiles = createProfileRepository(ctx);
        const at = now();
        const profile = await profiles.lock(userId, at);
        const scores = await practiceScores(ctx, userId, plan, catalog);
        const approved = await plansRepo.approvedLevelUpSkills(ctx, userId, input.planId);
        const { suggestions } = compute(plan, profile, scores, catalog, approved);
        const suggestion = suggestions.find(
          (s) => s.skillId === input.skillId && s.toLevel === input.toLevel,
        );
        if (!suggestion || !TAXONOMY_SKILL_IDS.has(input.skillId)) {
          throw new HttpError(
            409,
            'not_suggested',
            'This level update is not suggested for this plan right now.',
          );
        }
        const exists = profile.skills.some((s) => s.skillId === suggestion.skillId);
        if (!exists && profile.skills.length >= MAX_PROFILE_SKILLS) {
          throw new HttpError(
            409,
            'profile_skills_full',
            'Your profile already holds the most skills it can.',
          );
        }
        const entry = {
          skillId: suggestion.skillId,
          level: suggestion.toLevel,
          source: 'manual' as const,
        };
        const skills = exists
          ? profile.skills.map((s) => (s.skillId === suggestion.skillId ? entry : s))
          : [...profile.skills, entry];
        await profiles.saveSkills(userId, skills, at);
        await plansRepo.insertEvent(ctx, userId, input.planId, 'level_up.approved', {
          skillId: suggestion.skillId,
          from: suggestion.fromLevel,
          to: suggestion.toLevel,
        });
        return {
          skillId: suggestion.skillId,
          fromLevel: suggestion.fromLevel,
          level: suggestion.toLevel,
          source: 'manual' as const,
        };
      }),
  };
}

export type GoalService = ReturnType<typeof createGoalService>;
