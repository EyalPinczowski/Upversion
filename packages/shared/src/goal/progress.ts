import { MAX_SKILL_LEVEL, type Goal } from './goal';

/**
 * Plan coverage per skill (ADR 018). Pure and deterministic: no I/O, no clock. The number is the
 * share of this plan's planned work for the goal that is done; it is not a measure of ability.
 */

/** The label of the coverage number everywhere in the app. */
export const COVERAGE_LABEL = 'plan coverage';

/** The task fields progress reads (a `Task` of the plan file fits). */
export interface ProgressTask {
  id: string;
  estHours: number;
  doneHours?: number;
  status?: 'pending' | 'in_progress' | 'done' | 'skipped';
  skillIds?: readonly string[];
  /** `catalog:<id>` for tasks the plan builder wrote. */
  externalRef?: string;
}

/** The slim catalog view: item ids with their skill ids. A `BuildCatalog` fits. */
export interface ProgressCatalog {
  items: readonly { id: string; skills: readonly string[] }[];
}

/** Practice scores (0..10) per skill. Evidence only: they never change a level by themselves. */
export type PracticeScores = Readonly<Record<string, readonly number[]>>;

export type SkillStatus = 'not_started' | 'in_progress' | 'done';

export interface SkillProgress {
  skillId: string;
  /** Hours planned for this skill (an even share of each task that builds it). */
  plannedHours: number;
  /** Hours done for this skill (done tasks count in full, others by logged hours, capped). */
  doneHours: number;
  /** done / planned hours, 0..1; 0 when nothing is planned for the skill. */
  coverage: number;
  tasksDone: number;
  tasksTotal: number;
  status: SkillStatus;
  /** The level now: the profile level, else the goal's start level, else 0. */
  level: number;
  /** Practice evidence: average of valid scores and how many; null when there are none. */
  practice: { average: number; count: number } | null;
}

export interface PlanProgress {
  label: typeof COVERAGE_LABEL;
  skills: SkillProgress[];
  /** done / planned hours over goal-linked tasks, 0..1. */
  coverage: number;
  plannedHours: number;
  doneHours: number;
  /** Planned hours of tasks that build none of the goal's skills (shown, never hidden). */
  unattributedHours: number;
  unattributedTasks: number;
}

export interface SkillProgressInput {
  tasks: readonly ProgressTask[];
  goal: Goal;
  /** Levels from the user's profile (skill id to 0..3); they win over `goal.startLevels`. */
  profileLevels?: Readonly<Record<string, number>>;
  /** Needed for tasks without `skillIds` (the catalog item named by `externalRef` is used). */
  catalog?: ProgressCatalog;
  practiceScores?: PracticeScores;
}

const REF_PREFIX = 'catalog:';

function clampLevel(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(MAX_SKILL_LEVEL, Math.max(0, Math.round(v)));
}

/** The skills a task builds: its own `skillIds`, else its catalog item's, else none. */
export function taskSkills(
  task: Pick<ProgressTask, 'skillIds' | 'externalRef'>,
  itemSkills: ReadonlyMap<string, readonly string[]> | undefined,
): string[] {
  const own =
    task.skillIds ??
    (task.externalRef?.startsWith(REF_PREFIX)
      ? itemSkills?.get(task.externalRef.slice(REF_PREFIX.length))
      : undefined) ??
    [];
  return [...new Set(own)];
}

function practiceOf(scores: readonly number[] | undefined): SkillProgress['practice'] {
  const valid = (scores ?? []).filter((n) => Number.isFinite(n) && n >= 0 && n <= 10);
  if (valid.length === 0) return null;
  return { average: valid.reduce((a, b) => a + b, 0) / valid.length, count: valid.length };
}

/** Per-skill plan coverage for the goal's skills. Skipped tasks are left out of every number. */
export function skillProgress(input: SkillProgressInput): PlanProgress {
  const { goal, tasks } = input;
  const itemSkills = input.catalog
    ? new Map(input.catalog.items.map((i) => [i.id, i.skills]))
    : undefined;
  const skillIds = [...new Set(goal.skillIds)];
  const acc = new Map(
    skillIds.map((id) => [
      id,
      { planned: 0, done: 0, tasksDone: 0, tasksTotal: 0, touched: false },
    ]),
  );
  let planned = 0;
  let done = 0;
  let unattributedHours = 0;
  let unattributedTasks = 0;

  for (const task of tasks) {
    if (task.status === 'skipped') continue;
    const hours = Math.max(0, task.estHours);
    const taskDone =
      task.status === 'done' ? hours : Math.min(hours, Math.max(0, task.doneHours ?? 0));
    const mine = taskSkills(task, itemSkills).filter((id) => acc.has(id));
    if (mine.length === 0) {
      unattributedHours += hours;
      unattributedTasks += 1;
      continue;
    }
    planned += hours;
    done += taskDone;
    for (const id of mine) {
      const a = acc.get(id)!;
      a.planned += hours / mine.length;
      a.done += taskDone / mine.length;
      a.tasksTotal += 1;
      if (task.status === 'done') a.tasksDone += 1;
      if (taskDone > 0 || task.status === 'in_progress') a.touched = true;
    }
  }

  const ratio = (d: number, p: number) => (p > 0 ? Math.min(1, Math.max(0, d / p)) : 0);
  const skills: SkillProgress[] = skillIds.map((id) => {
    const a = acc.get(id)!;
    const status: SkillStatus =
      a.tasksTotal > 0 && a.tasksDone === a.tasksTotal
        ? 'done'
        : a.touched
          ? 'in_progress'
          : 'not_started';
    return {
      skillId: id,
      plannedHours: a.planned,
      doneHours: a.done,
      coverage: ratio(a.done, a.planned),
      tasksDone: a.tasksDone,
      tasksTotal: a.tasksTotal,
      status,
      level: clampLevel(input.profileLevels?.[id]) ?? clampLevel(goal.startLevels[id]) ?? 0,
      practice: practiceOf(input.practiceScores?.[id]),
    };
  });
  return {
    label: COVERAGE_LABEL,
    skills,
    coverage: ratio(done, planned),
    plannedHours: planned,
    doneHours: done,
    unattributedHours,
    unattributedTasks,
  };
}
