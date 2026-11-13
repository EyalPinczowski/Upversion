import { describe, expect, it } from 'vitest';
import { compareDates } from '../dates';
import { schedule } from '../scheduling/engine';
import { task as makeTask } from '../scheduling/test-helpers';
import { WeekPatternSchema } from '../schemas';
import { buildPlan, composeFor, createContext } from './build';
import { computeCost } from './cost';
import { MAX_TOTAL_ENGINE_RUNS, fitOptions, fitRoots, runFit } from './fit';
import { resolveRoots } from './resolve';
import { ExclusionLog, selectCourses } from './select';
import { BuildRequestError } from './validate';
import {
  TODAY,
  build,
  catalogOf,
  item,
  itemIds,
  request,
  role,
  task,
  basicCatalog,
} from './test-fixtures';

const codes = (fn: () => unknown): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof BuildRequestError) return e.issues.map((i) => i.code);
    throw e;
  }
};

const exam = (id: string, hours = 1) =>
  item({
    id,
    type: 'cert_exam',
    skills: ['s1'],
    est_hours: hours,
    certificate_type: 'skills_test',
  });

describe('SF1: overlapping exam dates', () => {
  const catalog = () =>
    catalogOf(
      [exam('ex1'), exam('ex2', 1.5)],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
  const dated = (a: string, b: string) =>
    request({
      certificateOptIns: ['ex1', 'ex2'],
      deadline: '2026-12-01',
      examDates: [
        { catalogId: 'ex1', date: '2026-11-10', start: a },
        { catalogId: 'ex2', date: '2026-11-10', start: b },
      ],
    });

  it('rejects two exams at the same time, or one starting inside the other', () => {
    for (const [a, b] of [
      ['10:00', '10:00'],
      ['10:00', '10:30'],
      ['10:30', '10:00'],
    ] as const) {
      expect(
        codes(() => buildPlan({ today: TODAY, request: dated(a, b) }, catalog())),
        `${a} ${b}`,
      ).toEqual(['exam_dates_overlap']);
    }
  });

  it('accepts back-to-back exams and the same time on another day', () => {
    expect(
      codes(() => buildPlan({ today: TODAY, request: dated('10:00', '11:00') }, catalog())),
    ).toEqual([]);
    const other = request({
      certificateOptIns: ['ex1', 'ex2'],
      deadline: '2026-12-01',
      examDates: [
        { catalogId: 'ex1', date: '2026-11-10', start: '10:00' },
        { catalogId: 'ex2', date: '2026-11-11', start: '10:00' },
      ],
    });
    expect(codes(() => buildPlan({ today: TODAY, request: other }, catalog()))).toEqual([]);
  });

  it('runFit treats fixed_overlap as not fitting, even if validation was bypassed', () => {
    const draft = buildPlan({ today: TODAY, request: dated('10:00', '11:00') }, catalog());
    const ctx = createContext({ today: TODAY, request: dated('10:00', '11:00') }, catalog());
    const tasks = draft.plan.tasks.map((t) =>
      t.id === 'x-ex2' ? { ...t, anchorStartTime: '10:00' } : t,
    );
    const run = runFit(ctx, tasks);
    expect(run.warnings.map((w) => w.kind)).toContain('fixed_overlap');
    expect(run.fits).toBe(false);
  });
});

describe('SF2: a core item is never trimmed through an optional-marked prerequisite', () => {
  it('keeps both items and reports that the plan does not fit', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'a-top',
          skills: ['s1'],
          est_hours: 100,
          prerequisites: ['z-base'],
          prerequisite_kinds: { 'z-base': 'required' },
        }),
        item({ id: 'z-base', skills: ['s9'], est_hours: 10 }),
      ],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['a-top'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog, { priorityOverrides: { 'z-base': 'optional' } });
    expect(itemIds(draft).sort()).toEqual(['a-top', 'z-base']);
    expect(draft.items.find((i) => i.catalogId === 'a-top')?.tier).toBe('core');
    expect(draft.fits).toBe(false);
    expect(draft.excluded.filter((e) => e.reason === 'dropped_to_fit_time')).toEqual([]);
  });

  it('still trims an optional item whose dependents are all optional', () => {
    const catalog = catalogOf(
      [
        item({ id: 'core-1', skills: ['s1'], est_hours: 6 }),
        item({
          id: 'opt-top',
          skills: ['s2'],
          est_hours: 100,
          prerequisites: ['opt-base'],
          prerequisite_kinds: { 'opt-base': 'required' },
        }),
        item({ id: 'opt-base', skills: ['s9'], est_hours: 5 }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
          ],
          suggested_path: { core: ['core-1'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog);
    expect(draft.fits).toBe(true);
    expect(itemIds(draft)).toEqual(['core-1']);
  });
});

describe('SF3: cost of a plan that does not fit', () => {
  const sub = (id: string, skill: string) =>
    item({
      id,
      skills: [skill],
      est_hours: 150,
      cost_type: 'subscription',
      price: 59,
      subscription_period: 'month',
      subscription_group: 'plus',
    });
  const catalog = () =>
    catalogOf(
      [sub('s-one', 's1')],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['s-one'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );

  it('flags the cost as possibly higher and warns when the plan does not fit', () => {
    const draft = build(catalog());
    expect(draft.fits).toBe(false);
    expect(draft.summary.cost.mayBeHigher).toBe(true);
    expect(draft.warnings.map((w) => w.code)).toContain('cost_may_be_higher');
  });

  it('does not flag it when the plan fits', () => {
    const draft = build(basicCatalog());
    expect(draft.fits).toBe(true);
    expect(draft.summary.cost.mayBeHigher).toBe(false);
    expect(draft.warnings.map((w) => w.code)).not.toContain('cost_may_be_higher');
  });
});

describe('mutation gaps', () => {
  it('runFit stops at the horizon cap when tasks can never be placed', () => {
    const ctx = createContext({ today: TODAY, request: request() }, basicCatalog());
    ctx.request = { ...ctx.request, deadline: '9999-12-31' };
    // Not before the year 9999: the engine would walk day by day to the end of its horizon.
    const stuck = makeTask({ id: 'stuck', estHours: 1, notBefore: '9999-12-31' });
    const start = performance.now();
    const run = runFit(ctx, [stuck]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(run.fits).toBe(false);
  });

  const bigCatalog = () =>
    catalogOf(
      [
        item({ id: 'small', skills: ['s1'], est_hours: 6 }),
        item({ id: 'big', skills: ['s2'], est_hours: 120 }),
        exam('ex'),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
            { skill: 's3', weight: 1 },
          ],
          suggested_path: { core: ['small', 'big'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
  const withExamSkill = () => {
    const c = bigCatalog();
    c.items = c.items.map((i) => (i.id === 'ex' ? { ...i, skills: ['s3'] } : i));
    return c;
  };

  it('never offers an opted-in exam or an exam with a date in the essentials', () => {
    for (const extra of [
      { certificateOptIns: ['ex'] },
      { examDates: [{ catalogId: 'ex', date: '2026-11-10', start: '10:00' }] },
    ]) {
      const draft = build(withExamSkill(), extra);
      expect(draft.fits).toBe(false);
      expect(itemIds(draft)).toContain('ex');
      expect(draft.options?.essentials.droppedItemIds).not.toContain('ex');
      expect(draft.options?.essentials.droppedItemIds).toEqual(['big']);
    }
  });

  it('the essentials loop stops once the engine runs are used up', () => {
    const ctx = createContext({ today: TODAY, request: request() }, bigCatalog());
    const roots = selectCourses(ctx, new ExclusionLog());
    const compose = composeFor(ctx);
    const outcome = fitRoots(ctx, compose, roots);
    expect(outcome.run.fits).toBe(false);
    expect(fitOptions(ctx, compose, outcome).essentials.possible).toBe(true);
    ctx.engineRuns = MAX_TOTAL_ENGINE_RUNS;
    const options = fitOptions(ctx, compose, outcome);
    expect(options.essentials).toEqual({ possible: false, droppedItemIds: [], lostSkillIds: [] });
  });

  it('skills lost in the re-fit are lost to time, not to the budget', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a-paid', skills: ['s1'], cost_type: 'one_time', price: 60, est_hours: 5 }),
        item({
          id: 'b-paid',
          skills: ['s2'],
          cost_type: 'one_time',
          price: 60,
          est_hours: 5,
          free_alternative_ids: ['z-free'],
        }),
        item({ id: 'z-free', skills: ['s2'], est_hours: 45 }),
        item({ id: 'opt', skills: ['s3'], est_hours: 15 }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
            { skill: 's3', weight: 2 },
          ],
          suggested_path: { core: ['a-paid', 'b-paid'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog, { budget: { mode: 'limit', amount: 100 } });
    expect(itemIds(draft).sort()).toEqual(['a-paid', 'z-free']);
    expect(draft.summary.skillsNotCovered).toEqual([
      { skillId: 's3', name: 'Skill s3', reason: 'dropped_to_fit_time' },
    ]);
  });

  it('the hours-a-day option clears per-weekday overrides (otherwise nothing could fit)', () => {
    const catalog = catalogOf(
      [item({ id: 'huge', skills: ['s1'], est_hours: 60 })],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['huge'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const weekPattern = {
      ...request().weekPattern,
      hoursByWeekday: { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1 },
    };
    const draft = build(catalog, { weekPattern });
    expect(draft.fits).toBe(false);
    const value = draft.options?.hoursPerDay.value;
    expect(value).not.toBeNull();
    const finish = schedule({
      tasks: draft.plan.tasks,
      pattern: WeekPatternSchema.parse({
        ...draft.plan.weekPattern,
        defaultHours: value,
        hoursByWeekday: {},
      }),
      today: draft.summary.scheduleFrom,
    }).finishDate as string;
    expect(compareDates(finish, draft.summary.deadline)).toBeLessThanOrEqual(0);
  });

  it('a subscription group that is not scheduled is counted as one month and listed', () => {
    const grp = (id: string) =>
      item({
        id,
        skills: ['s1'],
        cost_type: 'subscription',
        price: 59,
        subscription_period: 'month',
        subscription_group: 'plus',
      });
    const catalog = catalogOf(
      [grp('g1'), grp('g2')],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const ctx = createContext({ today: TODAY, request: request() }, catalog);
    const members = resolveRoots(
      ctx,
      ['g1', 'g2'].map((id) => ({
        id,
        tier: 'core' as const,
        origin: 'gap' as const,
        paidCertificate: false,
      })),
    ).members;
    const report = computeCost(members, () => null);
    expect(report.assumedOneMonth).toEqual(['plus']);
    expect(report.subscriptionMonths).toEqual({ plus: 1 });
    expect(report.total).toBe(59);
    expect(task).toBeDefined();
  });
});
