import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGoal } from './goal';
import { suggestLevelUps } from './level-ups';
import { skillProgress, type ProgressTask } from './progress';

const SKILLS = ['sql', 'excel', 'python', 'jira'];
const goal = createGoal({ targetRoleIds: ['r'], skillIds: SKILLS.slice(0, 3) });

const taskArb = fc.record({
  id: fc.uuid(),
  estHours: fc.integer({ min: 0, max: 400 }).map((n) => n / 4),
  frac: fc.double({ min: 0, max: 1.5, noNaN: true }),
  status: fc.constantFrom('pending', 'in_progress', 'done', 'skipped'),
  skillIds: fc.option(fc.subarray(SKILLS), { nil: undefined }),
});

type Row = typeof taskArb extends fc.Arbitrary<infer T> ? T : never;

function toTasks(rows: Row[]): ProgressTask[] {
  return rows.map((r) => ({
    id: r.id,
    estHours: r.estHours,
    doneHours: r.estHours * r.frac,
    status: r.status,
    ...(r.skillIds ? { skillIds: r.skillIds } : {}),
  }));
}

describe('skillProgress properties', () => {
  it('coverage is always in [0, 1], overall and per skill', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 30 }), (rows) => {
        const p = skillProgress({ tasks: toTasks(rows), goal });
        expect(p.coverage).toBeGreaterThanOrEqual(0);
        expect(p.coverage).toBeLessThanOrEqual(1);
        for (const s of p.skills) {
          expect(s.coverage).toBeGreaterThanOrEqual(0);
          expect(s.coverage).toBeLessThanOrEqual(1);
          expect(s.doneHours).toBeLessThanOrEqual(s.plannedHours + 1e-9);
        }
      }),
    );
  });

  it('is deterministic and does not depend on object identity', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 30 }), (rows) => {
        const tasks = toTasks(rows);
        expect(skillProgress({ tasks, goal })).toEqual(
          skillProgress({ tasks: structuredClone(tasks), goal: structuredClone(goal) }),
        );
      }),
    );
  });

  it('conserves hours: per-skill shares add up to the attributed total', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 30 }), (rows) => {
        const tasks = toTasks(rows);
        const p = skillProgress({ tasks, goal });
        const live = tasks
          .filter((t) => t.status !== 'skipped')
          .reduce((s, t) => s + t.estHours, 0);
        expect(p.plannedHours + p.unattributedHours).toBeCloseTo(live, 6);
        // A task that builds several goal skills adds its full hours once to the plan total.
        const perSkill = p.skills.reduce((s, x) => s + x.plannedHours, 0);
        expect(perSkill).toBeCloseTo(p.plannedHours, 6);
      }),
    );
  });

  it('marking one more task done never lowers coverage (overall or per skill)', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { minLength: 1, maxLength: 30 }), fc.nat(), (rows, pick) => {
        const tasks = toTasks(rows);
        const i = pick % tasks.length;
        const after = tasks.map((t, j) =>
          j === i && t.status !== 'skipped' ? { ...t, status: 'done' as const } : t,
        );
        const a = skillProgress({ tasks, goal });
        const b = skillProgress({ tasks: after, goal });
        expect(b.coverage).toBeGreaterThanOrEqual(a.coverage - 1e-9);
        b.skills.forEach((s, k) => {
          expect(s.coverage).toBeGreaterThanOrEqual(a.skills[k]!.coverage - 1e-9);
          expect(s.tasksDone).toBeGreaterThanOrEqual(a.skills[k]!.tasksDone);
        });
      }),
    );
  });

  it('level suggestions are always current + 1, at most 2, only for fully done skills', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 20 }),
        fc.dictionary(fc.constantFrom(...SKILLS), fc.integer({ min: 0, max: 3 })),
        (rows, levels) => {
          const p = skillProgress({ tasks: toTasks(rows), goal, profileLevels: levels });
          for (const s of suggestLevelUps(p, levels)) {
            const sk = p.skills.find((x) => x.skillId === s.skillId)!;
            expect(sk.tasksDone).toBe(sk.tasksTotal);
            expect(sk.tasksTotal).toBeGreaterThan(0);
            expect(s.toLevel).toBe(s.fromLevel + 1);
            expect(s.toLevel).toBeLessThanOrEqual(2);
            expect(s.fromLevel).toBe(levels[s.skillId] ?? 0);
          }
        },
      ),
    );
  });
});
