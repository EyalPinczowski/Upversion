import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../dates';
import { schedule } from '../scheduling/engine';
import { WeekPatternSchema } from '../schemas';
import { buildPlan, composeFor, createContext } from './build';
import { BUNDLED_CATALOG } from './bundled';
import { computeCost } from './cost';
import { MAX_TOTAL_ENGINE_RUNS, fitOptions, fitRoots, runFit } from './fit';
import { resolveRoots } from './resolve';
import { ExclusionLog, selectCertificates, selectCourses, selectPractice } from './select';
import { BuildRequestError, MAX_DEADLINE_DAYS } from './validate';
import { TODAY, build, catalogOf, item, itemIds, request, role, task } from './test-fixtures';

const codes = (fn: () => unknown): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof BuildRequestError) return e.issues.map((i) => i.code);
    throw e;
  }
};

const heavyRequest = (deadline: string, roles = ['qa-tester', 'soc-analyst']) =>
  request({
    targetRoleIds: roles,
    deadline,
    certPreference: 'must',
    interviewPrep: 'yes',
    budget: { mode: 'flexible' },
  });

describe('B1: far deadlines', () => {
  it('rejects a deadline more than 730 days after the start, quickly, whatever the year', () => {
    for (const deadline of ['2099-01-01', '2299-12-31', '9999-12-31', '2028-11-03']) {
      const start = performance.now();
      expect(
        codes(() => buildPlan({ today: TODAY, request: heavyRequest(deadline) }, BUNDLED_CATALOG)),
        deadline,
      ).toContain('deadline_too_far');
      expect(performance.now() - start).toBeLessThan(200);
    }
  });

  it('accepts exactly 730 days and builds a big two-role plan within a time bound', () => {
    expect(MAX_DEADLINE_DAYS).toBe(730);
    const deadline = addDays('2026-11-03', 730);
    const start = performance.now();
    const draft = buildPlan({ today: TODAY, request: heavyRequest(deadline) }, BUNDLED_CATALOG);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(draft.summary.deadline).toBe(deadline);
    expect(
      codes(() =>
        buildPlan({ today: TODAY, request: heavyRequest(addDays(deadline, 1)) }, BUNDLED_CATALOG),
      ),
    ).toEqual(['deadline_too_far']);
  });

  it('runFit never asks the engine to look beyond the horizon cap, even for a far deadline in the context', () => {
    const ctx = createContext(
      { today: TODAY, request: heavyRequest('2027-01-01') },
      BUNDLED_CATALOG,
    );
    const roots = selectCourses(ctx, new ExclusionLog());
    const tasks = composeFor(ctx)(roots).composed.tasks;
    // Bypass validation on purpose: the cap must hold in runFit itself.
    ctx.request = { ...ctx.request, deadline: '9999-12-31' };
    const start = performance.now();
    const run = runFit(ctx, tasks);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(run.finishDate).not.toBeNull();
  });

  it('bounds the engine runs of all loops together', () => {
    const ctx = createContext(
      { today: TODAY, request: heavyRequest('2026-11-20') },
      BUNDLED_CATALOG,
    );
    const log = new ExclusionLog();
    const courses = selectCourses(ctx, log);
    const certs = selectCertificates(ctx, courses, log);
    const roots = [...courses, ...certs.roots];
    roots.push(...selectPractice(ctx, roots, log));
    const compose = composeFor(ctx);
    const outcome = fitRoots(ctx, compose, roots);
    fitOptions(ctx, compose, outcome);
    expect(ctx.engineRuns).toBeLessThanOrEqual(MAX_TOTAL_ENGINE_RUNS + 10);

    // Once the budget of runs is used up, the trim loop stops after its first run.
    const used = createContext(
      { today: TODAY, request: heavyRequest('2026-11-20') },
      BUNDLED_CATALOG,
    );
    used.engineRuns = MAX_TOTAL_ENGINE_RUNS;
    expect(fitRoots(used, composeFor(used), roots).runs).toBe(1);
  });
});

describe('S1: an exam keeps its direct prerequisites however they are reached', () => {
  const make = (order: string[]) =>
    catalogOf(
      [
        item({
          id: 'pre-a',
          skills: ['s7'],
          prerequisites: ['pre-b'],
          prerequisite_kinds: { 'pre-b': 'required' },
        }),
        item({ id: 'pre-b', skills: ['s8'] }),
        item({
          id: 'the-exam',
          type: 'cert_exam',
          skills: ['s1'],
          est_hours: 1,
          certificate_type: 'skills_test',
          prerequisites: order,
          prerequisite_kinds: Object.fromEntries(order.map((o) => [o, 'required'])),
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );

  for (const order of [
    ['pre-a', 'pre-b'],
    ['pre-b', 'pre-a'],
  ]) {
    it(`prerequisites listed as ${order.join(', ')}`, () => {
      const draft = build(make(order), { certPreference: 'must', skillLevels: { s8: 2 } });
      // pre-b is rated Comfortable and pre-a (a course) would skip it, but the exam needs it itself.
      expect(itemIds(draft)).toEqual(expect.arrayContaining(['pre-a', 'pre-b', 'the-exam']));
      expect(draft.skippedPrerequisites).toEqual([]);
      expect(task(draft, 'c-pre-a').dependsOn).toEqual(['c-pre-b']);
      expect(task(draft, 'x-the-exam').dependsOn).toEqual(
        expect.arrayContaining(['c-pre-a', 'c-pre-b']),
      );
    });
  }

  it('still skips a prerequisite that only a course needs', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'pre-a',
          skills: ['s7'],
          prerequisites: ['pre-b'],
          prerequisite_kinds: { 'pre-b': 'required' },
        }),
        item({ id: 'pre-b', skills: ['s8'] }),
        item({
          id: 'top',
          skills: ['s1'],
          prerequisites: ['pre-a'],
          prerequisite_kinds: { 'pre-a': 'required' },
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const draft = build(catalog, { skillLevels: { s8: 2 } });
    expect(itemIds(draft)).not.toContain('pre-b');
    expect(draft.skippedPrerequisites.map((s) => s.catalogId)).toEqual(['pre-b']);
  });
});

describe('S2: tier and overrides of items that are both root and prerequisite', () => {
  const catalog = () =>
    catalogOf(
      [
        item({
          id: 'a-top',
          skills: ['s2'],
          prerequisites: ['z-base'],
          prerequisite_kinds: { 'z-base': 'required' },
        }),
        item({ id: 'z-base', skills: ['s1'] }),
        item({ id: 'z-pre', skills: ['s9'] }),
        item({
          id: 'm-core',
          skills: ['s3'],
          prerequisites: ['z-pre'],
          prerequisite_kinds: { 'z-pre': 'required' },
        }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 2 },
            { skill: 's3', weight: 5 },
          ],
          suggested_path: {
            core: ['z-base', 'm-core'],
            optional: ['a-top'],
            practice: [],
            free_only: [],
          },
        }),
      ],
    );

  it('keeps the higher tier when a root was first added as the prerequisite of an earlier root', () => {
    const ctx = createContext({ today: TODAY, request: request() }, catalog());
    const resolved = resolveRoots(ctx, [
      { id: 'a-top', tier: 'optional', origin: 'gap', paidCertificate: false },
      { id: 'z-base', tier: 'core', origin: 'gap', paidCertificate: false },
    ]);
    const base = resolved.byId.get('z-base')!;
    expect(base.tier).toBe('core');
    expect(base.origin).toBe('gap');
    expect(resolved.byId.get('a-top')!.tier).toBe('optional');
  });

  it('applies a priority override to a prerequisite-only member, and it beats inheritance', () => {
    const plain = build(catalog());
    expect(plain.items.find((i) => i.catalogId === 'z-pre')?.tier).toBe('core'); // inherited from m-core
    const overridden = build(catalog(), { priorityOverrides: { 'z-pre': 'optional' } });
    expect(overridden.items.find((i) => i.catalogId === 'z-pre')?.tier).toBe('optional');
    const raised = build(catalog(), {
      priorityOverrides: { 'z-pre': 'core', 'm-core': 'optional' },
    });
    expect(raised.items.find((i) => i.catalogId === 'z-pre')?.tier).toBe('core');
  });
});

describe('S3: exam dates and engine warnings', () => {
  const exam = () =>
    catalogOf(
      [
        item({
          id: 'ex',
          type: 'cert_exam',
          skills: ['s1'],
          est_hours: 1,
          certificate_type: 'skills_test',
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
  const dated = (date: string) =>
    request({
      certificateOptIns: ['ex'],
      deadline: '2026-12-01',
      examDates: [{ catalogId: 'ex', date, start: '10:00' }],
    });

  it('rejects an exam date before the first schedulable day or after the deadline', () => {
    expect(codes(() => buildPlan({ today: TODAY, request: dated('2026-11-01') }, exam()))).toEqual([
      'exam_date_out_of_range',
    ]);
    expect(codes(() => buildPlan({ today: TODAY, request: dated('2026-12-02') }, exam()))).toEqual([
      'exam_date_out_of_range',
    ]);
    expect(codes(() => buildPlan({ today: TODAY, request: dated('2026-11-10') }, exam()))).toEqual(
      [],
    );
  });

  it('an exam on a day that is not a study day (Saturday) still fits: over_capacity is not a failure', () => {
    // 2026-11-07 is a Saturday; the pattern studies Sunday to Thursday.
    const draft = buildPlan({ today: TODAY, request: dated('2026-11-07') }, exam());
    const result = schedule({
      tasks: draft.plan.tasks,
      pattern: WeekPatternSchema.parse(draft.plan.weekPattern),
      today: draft.summary.scheduleFrom,
    });
    expect(result.warnings.map((w) => w.kind)).toContain('over_capacity');
    expect(draft.fits).toBe(true);
    expect(draft.options).toBeNull();
    expect(task(draft, 'x-ex').isAnchor).toBe(true);
  });

  it('an anchored exam whose prerequisites cannot be done in time does not fit', () => {
    const catalog = catalogOf(
      [
        item({ id: 'long-pre', skills: ['s9'], est_hours: 200 }),
        item({
          id: 'ex',
          type: 'cert_exam',
          skills: ['s1'],
          est_hours: 1,
          certificate_type: 'skills_test',
          prerequisites: ['long-pre'],
          prerequisite_kinds: { 'long-pre': 'required' },
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const draft = buildPlan({ today: TODAY, request: dated('2026-11-10') }, catalog);
    expect(draft.fits).toBe(false);
  });
});

describe('S4: hours-a-day option applies to all study days', () => {
  it('says so, and the value fits when applied to every study day', () => {
    const catalog = catalogOf(
      [item({ id: 'huge', skills: ['s1'], est_hours: 100 })],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['huge'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const base = request();
    const weekPattern = { ...base.weekPattern, hoursByWeekday: { '0': 6 } };
    const draft = build(catalog, { weekPattern });
    const option = draft.options!.hoursPerDay;
    expect(option.appliesToAllStudyDays).toBe(true);
    const value = option.value as number;
    const at = (h: number) =>
      schedule({
        tasks: draft.plan.tasks,
        pattern: WeekPatternSchema.parse({
          ...draft.plan.weekPattern,
          defaultHours: h,
          hoursByWeekday: {},
        }),
        today: draft.summary.scheduleFrom,
      }).finishDate as string;
    expect(compareDates(at(value), draft.summary.deadline)).toBeLessThanOrEqual(0);
    expect(compareDates(at(value - 0.5), draft.summary.deadline)).toBeGreaterThan(0);
  });
});

describe('essentials never drop what the user asked for', () => {
  it('leaves mustInclude items out of the essentials option, and says it is not possible when only they remain', () => {
    const catalog = catalogOf(
      [
        item({ id: 'small', skills: ['s1'], est_hours: 6 }),
        item({ id: 'wanted', skills: ['s2'], est_hours: 120 }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
          ],
          suggested_path: { core: ['small'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog, { mustInclude: ['wanted'] });
    expect(draft.fits).toBe(false);
    expect(draft.options?.essentials.droppedItemIds).not.toContain('wanted');
    expect(draft.options?.essentials).toMatchObject({ possible: false, droppedItemIds: [] });
  });
});

describe('export surface', () => {
  it('keeps the builder and the bundled catalog out of the package root', async () => {
    const root = await import('../index');
    expect(root).not.toHaveProperty('buildPlan');
    expect(root).not.toHaveProperty('BUNDLED_CATALOG');
    for (const name of [
      'BuildRequestSchema',
      'prefillFromProfile',
      'levelLabel',
      'validateBuildRequest',
    ]) {
      expect(root, name).toHaveProperty(name);
    }
    const entry = await import('./index');
    expect(entry).toHaveProperty('buildPlan');
    expect(entry).toHaveProperty('BUNDLED_CATALOG');
  });
});

describe('cost report details', () => {
  it('counts the unverified prices', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a', skills: ['s1'], cost_type: 'one_time', price: 5, price_verified: false }),
        item({ id: 'b', skills: ['s2'], cost_type: 'one_time', price: 5, price_verified: false }),
        item({ id: 'c', skills: ['s3'], cost_type: 'one_time', price: 5, price_verified: true }),
      ],
      [
        role({
          id: 'role-a',
          skills: ['s1', 's2', 's3'].map((skill) => ({ skill, weight: 5 })),
        }),
      ],
    );
    const { cost } = build(catalog).summary;
    expect(cost).toMatchObject({ estimated: true, unverifiedPriceCount: 2 });
  });

  it('counts an unscheduled subscription as one month and says so', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a-long', skills: ['s9'], est_hours: 450 }),
        item({
          id: 'sub',
          skills: ['s1'],
          cost_type: 'subscription',
          price: 30,
          subscription_period: 'month',
          prerequisites: ['a-long'],
          prerequisite_kinds: { 'a-long': 'required' },
        }),
      ],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['sub'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog);
    expect(draft.summary.cost.assumedOneMonth).toEqual(['sub']);
    expect(draft.summary.cost.total).toBe(30);
    expect(draft.warnings.map((w) => w.code)).toContain('subscription_months_assumed');
    const ctx = createContext({ today: TODAY, request: request() }, catalog);
    const members = resolveRoots(ctx, [
      { id: 'sub', tier: 'core', origin: 'gap', paidCertificate: false },
    ]).members;
    expect(computeCost(members, () => null).assumedOneMonth).toEqual(['sub']);
  });
});
