import { describe, expect, it } from 'vitest';
import demoPlanJson from '../../../../data/sample-plans/demo-plan.json';
import { parsePlanFile } from '../schemas';
import { createGoal } from './goal';
import { COVERAGE_LABEL, skillProgress, taskSkills, type ProgressTask } from './progress';

const goal = createGoal({
  targetRoleIds: ['r1'],
  skillIds: ['sql', 'excel'],
  startLevels: { sql: 0, excel: 1 },
});
const catalog = {
  items: [
    { id: 'a', skills: ['sql', 'excel'] },
    { id: 'b', skills: ['sql'] },
    { id: 'c', skills: ['python'] },
  ],
};

function t(id: string, estHours: number, extra: Partial<ProgressTask> = {}): ProgressTask {
  return { id, estHours, status: 'pending', doneHours: 0, ...extra };
}

describe('skillProgress', () => {
  it('uses the plan coverage label, never "readiness"', () => {
    expect(COVERAGE_LABEL).toBe('plan coverage');
    expect(skillProgress({ tasks: [], goal }).label).toBe('plan coverage');
  });

  it('returns zeros for a plan with no tasks', () => {
    const p = skillProgress({ tasks: [], goal });
    expect(p.coverage).toBe(0);
    expect(p.plannedHours).toBe(0);
    expect(p.unattributedHours).toBe(0);
    expect(p.skills.map((s) => [s.skillId, s.status, s.coverage, s.tasksTotal])).toEqual([
      ['sql', 'not_started', 0, 0],
      ['excel', 'not_started', 0, 0],
    ]);
  });

  it('splits an item hours evenly across its skills (catalog lookup by externalRef)', () => {
    const p = skillProgress({
      tasks: [
        t('t1', 6, { externalRef: 'catalog:a', status: 'done' }),
        t('t2', 4, { externalRef: 'catalog:b' }),
      ],
      goal,
      catalog,
    });
    const sql = p.skills[0]!;
    const excel = p.skills[1]!;
    expect(sql.plannedHours).toBe(7);
    expect(sql.doneHours).toBe(3);
    expect(sql.coverage).toBeCloseTo(3 / 7);
    expect(sql.status).toBe('in_progress');
    expect(excel.plannedHours).toBe(3);
    expect(excel.coverage).toBe(1);
    expect(excel.status).toBe('done');
    expect(p.plannedHours).toBe(10);
    expect(p.doneHours).toBe(6);
    expect(p.coverage).toBeCloseTo(0.6);
  });

  it('prefers task.skillIds over the catalog, and an empty list means no skill', () => {
    const p = skillProgress({
      tasks: [
        t('t1', 4, { externalRef: 'catalog:a', skillIds: ['sql'], status: 'done' }),
        t('t2', 2, { externalRef: 'catalog:a', skillIds: [] }),
      ],
      goal,
      catalog,
    });
    expect(p.skills[0]!.plannedHours).toBe(4);
    expect(p.skills[1]!.plannedHours).toBe(0);
    expect(p.unattributedHours).toBe(2);
    expect(p.unattributedTasks).toBe(1);
  });

  it('works without a catalog when tasks carry skillIds', () => {
    const p = skillProgress({ tasks: [t('t1', 2, { skillIds: ['excel'], status: 'done' })], goal });
    expect(p.skills[1]!.coverage).toBe(1);
  });

  it('reports tasks with no skill source, an unknown ref or only off-goal skills as unattributed', () => {
    const p = skillProgress({
      tasks: [
        t('admin', 0.5),
        t('ref-unknown', 1, { externalRef: 'catalog:zzz' }),
        t('no-catalog-ref', 1, { externalRef: 'other:thing' }),
        t('off-goal', 3, { externalRef: 'catalog:c' }),
        t('on-goal', 2, { skillIds: ['sql'] }),
      ],
      goal,
      catalog,
    });
    expect(p.unattributedHours).toBe(5.5);
    expect(p.unattributedTasks).toBe(4);
    expect(p.plannedHours).toBe(2);
  });

  it('conserves hours: attributed + unattributed equals all non-skipped planned hours', () => {
    const tasks = [
      t('1', 3, { externalRef: 'catalog:a' }),
      t('2', 2.5, { externalRef: 'catalog:c' }),
      t('3', 1, {}),
      t('4', 9, { status: 'skipped', skillIds: ['sql'] }),
    ];
    const p = skillProgress({ tasks, goal, catalog });
    const bySkill = p.skills.reduce((s, x) => s + x.plannedHours, 0);
    expect(bySkill).toBeCloseTo(p.plannedHours);
    expect(p.plannedHours + p.unattributedHours).toBeCloseTo(6.5);
  });

  it('counts partial hours, capped at the estimate, and a done task in full', () => {
    const p = skillProgress({
      tasks: [
        t('1', 4, { skillIds: ['sql'], doneHours: 10, status: 'in_progress' }),
        t('2', 4, { skillIds: ['sql'], doneHours: 0, status: 'done' }),
        t('3', 4, { skillIds: ['sql'], doneHours: 1 }),
      ],
      goal,
    });
    const sql = p.skills[0]!;
    expect(sql.doneHours).toBe(9);
    expect(sql.tasksDone).toBe(1);
    expect(sql.tasksTotal).toBe(3);
    expect(sql.status).toBe('in_progress');
  });

  it('leaves skipped tasks out of the hours', () => {
    const p = skillProgress({
      tasks: [
        t('1', 4, { skillIds: ['sql'], status: 'done' }),
        t('2', 4, { skillIds: ['sql'], status: 'skipped' }),
      ],
      goal,
    });
    expect(p.skills[0]!.status).toBe('in_progress');
    expect(p.skills[0]!.plannedHours).toBe(4);
    expect(p.unattributedHours).toBe(0);
  });

  it('is not_started when a task has logged hours of zero and status pending, in_progress when started', () => {
    expect(
      skillProgress({ tasks: [t('1', 2, { skillIds: ['sql'] })], goal }).skills[0]!.status,
    ).toBe('not_started');
    expect(
      skillProgress({ tasks: [t('1', 2, { skillIds: ['sql'], status: 'in_progress' })], goal })
        .skills[0]!.status,
    ).toBe('in_progress');
  });

  it('handles zero-hour tasks without dividing by zero', () => {
    const p = skillProgress({ tasks: [t('1', 0, { skillIds: ['sql'], status: 'done' })], goal });
    expect(p.skills[0]!.coverage).toBe(0);
    expect(p.skills[0]!.status).toBe('done');
    expect(p.coverage).toBe(0);
  });

  it('ignores duplicate skill ids in the goal and in a task', () => {
    const dup = { ...goal, skillIds: ['sql', 'sql', 'excel'] };
    const p = skillProgress({
      tasks: [t('1', 4, { skillIds: ['sql', 'sql'], status: 'done' })],
      goal: dup,
    });
    expect(p.skills.map((s) => s.skillId)).toEqual(['sql', 'excel']);
    expect(p.skills[0]!.plannedHours).toBe(4);
    expect(p.skills[0]!.tasksTotal).toBe(1);
  });

  it('level: profile beats goal start level, which beats 0; values are clamped', () => {
    const p = skillProgress({
      tasks: [],
      goal,
      profileLevels: { sql: 2, excel: Number.NaN },
    });
    expect(p.skills.map((s) => s.level)).toEqual([2, 1]);
    expect(skillProgress({ tasks: [], goal, profileLevels: { sql: 99 } }).skills[0]!.level).toBe(3);
    expect(skillProgress({ tasks: [], goal: { ...goal, startLevels: {} } }).skills[0]!.level).toBe(
      0,
    );
  });

  it('keeps practice scores as evidence only and ignores invalid ones', () => {
    const p = skillProgress({
      tasks: [],
      goal,
      practiceScores: { sql: [8, 7, -1, 11, Number.NaN], excel: [] },
    });
    expect(p.skills[0]!.practice).toEqual({ average: 7.5, count: 2 });
    expect(p.skills[1]!.practice).toBeNull();
    expect(p.skills[0]!.status).toBe('not_started');
    expect(p.coverage).toBe(0);
  });

  it('does not change its input and is deterministic', () => {
    const tasks = [t('1', 3, { externalRef: 'catalog:a', doneHours: 1 })];
    const before = JSON.stringify({ tasks, goal });
    const a = skillProgress({ tasks, goal, catalog });
    const b = skillProgress({ tasks, goal, catalog });
    expect(a).toEqual(b);
    expect(JSON.stringify({ tasks, goal })).toBe(before);
  });

  it('gives sensible output for the imported demo plan with only plan-level skills (no per-task skills)', () => {
    const plan = parsePlanFile(demoPlanJson);
    const demoGoal = createGoal({ targetRoleIds: [], skillIds: plan.skillIds ?? [] });
    const p = skillProgress({ tasks: plan.tasks, goal: demoGoal });
    expect(p.coverage).toBe(0);
    expect(p.plannedHours).toBe(0);
    expect(p.unattributedTasks).toBe(plan.tasks.length);
    expect(p.unattributedHours).toBeCloseTo(plan.tasks.reduce((s, x) => s + x.estHours, 0));
    expect(p.skills).toHaveLength(6);
    // Same plan with its tasks marked done: still nothing is attributed, and nothing is invented.
    const done = plan.tasks.map((x) => ({ ...x, status: 'done' as const }));
    expect(skillProgress({ tasks: done, goal: demoGoal }).coverage).toBe(0);
  });
});

describe('taskSkills', () => {
  const map = new Map([['a', ['sql', 'excel', 'sql']]]);
  it('reads skillIds, then the catalog item, then nothing', () => {
    expect(taskSkills({ skillIds: ['x', 'x'] }, map)).toEqual(['x']);
    expect(taskSkills({ externalRef: 'catalog:a' }, map)).toEqual(['sql', 'excel']);
    expect(taskSkills({ externalRef: 'catalog:a' }, undefined)).toEqual([]);
    expect(taskSkills({}, map)).toEqual([]);
  });
});

describe('review fixes', () => {
  it('a skipped task still counts in tasksTotal but adds no hours', () => {
    const p = skillProgress({
      tasks: [
        t('1', 4, { skillIds: ['sql'], status: 'done' }),
        t('2', 4, { skillIds: ['sql'], status: 'skipped' }),
      ],
      goal,
    });
    const sql = p.skills[0]!;
    expect(sql.tasksTotal).toBe(2);
    expect(sql.tasksDone).toBe(1);
    expect(sql.status).not.toBe('done');
    expect(sql.plannedHours).toBe(4);
    expect(p.plannedHours).toBe(4);
    expect(p.unattributedHours).toBe(0);
    expect(p.unattributedTasks).toBe(0);
  });

  it('treats non-finite hours as 0 so coverage stays in 0..1', () => {
    const p = skillProgress({
      tasks: [
        t('1', Number.NaN, { skillIds: ['sql'], doneHours: Number.POSITIVE_INFINITY }),
        t('2', Number.POSITIVE_INFINITY, { skillIds: ['sql'], doneHours: Number.NaN }),
        t('3', 2, { skillIds: ['sql'], doneHours: Number.NaN, status: 'in_progress' }),
        t('4', Number.NaN, { skillIds: ['sql'], status: 'done' }),
      ],
      goal,
    });
    expect(Number.isFinite(p.coverage)).toBe(true);
    expect(p.coverage).toBeGreaterThanOrEqual(0);
    expect(p.coverage).toBeLessThanOrEqual(1);
    expect(p.plannedHours).toBe(2);
  });

  it('does not throw for skill ids that are Object.prototype keys', () => {
    const g = { ...goal, skillIds: ['constructor', '__proto__', 'toString'] };
    const p = skillProgress({
      tasks: [t('1', 1, { skillIds: ['constructor'], status: 'done' })],
      goal: g,
      profileLevels: {},
      practiceScores: {},
    });
    expect(p.skills.map((s) => s.practice)).toEqual([null, null, null]);
    expect(p.skills.map((s) => s.level)).toEqual([0, 0, 0]);
    expect(p.skills[0]!.status).toBe('done');
  });
});
