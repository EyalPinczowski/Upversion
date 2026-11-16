import { describe, expect, it } from 'vitest';
import demoPlanJson from '../../../../data/sample-plans/demo-plan.json';
import { parsePlanFile } from '../schemas';
import {
  createGoal,
  deriveGoal,
  GoalSchema,
  MAX_GOAL_ROLES,
  MAX_GOAL_SKILLS,
  PLAN_SUMMARY_GOAL_KEY,
  withGoal,
} from './goal';

describe('GoalSchema', () => {
  it('accepts ids and numbers only', () => {
    const goal = GoalSchema.parse({
      targetRoleIds: ['operations-associate'],
      skillIds: ['excel', 'bi-visualization'],
      startLevels: { excel: 2, 'bi-visualization': 0 },
      deadline: '2027-02-14',
      createdFrom: 'builder',
    });
    expect(goal.skillIds).toHaveLength(2);
  });

  it('defaults startLevels and rejects unknown keys (no free text)', () => {
    expect(GoalSchema.parse({ targetRoleIds: [], skillIds: ['sql'] }).startLevels).toEqual({});
    expect(
      GoalSchema.safeParse({ targetRoleIds: [], skillIds: ['sql'], goalText: 'be a PM' }).success,
    ).toBe(false);
  });

  it.each([
    ['three roles', { targetRoleIds: ['a', 'b', 'c'], skillIds: [] }],
    ['uppercase skill id', { targetRoleIds: [], skillIds: ['SQL'] }],
    ['a sentence as a skill id', { targetRoleIds: [], skillIds: ['I want to learn sql'] }],
    ['level 4', { targetRoleIds: [], skillIds: ['sql'], startLevels: { sql: 4 } }],
    ['fractional level', { targetRoleIds: [], skillIds: ['sql'], startLevels: { sql: 1.5 } }],
    [
      'targetLevels (dropped from the goal)',
      { targetRoleIds: [], skillIds: ['sql'], targetLevels: { sql: 2 } },
    ],
    [
      'start level for a skill not in the goal',
      { targetRoleIds: [], skillIds: ['sql'], startLevels: { excel: 1 } },
    ],
    ['bad deadline', { targetRoleIds: [], skillIds: ['sql'], deadline: 'next spring' }],
    ['unknown origin', { targetRoleIds: [], skillIds: ['sql'], createdFrom: 'cv' }],
  ])('rejects %s', (_name, value) => {
    expect(GoalSchema.safeParse(value).success).toBe(false);
  });

  it('caps the number of start levels', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_GOAL_SKILLS + 1 }, (_, i) => [`s${i}`, 1]),
    );
    expect(
      GoalSchema.safeParse({ targetRoleIds: [], skillIds: ['s0'], startLevels: many }).success,
    ).toBe(false);
  });

  it('caps the lists', () => {
    expect(MAX_GOAL_ROLES).toBe(2);
    const many = Array.from({ length: MAX_GOAL_SKILLS + 1 }, (_, i) => `s${i}`);
    expect(GoalSchema.safeParse({ targetRoleIds: [], skillIds: many }).success).toBe(false);
  });
});

describe('createGoal', () => {
  it('drops duplicates, malformed ids and levels of skills outside the goal', () => {
    const goal = createGoal({
      targetRoleIds: ['a', 'a', 'b', 'c', 'Bad Id'],
      skillIds: ['sql', 'sql', 'excel', 'NOPE', 3 as unknown as string],
      startLevels: { sql: 1, other: 2, excel: 9 },
      deadline: '2027-01-31',
      createdFrom: 'import',
    });
    expect(goal).toEqual({
      targetRoleIds: ['a', 'b'],
      skillIds: ['sql', 'excel'],
      startLevels: { sql: 1, excel: 3 },
      deadline: '2027-01-31',
      createdFrom: 'import',
    });
  });

  it('omits optional keys that were not given', () => {
    expect(createGoal({ targetRoleIds: ['a'], skillIds: ['sql'] })).toEqual({
      targetRoleIds: ['a'],
      skillIds: ['sql'],
      startLevels: {},
    });
  });

  it('throws on an invalid deadline', () => {
    expect(() => createGoal({ targetRoleIds: [], skillIds: ['sql'], deadline: 'soon' })).toThrow();
  });
});

describe('createGoal prototype keys', () => {
  it('ignores inherited keys such as constructor', () => {
    const g = createGoal({
      targetRoleIds: [],
      skillIds: ['constructor', 'sql'],
      startLevels: { sql: 1 },
    });
    expect(g.startLevels).toEqual({ sql: 1 });
  });
});

describe('withGoal and deriveGoal', () => {
  const goal = createGoal({ targetRoleIds: ['r1'], skillIds: ['sql'], startLevels: { sql: 1 } });

  it('stores the goal under summary.goal without touching the input', () => {
    const summary = { hours: 10, certs: 1 };
    const out = withGoal(summary, goal);
    expect(out[PLAN_SUMMARY_GOAL_KEY]).toEqual(goal);
    expect(out.hours).toBe(10);
    expect(summary).toEqual({ hours: 10, certs: 1 });
    expect(deriveGoal(out)).toEqual(goal);
  });

  it('prefers summary.goal over the older keys', () => {
    expect(deriveGoal({ goal, skillIds: ['python'], targetRoleIds: ['x'] })).toEqual(goal);
  });

  it('falls back to targetRoleIds and skillIds of a builder summary', () => {
    expect(
      deriveGoal({ targetRoleIds: ['r1', 'r2'], skillIds: ['sql', 'sql', 'excel'], hours: 5 }),
    ).toEqual({ targetRoleIds: ['r1', 'r2'], skillIds: ['sql', 'excel'], startLevels: {} });
  });

  it('falls back when summary.goal is invalid', () => {
    expect(deriveGoal({ goal: { skillIds: 'sql' }, skillIds: ['sql'] })).toEqual({
      targetRoleIds: [],
      skillIds: ['sql'],
      startLevels: {},
    });
  });

  it('uses the plan-level skill ids when the summary has none', () => {
    expect(deriveGoal({ hours: 3 }, ['excel'])?.skillIds).toEqual(['excel']);
    expect(deriveGoal(null, ['excel'])?.skillIds).toEqual(['excel']);
  });

  it('returns null for a plan without a goal', () => {
    expect(deriveGoal({ hours: 3 })).toBeNull();
    expect(deriveGoal(null)).toBeNull();
    expect(deriveGoal(undefined)).toBeNull();
    expect(deriveGoal([])).toBeNull();
    expect(deriveGoal({ skillIds: 'sql', targetRoleIds: 5 })).toBeNull();
  });

  it('ignores malformed ids in old summaries', () => {
    expect(deriveGoal({ skillIds: ['sql', 42, 'BAD ID', null] })?.skillIds).toEqual(['sql']);
  });

  it('works for the imported demo plan (plan-level skillIds in the summary)', () => {
    const plan = parsePlanFile(demoPlanJson);
    const goal = deriveGoal({ skillIds: plan.skillIds, hours: 1, certs: 0 });
    expect(goal?.skillIds).toEqual(plan.skillIds);
    expect(goal?.targetRoleIds).toEqual([]);
  });
});
