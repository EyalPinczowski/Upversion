import { MAX_SUGGESTED_LEVEL } from './goal';
import { own, type PlanProgress, type SkillProgress } from './progress';

/**
 * Level-update suggestions (ADR 018, owner's rule Q3). A suggestion is data only: nothing is
 * written until the user approves it (spec 12.2), and the user may refuse.
 */
export interface LevelSuggestion {
  skillId: string;
  fromLevel: number;
  /** Always `fromLevel + 1`, never above `MAX_SUGGESTED_LEVEL`. */
  toLevel: number;
  /** Why: every task that builds this skill is done. */
  reason: 'all_tasks_done';
  tasksDone: number;
  /** Practice scores as evidence for the user to read; they never trigger a suggestion. */
  practice: SkillProgress['practice'];
}

/**
 * One suggestion per skill whose tasks are all done and whose current level is below the cap.
 * `profileLevels` (the user's own ratings) win over the level progress already used.
 */
export function suggestLevelUps(
  progress: Pick<PlanProgress, 'skills'>,
  profileLevels: Readonly<Record<string, number>> = {},
): LevelSuggestion[] {
  const out: LevelSuggestion[] = [];
  for (const s of progress.skills) {
    if (s.status !== 'done' || s.tasksTotal === 0 || s.tasksDone !== s.tasksTotal) continue;
    const rated = own(profileLevels, s.skillId);
    const current =
      typeof rated === 'number' && Number.isFinite(rated)
        ? Math.max(0, Math.round(rated))
        : s.level;
    if (current >= MAX_SUGGESTED_LEVEL) continue;
    out.push({
      skillId: s.skillId,
      fromLevel: current,
      toLevel: Math.min(MAX_SUGGESTED_LEVEL, current + 1),
      reason: 'all_tasks_done',
      tasksDone: s.tasksDone,
      practice: s.practice,
    });
  }
  return out;
}
