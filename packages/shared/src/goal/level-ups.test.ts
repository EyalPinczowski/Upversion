import { describe, expect, it } from 'vitest';
import { createGoal } from './goal';
import { suggestLevelUps } from './level-ups';
import { skillProgress, type ProgressTask } from './progress';

const goal = createGoal({ targetRoleIds: [], skillIds: ['sql', 'excel'] });
const done = (id: string, skill: string): ProgressTask => ({
  id,
  estHours: 2,
  status: 'done',
  skillIds: [skill],
});
const open = (id: string, skill: string): ProgressTask => ({
  id,
  estHours: 2,
  status: 'pending',
  skillIds: [skill],
});

function suggest(
  tasks: ProgressTask[],
  levels: Record<string, number>,
  practice?: Record<string, number[]>,
) {
  const progress = skillProgress({
    tasks,
    goal,
    profileLevels: levels,
    ...(practice ? { practiceScores: practice } : {}),
  });
  return suggestLevelUps(progress, levels);
}

describe('suggestLevelUps (owner rule, ADR 018 Q3)', () => {
  it.each([
    [0, 1],
    [1, 2],
  ])('level %i with every task done suggests %i', (from, to) => {
    const s = suggest([done('1', 'sql'), done('2', 'sql')], { sql: from });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ skillId: 'sql', fromLevel: from, toLevel: to });
  });

  it.each([2, 3])('never suggests when the skill is already rated %i', (level) => {
    expect(suggest([done('1', 'sql')], { sql: level })).toEqual([]);
  });

  it('never suggests above level 2 and never lower than the current level', () => {
    for (let level = 0; level <= 3; level += 1) {
      for (const s of suggest([done('1', 'sql')], { sql: level })) {
        expect(s.toLevel).toBeLessThanOrEqual(2);
        expect(s.toLevel).toBe(s.fromLevel + 1);
      }
    }
  });

  it('does not suggest while one task that builds the skill is still open', () => {
    expect(suggest([done('1', 'sql'), open('2', 'sql')], { sql: 0 })).toEqual([]);
  });

  it('does not suggest for a skill with no tasks or only skipped tasks', () => {
    expect(suggest([], { sql: 0 })).toEqual([]);
    expect(
      suggest([{ id: '1', estHours: 2, status: 'skipped', skillIds: ['sql'] }], { sql: 0 }),
    ).toEqual([]);
  });

  it('treats a skill missing from the profile as level 0 (or the goal start level)', () => {
    expect(suggest([done('1', 'sql')], {})[0]).toMatchObject({ fromLevel: 0, toLevel: 1 });
    const g = createGoal({ targetRoleIds: [], skillIds: ['sql'], startLevels: { sql: 1 } });
    const p = skillProgress({ tasks: [done('1', 'sql')], goal: g });
    expect(suggestLevelUps(p, {})[0]).toMatchObject({ fromLevel: 1, toLevel: 2 });
    expect(suggestLevelUps(p, { sql: 2 })).toEqual([]);
  });

  it('suggests per skill independently', () => {
    const s = suggest([done('1', 'sql'), open('2', 'excel')], { sql: 0, excel: 0 });
    expect(s.map((x) => x.skillId)).toEqual(['sql']);
  });

  it('practice scores are evidence only: high scores never trigger, low never block', () => {
    expect(suggest([open('1', 'sql')], { sql: 0 }, { sql: [10, 10, 10] })).toEqual([]);
    const s = suggest([done('1', 'sql')], { sql: 0 }, { sql: [1, 2] });
    expect(s).toHaveLength(1);
    expect(s[0]!.practice).toEqual({ average: 1.5, count: 2 });
  });

  it('returns suggestions only and does not change its inputs', () => {
    const levels = { sql: 0 };
    const progress = skillProgress({ tasks: [done('1', 'sql')], goal, profileLevels: levels });
    const before = JSON.stringify({ progress, levels });
    suggestLevelUps(progress, levels);
    expect(JSON.stringify({ progress, levels })).toBe(before);
  });
});
