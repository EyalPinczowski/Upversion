import { describe, expect, it } from 'vitest';
import { addDays, compareDates } from '../dates';
import { dayCapacity } from '../scheduling/capacity';
import { schedule } from '../scheduling/engine';
import type { Block, Task } from '../schemas';
import { composeFor, createContext } from './build';
import { computeCost, spanFromBlocks } from './cost';
import { fitRoots } from './fit';
import { enforceLimit } from './limit';
import { resolveRoots } from './resolve';
import { ExclusionLog, selectCourses } from './select';
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
import { WeekPatternSchema } from '../schemas';

function scheduleDraft(
  tasks: Task[],
  pattern: ReturnType<typeof request>['weekPattern'],
  from: string,
  horizon = 365,
) {
  return schedule({
    tasks,
    pattern: WeekPatternSchema.parse(pattern),
    today: from,
    horizonDays: horizon,
  });
}

const bigRole = role({
  id: 'role-a',
  skills: [
    { skill: 's1', weight: 5 },
    { skill: 's2', weight: 4 },
  ],
});

describe('step 9: fit by the real engine', () => {
  it('fits when the engine finishes on or before the deadline', () => {
    const draft = build(basicCatalog());
    expect(draft.fits).toBe(true);
    expect(draft.options).toBeNull();
    expect(draft.summary.finishDate).not.toBeNull();
    expect(
      compareDates(draft.summary.finishDate as string, draft.summary.deadline),
    ).toBeLessThanOrEqual(0);
    const result = scheduleDraft(
      draft.plan.tasks,
      draft.plan.weekPattern,
      draft.summary.scheduleFrom,
    );
    expect(result.warnings).toEqual([]);
    expect(result.finishDate).toBe(draft.summary.finishDate);
  });

  it('schedules from today when the start date is already past', () => {
    const draft = build(basicCatalog(), { startDate: '2026-10-20' });
    expect(draft.summary.scheduleFrom).toBe(TODAY);
    expect(draft.plan.startDate).toBe('2026-10-20');
  });

  it('uses the engine, not the sum of day capacities: a window too short for the hours does not fit', () => {
    const catalog = catalogOf(
      [item({ id: 'x', skills: ['s1'], est_hours: 20 })],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['x'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const weekPattern = {
      studyWeekdays: [0, 1, 2, 3, 4],
      defaultHours: 8,
      windowStart: '09:00',
      windowEnd: '10:00',
      timezone: 'Asia/Jerusalem',
    };
    const deadline = '2026-11-10';
    const draft = build(catalog, { weekPattern, deadline });
    // The days promise 8 h each, far more than 20 h in total...
    let capacity = 0;
    for (let d = '2026-11-03'; compareDates(d, deadline) <= 0; d = addDays(d, 1)) {
      capacity += dayCapacity(d, WeekPatternSchema.parse(weekPattern)).capacityMinutes / 60;
    }
    expect(capacity).toBeGreaterThanOrEqual(20.5);
    // ...but the window holds one hour a day, so the engine cannot place the plan.
    expect(draft.fits).toBe(false);
    expect(draft.options).not.toBeNull();
  });

  it('drops optional items first (lowest priority first) and keeps the core ones', () => {
    const catalog = catalogOf(
      [
        item({ id: 'core-1', skills: ['s1'], est_hours: 6 }),
        item({ id: 'opt-big', skills: ['s2'], est_hours: 100 }),
      ],
      [
        {
          ...bigRole,
          suggested_path: { core: ['core-1'], optional: ['opt-big'], practice: [], free_only: [] },
        },
      ],
    );
    const draft = build(catalog);
    expect(draft.fits).toBe(true);
    expect(itemIds(draft)).toEqual(['core-1']);
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'opt-big', reason: 'dropped_to_fit_time' }),
    );
    expect(draft.summary.skillsNotCovered).toEqual([
      { skillId: 's2', name: 'Skill s2', reason: 'dropped_to_fit_time' },
    ]);
  });

  it('never drops core items silently: it returns fits false with the three options, computed by the engine', () => {
    const catalog = catalogOf(
      [item({ id: 'huge', skills: ['s1'], est_hours: 100 })],
      [
        {
          ...bigRole,
          suggested_path: { core: ['huge'], optional: [], practice: [], free_only: [] },
        },
      ],
    );
    const draft = build(catalog);
    expect(itemIds(draft)).toEqual(['huge']);
    expect(draft.fits).toBe(false);
    const options = draft.options!;

    // 1. Finish on <date>: the unconstrained finish date, after the deadline.
    const open = scheduleDraft(
      draft.plan.tasks,
      draft.plan.weekPattern,
      draft.summary.scheduleFrom,
    );
    expect(options.finishOn.date).toBe(open.finishDate);
    expect(compareDates(options.finishOn.date as string, draft.summary.deadline)).toBeGreaterThan(
      0,
    );
    expect(draft.summary.finishDate).toBe(open.finishDate);

    // 2. Study h hours a day: the smallest value on a 0.5 h grid that fits.
    const hours = options.hoursPerDay.value as number;
    expect(hours).toBeGreaterThan(3);
    expect(hours * 2).toBe(Math.round(hours * 2));
    const at = (h: number) =>
      scheduleDraft(
        draft.plan.tasks,
        { ...draft.plan.weekPattern, defaultHours: h, hoursByWeekday: {} },
        draft.summary.scheduleFrom,
      );
    expect(
      compareDates(at(hours).finishDate as string, draft.summary.deadline),
    ).toBeLessThanOrEqual(0);
    expect(at(hours).warnings).toEqual([]);
    expect(
      compareDates(at(hours - 0.5).finishDate as string, draft.summary.deadline),
    ).toBeGreaterThan(0);

    // 3. Keep only the essentials: here nothing is small enough, so it is not possible.
    expect(options.essentials.possible).toBe(false);
  });

  it('says "not possible within your window" (null) when even a full window does not fit', () => {
    const catalog = catalogOf(
      [item({ id: 'huge', skills: ['s1'], est_hours: 400 })],
      [
        {
          ...bigRole,
          suggested_path: { core: ['huge'], optional: [], practice: [], free_only: [] },
        },
      ],
    );
    const draft = build(catalog);
    expect(draft.fits).toBe(false);
    expect(draft.options?.hoursPerDay.value).toBeNull();
  });

  it('offers the essentials: the lowest-priority core items to leave out and the skills that are lost', () => {
    const catalog = catalogOf(
      [
        item({ id: 'small', skills: ['s1'], est_hours: 6 }),
        item({ id: 'big', skills: ['s2'], est_hours: 120 }),
      ],
      [
        {
          ...bigRole,
          suggested_path: { core: ['small', 'big'], optional: [], practice: [], free_only: [] },
        },
      ],
    );
    const draft = build(catalog);
    expect(draft.fits).toBe(false);
    expect(draft.options?.essentials).toEqual({
      possible: true,
      droppedItemIds: ['big'],
      lostSkillIds: ['s2'],
    });
    // Applying it is the caller's choice: the draft itself still has both.
    expect(itemIds(draft).sort()).toEqual(['big', 'small']);
    const again = build(catalog, { exclude: ['big'] });
    expect(again.fits).toBe(true);
  });

  it('keeps the number of engine runs bounded', () => {
    const catalog = basicCatalog();
    const ctx = createContext(
      { today: TODAY, request: request({ deadline: '2026-11-05' }) },
      catalog,
    );
    const roots = selectCourses(ctx, new ExclusionLog());
    const outcome = fitRoots(ctx, composeFor(ctx), roots);
    expect(outcome.runs).toBeLessThanOrEqual(80);
  });
});

describe('step 10: cost', () => {
  const group = (id: string, hours = 10) =>
    item({
      id,
      skills: ['s1'],
      est_hours: hours,
      cost_type: 'subscription',
      price: 59,
      subscription_period: 'month',
      subscription_group: 'plus',
    });

  const block = (taskId: string, date: string): Block => ({
    taskId,
    date,
    start: '09:00',
    end: '10:00',
    minutes: 60,
    kind: 'study',
  });

  function costWithSpan(first: string, last: string) {
    const catalog = catalogOf(
      [group('g1'), group('g2'), group('g3')],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const ctx = createContext({ today: TODAY, request: request() }, catalog);
    const members = resolveRoots(
      ctx,
      ['g1', 'g2', 'g3'].map((id) => ({
        id,
        tier: 'core' as const,
        origin: 'gap' as const,
        paidCertificate: false,
      })),
    ).members;
    const taskItem = new Map([
      ['c-g1', 'g1'],
      ['c-g2', 'g2'],
      ['c-g3', 'g3'],
    ]);
    return computeCost(
      members,
      spanFromBlocks(
        [block('c-g1', first), block('c-g2', '2026-11-10'), block('c-g3', last)],
        taskItem,
      ),
    );
  }

  it('pays a subscription group once per month it is used: three items over six weeks are two months', () => {
    const report = costWithSpan('2026-11-01', '2026-12-12'); // 42 days
    expect(report.subscriptionMonths).toEqual({ plus: 2 });
    expect(report.total).toBe(118);
    expect(report.lines).toHaveLength(1);
  });

  it('counts months as ceil((last - first + 1) / 30), at least one', () => {
    expect(costWithSpan('2026-11-01', '2026-11-30').subscriptionMonths).toEqual({ plus: 1 }); // 30 days
    expect(costWithSpan('2026-11-01', '2026-12-01').subscriptionMonths).toEqual({ plus: 2 }); // 31 days
    expect(costWithSpan('2026-11-01', '2026-12-30').subscriptionMonths).toEqual({ plus: 2 }); // 60 days
    expect(costWithSpan('2026-11-01', '2026-12-31').subscriptionMonths).toEqual({ plus: 3 }); // 61 days
  });

  it('takes the months from the real schedule of a built plan', () => {
    const catalog = catalogOf(
      [group('g1', 12), group('g2', 12), group('g3', 12)],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const weekPattern = {
      studyWeekdays: [0, 1, 2, 3, 4],
      defaultHours: 1,
      windowStart: '09:00',
      windowEnd: '12:00',
      timezone: 'Asia/Jerusalem',
    };
    // g1 is picked for s1; the others are must-includes, so all three are in the plan.
    const draft = build(catalog, {
      weekPattern,
      deadline: '2027-03-01',
      mustInclude: ['g2', 'g3'],
    });
    const result = scheduleDraft(
      draft.plan.tasks,
      draft.plan.weekPattern,
      draft.summary.scheduleFrom,
    );
    const groupBlocks = result.blocks.filter((b) => /^c-g\d$/.test(b.taskId));
    const first = groupBlocks[0]!.date;
    const last = groupBlocks[groupBlocks.length - 1]!.date;
    const days = (Date.parse(last) - Date.parse(first)) / 86_400_000 + 1;
    expect(days).toBeGreaterThan(31);
    expect(draft.summary.cost.subscriptionMonths).toEqual({ plus: Math.ceil(days / 30) });
    expect(draft.summary.cost.total).toBe(59 * Math.ceil(days / 30));
  });

  it('counts a subscription outside a group by its own period', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'monthly',
          skills: ['s1'],
          est_hours: 4,
          cost_type: 'subscription',
          price: 20,
          subscription_period: 'month',
        }),
        item({
          id: 'yearly',
          skills: ['s2'],
          est_hours: 4,
          cost_type: 'subscription',
          price: 120.5,
          subscription_period: 'year',
        }),
      ],
      [bigRole],
    );
    const draft = build(catalog);
    const lines = Object.fromEntries(draft.summary.cost.lines.map((l) => [l.catalogId, l]));
    expect(lines['monthly']).toMatchObject({ amount: 20, periods: 1 });
    expect(lines['yearly']).toMatchObject({ amount: 120.5, periods: 1 });
    expect(draft.summary.cost.total).toBe(140.5);
  });

  it('does not add a price that is null; it counts it as a price to check', () => {
    const catalog = catalogOf(
      [
        item({ id: 'known', skills: ['s1'], cost_type: 'one_time', price: 40 }),
        item({
          id: 'unknown',
          skills: ['s2'],
          cost_type: 'one_time',
          price: null,
          price_verified: false,
        }),
      ],
      [bigRole],
    );
    const draft = build(catalog);
    expect(draft.summary.cost).toMatchObject({ total: 40, pricesToCheck: 1 });
    const unknown = draft.items.find((i) => i.catalogId === 'unknown')!;
    expect(unknown).toMatchObject({ priceVaries: true, needsCheckPrice: true });
    expect(unknown.cost).toEqual({ amount: null, kind: 'one_time' });
  });

  it('is "estimated" as soon as one included price is not verified', () => {
    const verified = catalogOf(
      [item({ id: 'a', skills: ['s1'], cost_type: 'one_time', price: 10, price_verified: true })],
      [bigRole],
    );
    expect(build(verified).summary.cost.estimated).toBe(false);
    const unverified = catalogOf(
      [item({ id: 'a', skills: ['s1'], cost_type: 'one_time', price: 10, price_verified: false })],
      [bigRole],
    );
    expect(build(unverified).summary.cost.estimated).toBe(true);
  });

  it('adds prices without floating point noise', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a', skills: ['s1'], cost_type: 'one_time', price: 0.1 }),
        item({ id: 'b', skills: ['s2'], cost_type: 'one_time', price: 0.2 }),
      ],
      [bigRole],
    );
    expect(build(catalog).summary.cost.total).toBe(0.3);
  });
});

describe('step 10: the budget limit', () => {
  const paidTwo = (extra: ReturnType<typeof item>[] = []) =>
    catalogOf(
      [
        item({ id: 'a-paid', skills: ['s1'], cost_type: 'one_time', price: 60, est_hours: 5 }),
        item({ id: 'b-paid', skills: ['s2'], cost_type: 'one_time', price: 60, est_hours: 5 }),
        ...extra,
      ],
      [
        {
          ...bigRole,
          suggested_path: { core: ['a-paid', 'b-paid'], optional: [], practice: [], free_only: [] },
        },
      ],
    );

  it('keeps the known total within the limit: a 100 USD limit with two 60 USD items drops the lower-priority one', () => {
    const draft = build(paidTwo(), { budget: { mode: 'limit', amount: 100 } });
    expect(draft.summary.cost.total).toBe(60);
    expect(itemIds(draft)).toEqual(['a-paid']); // s1 has the higher priority
    expect(draft.overBudget).toBe(false);
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'b-paid', reason: 'dropped_to_fit_budget' }),
    );
    expect(draft.summary.skillsNotCovered).toEqual([
      { skillId: 's2', name: 'Skill s2', reason: 'dropped_to_fit_budget' },
    ]);
  });

  it('swaps a paid item for its free alternative when that teaches the same skills', () => {
    const catalog = paidTwo([item({ id: 'z-free', skills: ['s2', 's9'], est_hours: 7 })]);
    catalog.items = catalog.items.map((i) =>
      i.id === 'b-paid' ? { ...i, free_alternative_ids: ['z-free'] } : i,
    );
    const draft = build(catalog, { budget: { mode: 'limit', amount: 100 } });
    expect(itemIds(draft).sort()).toEqual(['a-paid', 'z-free']);
    expect(draft.items.find((i) => i.catalogId === 'z-free')).toMatchObject({
      origin: 'free_alternative',
    });
    expect(draft.summary.cost.total).toBe(60);
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'b-paid', reason: 'over_budget', relatedId: 'z-free' }),
    );
    expect(draft.summary.skillsNotCovered).toEqual([]);
  });

  it('does not touch a plan that is already within the limit', () => {
    const draft = build(paidTwo(), { budget: { mode: 'limit', amount: 120 } });
    expect(draft.summary.cost.total).toBe(120);
    expect(draft.excluded).toEqual([]);
  });

  it('excludes an item with a null price under a limit, and keeps it (flagged) when flexible', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'n',
          skills: ['s1'],
          cost_type: 'one_time',
          price: null,
          price_verified: false,
        }),
      ],
      [{ ...bigRole, suggested_path: { core: ['n'], optional: [], practice: [], free_only: [] } }],
    );
    const limited = build(catalog, { budget: { mode: 'limit', amount: 100 } });
    expect(itemIds(limited)).toEqual([]);
    expect(limited.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'n', reason: 'price_unknown' }),
    );
    const flexible = build(catalog, { budget: { mode: 'flexible' } });
    expect(itemIds(flexible)).toEqual(['n']);
    expect(task(flexible, 'c-n').notes).toContain('Price varies');
  });

  it('maxItemPrice caps each item, on top of the mode', () => {
    const draft = build(paidTwo(), { budget: { mode: 'flexible', maxItemPrice: 50 } });
    expect(itemIds(draft)).toEqual([]);
    expect(draft.excluded.map((e) => e.reason)).toEqual(['over_item_price', 'over_item_price']);
    const free = build(paidTwo(), { budget: { mode: 'flexible', maxItemPrice: 60 } });
    expect(free.summary.cost.total).toBe(120); // flexible has no total cap
  });

  it('a free budget never contains a paid item', () => {
    const draft = build(paidTwo([item({ id: 'f', skills: ['s1'] })]), { budget: { mode: 'free' } });
    expect(itemIds(draft)).toEqual(['f']);
    expect(draft.summary.cost.total).toBe(0);
  });

  it('one swap/drop pass and one re-fit: if the total is still over, it says so and lists what to remove', () => {
    const catalog = paidTwo();
    const ctx = createContext(
      { today: TODAY, request: request({ budget: { mode: 'limit', amount: 100 } }) },
      catalog,
    );
    const roots = selectCourses(ctx, new ExclusionLog());
    const real = composeFor(ctx);
    const outcome = fitRoots(ctx, real, roots);
    let calls = 0;
    // A compose that ignores what was removed: the re-fit sees the same plan again.
    const stuck = () => {
      calls += 1;
      return outcome.draft;
    };
    const result = enforceLimit(ctx, stuck, outcome, new ExclusionLog());
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(80);
    expect(result.overBudget).toBe(true);
    expect(result.cost.total).toBe(120);
    expect(result.removeToFit).toEqual(['b-paid']);
  });
});
