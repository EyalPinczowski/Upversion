import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import demoPlanJson from '../../../../data/sample-plans/demo-plan.json';
import { parsePlanFile, PlanFileSchema, TaskSchema } from '../schemas';
import { buildPlan } from '../plan-builder/build';
import { BUNDLED_CATALOG } from '../plan-builder/bundled';
import { basicCatalog, build, buildReal, request, TODAY } from '../plan-builder/test-fixtures';
import { COVERAGE_LABEL } from './progress';
import { createGoal } from './goal';
import { skillProgress } from './progress';
import { suggestLevelUps } from './level-ups';

const baseTask = { id: 't', title: 'T', type: 'course', estHours: 2, order: 0 };

describe('plan file back-compat (formatVersion stays 1)', () => {
  it('parses the demo plan, which has no per-task skillIds', () => {
    const plan = parsePlanFile(demoPlanJson);
    expect(plan.formatVersion).toBe(1);
    expect(plan.tasks.every((t) => t.skillIds === undefined)).toBe(true);
  });

  it('parses an old task without skillIds unchanged, and rejects formatVersion 2', () => {
    const t = TaskSchema.parse(baseTask);
    expect('skillIds' in t).toBe(false);
    const file = { ...(demoPlanJson as object), formatVersion: 2 };
    expect(PlanFileSchema.safeParse(file).success).toBe(false);
  });

  it('accepts skillIds on a task and keeps an empty list', () => {
    expect(
      TaskSchema.parse({ ...baseTask, skillIds: ['sql', 'bi-visualization'] }).skillIds,
    ).toEqual(['sql', 'bi-visualization']);
    expect(TaskSchema.parse({ ...baseTask, skillIds: [] }).skillIds).toEqual([]);
  });

  it.each([
    ['uppercase', ['SQL']],
    ['a sentence', ['learn sql fast']],
    ['empty string', ['']],
    ['more than ten', Array.from({ length: 11 }, (_, i) => `s${i}`)],
  ])('rejects task skillIds: %s', (_n, skillIds) => {
    expect(TaskSchema.safeParse({ ...baseTask, skillIds }).success).toBe(false);
  });

  it('does not reject unknown (well-formed) skill ids, like the plan-level skillIds', () => {
    expect(TaskSchema.safeParse({ ...baseTask, skillIds: ['not-in-taxonomy'] }).success).toBe(true);
  });
});

describe('the plan builder emits per-task skillIds', () => {
  it('copies the catalog item skills onto learning, prep and exam tasks', () => {
    const draft = build(basicCatalog(), {});
    const c = draft.plan.tasks.find((t) => t.id === 'c-c-s1');
    expect(c?.skillIds).toEqual(['s1']);
    for (const t of draft.plan.tasks) {
      if (t.externalRef?.startsWith('catalog:') && t.type !== 'admin') {
        expect(t.skillIds?.length ?? 0).toBeGreaterThan(0);
        expect(t.skillIds!.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('writes an empty list on booking tasks and none on admin setup/review tasks', () => {
    const draft = buildReal({ targetRoleIds: ['operations-associate'], certPreference: 'must' });
    for (const t of draft.plan.tasks) {
      if (t.id.startsWith('b-')) expect(t.skillIds).toEqual([]);
      if (t.id.startsWith('a-')) expect(t.skillIds).toBeUndefined();
    }
  });

  it('is still byte-deterministic', () => {
    const a = buildPlan({ today: TODAY, request: request() }, basicCatalog());
    const b = buildPlan({ today: TODAY, request: request() }, basicCatalog());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.draftHash).toBe(b.draftHash);
    const r = request({ targetRoleIds: ['operations-associate'] });
    const x = buildPlan({ today: TODAY, request: r }, BUNDLED_CATALOG);
    const y = buildPlan({ today: TODAY, request: r }, BUNDLED_CATALOG);
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });

  it('gives builder plans skill progress with and without the catalog (same result)', () => {
    const draft = buildReal({ targetRoleIds: ['operations-associate'] });
    const goal = createGoal({
      targetRoleIds: ['operations-associate'],
      skillIds: draft.plan.skillIds ?? [],
    });
    const done = draft.plan.tasks.map((t, i) => (i < 5 ? { ...t, status: 'done' as const } : t));
    const withTaskIds = skillProgress({ tasks: done, goal });
    const stripped = done.map((t) => {
      const copy: typeof t = { ...t };
      delete copy.skillIds;
      return copy;
    });
    const viaCatalog = skillProgress({ tasks: stripped, goal, catalog: BUNDLED_CATALOG });
    expect(withTaskIds.plannedHours).toBeGreaterThan(0);
    expect(withTaskIds.coverage).toBeGreaterThan(0);
    expect(withTaskIds.coverage).toBeLessThan(1);
    // Booking tasks are the only difference: skillIds [] vs catalog fallback.
    expect(Math.abs(viaCatalog.plannedHours - withTaskIds.plannedHours)).toBeLessThan(5);
    expect(suggestLevelUps(withTaskIds, {}).every((s) => s.toLevel <= 2)).toBe(true);
  });
});

describe('wording', () => {
  it('the coverage label is "plan coverage"', () => {
    expect(COVERAGE_LABEL).toBe('plan coverage');
  });

  it('the word "readiness" appears nowhere in the shared package source (tests excluded)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          if (/readiness/i.test(readFileSync(p, 'utf8'))) hits.push(p);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
