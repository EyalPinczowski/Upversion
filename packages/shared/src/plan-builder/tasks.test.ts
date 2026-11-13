import { describe, expect, it } from 'vitest';
import { parsePlanFile } from '../schemas';
import { CATALOG_QUESTIONS } from '../profile/catalog';
import { LEVEL_LABELS } from './context';
import { BuildDraftSchema, BuildRequestSchema } from './schemas';
import { buildPlan } from './build';
import {
  TODAY,
  basicCatalog,
  build,
  buildReal,
  catalogOf,
  hasTask,
  item,
  itemIds,
  request,
  role,
  task,
} from './test-fixtures';

const oneRole = (extra: Partial<Parameters<typeof role>[0]> = {}) =>
  role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }], ...extra });

describe('step 11: task mapping', () => {
  it('gives a task a url only when the catalog says the link is verified', () => {
    const catalog = catalogOf(
      [
        item({ id: 'ok', skills: ['s1'], url_verified: true }),
        item({ id: 'unchecked', skills: ['s2'], url_verified: false }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 5 },
          ],
        }),
      ],
    );
    const draft = build(catalog);
    expect(task(draft, 'c-ok').url).toBe('https://example.test/ok');
    expect(task(draft, 'c-ok').notes).not.toContain('Needs check: link');
    expect(task(draft, 'c-unchecked').url).toBeUndefined();
    expect(task(draft, 'c-unchecked').notes).toContain(
      "Needs check: link not yet verified; confirm it on the provider's site before relying on it.",
    );
    expect(draft.items.find((i) => i.catalogId === 'unchecked')?.needsCheckLink).toBe(true);
    expect(draft.items.find((i) => i.catalogId === 'ok')?.needsCheckLink).toBe(false);
  });

  it('writes ids, titles, provider, reference and source from the catalog', () => {
    const draft = build(basicCatalog());
    expect(task(draft, 'c-c-s1')).toMatchObject({
      title: 'Item c-s1',
      provider: 'Test Provider',
      type: 'course',
      estHours: 6,
      externalRef: 'catalog:c-s1',
      source: 'builder',
      status: 'pending',
    });
  });

  it('shows a verified price as per catalog, an unverified one as "needs check", an unknown one as varying', () => {
    const catalog = catalogOf(
      [
        item({ id: 'v', skills: ['s1'], cost_type: 'one_time', price: 80, price_verified: true }),
        item({ id: 'u', skills: ['s2'], cost_type: 'one_time', price: 80, price_verified: false }),
        item({
          id: 'n',
          skills: ['s3'],
          cost_type: 'one_time',
          price: null,
          price_verified: false,
        }),
        item({
          id: 'm',
          skills: ['s4'],
          cost_type: 'subscription',
          price: 59,
          subscription_period: 'month',
          price_verified: true,
        }),
        item({ id: 'f', skills: ['s5'], cost_type: 'free', price: 0, price_verified: true }),
      ],
      [
        role({
          id: 'role-a',
          skills: ['s1', 's2', 's3', 's4', 's5'].map((skill) => ({ skill, weight: 5 })),
        }),
      ],
    );
    const draft = build(catalog);
    expect(task(draft, 'c-v').notes).toContain(
      'Price per catalog: 80 USD (prices change; re-check before paying).',
    );
    expect(task(draft, 'c-u').notes).toContain('Needs check: price not verified.');
    expect(task(draft, 'c-u').notes).not.toContain('Price per catalog');
    expect(task(draft, 'c-n').notes).toContain(
      "Price varies – check the price on the provider's page.",
    );
    expect(task(draft, 'c-m').notes).toContain('Price per catalog: 59 USD per month');
    expect(task(draft, 'c-f').notes).toContain('Price per catalog: free');
  });

  it('is a plan file: name, dates, week pattern, skill ids', () => {
    const withS9 = basicCatalog();
    const catalog = catalogOf(
      [...withS9.items, item({ id: 'c-s9', skills: ['s9'] })],
      [...withS9.roles],
    );
    const draft = build(catalog, { extraSkillIds: ['s9'] });
    expect(draft.plan).toMatchObject({
      formatVersion: 1,
      name: 'Role role-a plan',
      startDate: '2026-11-03',
      endDate: '2026-12-01',
      overrides: [],
    });
    expect(draft.plan.skillIds).toEqual(['s1', 's2', 's9', 's3']);
    expect(draft.plan.weekPattern.timezone).toBe('Asia/Jerusalem');
    expect(() => parsePlanFile(JSON.parse(JSON.stringify(draft.plan)))).not.toThrow();
    expect(() => BuildDraftSchema.parse(JSON.parse(JSON.stringify(draft)))).not.toThrow();
  });

  it('names a two-role plan after both roles', () => {
    const catalog = catalogOf([], [role({ id: 'role-a' }), role({ id: 'role-b' })]);
    const draft = build(catalog, { targetRoleIds: ['role-a', 'role-b'] });
    expect(draft.plan.name).toBe('Role role-a + Role role-b plan');
  });
});

describe('step 7: admin tasks', () => {
  const tenHours = () =>
    catalogOf(
      ['a', 'b', 'c'].map((id, i) => item({ id: `c-${id}`, skills: [`s${i + 1}`], est_hours: 10 })),
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 5 },
            { skill: 's3', weight: 5 },
          ],
        }),
      ],
    );

  it('starts with one 0.5 h setup task and adds a 0.5 h weekly review after about every week of hours', () => {
    const draft = build(tenHours());
    const tasks = draft.plan.tasks;
    expect(tasks[0]).toMatchObject({ id: 'a-setup-1', type: 'admin', estHours: 0.5, order: 0 });
    // 3 study days a... week capacity is 5 x 3 = 15 h: 10 h, 20 h (review), 30 h (last: no review).
    const reviews = tasks.filter((t) => t.id.startsWith('a-review-'));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ id: 'a-review-1', estHours: 0.5, type: 'admin' });
    const ids = tasks.map((t) => t.id);
    expect(ids.indexOf('a-review-1')).toBe(3);
    expect(ids[ids.length - 1]).toBe('c-c-c');
  });

  it('numbers orders from zero without gaps and puts dependencies before dependents', () => {
    const draft = build(basicCatalog(), { interviewPrep: 'yes' });
    expect(draft.plan.tasks.map((t) => t.order)).toEqual(draft.plan.tasks.map((_, i) => i));
    const order = new Map(draft.plan.tasks.map((t) => [t.id, t.order]));
    for (const t of draft.plan.tasks) {
      for (const d of t.dependsOn) expect(order.get(d)).toBeLessThan(t.order);
    }
  });
});

describe('step 6: practice', () => {
  it('keeps a practice item that has no link, and does not flag its missing link', () => {
    const draft = build(basicCatalog(), { interviewPrep: 'yes' });
    const p = task(draft, 'c-p1');
    expect(p).toMatchObject({ type: 'practice', estHours: 2, practiceKind: 'portfolio_project' });
    expect(p.url).toBeUndefined();
    expect(p.notes).not.toContain('Needs check: link');
    expect(p.notes).toContain('Practice for interviews (you asked for interview prep).');
  });

  it('puts practice for a skill after the learning items for that skill', () => {
    const draft = build(basicCatalog(), { interviewPrep: 'yes' });
    expect(task(draft, 'c-p1').dependsOn).toEqual(['c-c-s1']);
    expect(task(draft, 'c-p1').order).toBeGreaterThan(task(draft, 'c-c-s1').order);
  });

  it('"later" makes practice depend on the last course', () => {
    const draft = build(basicCatalog(), { interviewPrep: 'later' });
    const courses = draft.plan.tasks.filter((t) => t.type === 'course');
    const lastCourse = courses[courses.length - 1]!;
    expect(task(draft, 'c-p1').dependsOn).toContain(lastCourse.id);
  });

  it('"no" adds no practice, and takes at most 4 per role', () => {
    expect(hasTask(build(basicCatalog(), { interviewPrep: 'no' }), 'c-p1')).toBe(false);
    const many = catalogOf(
      Array.from({ length: 6 }, (_, i) =>
        item({
          id: `pr-${i}`,
          type: 'practice',
          url: null,
          url_verified: false,
          skills: ['s1'],
          est_hours: 1,
        }),
      ),
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 1 }],
          suggested_path: {
            core: [],
            optional: [],
            free_only: [],
            practice: ['pr-0', 'pr-1', 'pr-2', 'pr-3', 'pr-4', 'pr-5'],
          },
        }),
      ],
    );
    expect(itemIds(build(many, { interviewPrep: 'yes' }))).toHaveLength(4);
  });

  it('mock interviews and timed tests are not splittable', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'mock',
          type: 'practice',
          title: 'Mock behavioral interview',
          url: null,
          url_verified: false,
          skills: ['s1'],
          est_hours: 1.5,
        }),
        item({
          id: 'essay',
          type: 'practice',
          title: 'Home assignment - report',
          url: null,
          url_verified: false,
          skills: ['s1'],
          est_hours: 3,
        }),
      ],
      [
        oneRole({
          suggested_path: { core: [], optional: [], free_only: [], practice: ['mock', 'essay'] },
        }),
      ],
    );
    const draft = build(catalog, { interviewPrep: 'yes' });
    expect(task(draft, 'c-mock')).toMatchObject({
      splittable: false,
      practiceKind: 'mock_interview',
    });
    expect(task(draft, 'c-essay')).toMatchObject({
      splittable: true,
      practiceKind: 'home_assignment',
    });
  });
});

describe('step 12: why lines are templates', () => {
  it('names the skill, the role weight and the rated level', () => {
    const draft = build(basicCatalog(), { skillLevels: { s2: 1 } });
    expect(draft.items.find((i) => i.catalogId === 'c-s1')?.why).toBe(
      'Teaches Skill s1 – the role weights it 5 and you rated it Never used.',
    );
    expect(draft.items.find((i) => i.catalogId === 'c-s2')?.why).toBe(
      'Teaches Skill s2 – the role weights it 4 and you rated it Basic.',
    );
    expect(task(draft, 'c-c-s2').notes?.startsWith('Teaches Skill s2')).toBe(true);
  });

  it('joins several skills and a range of weights and levels', () => {
    const catalog = catalogOf(
      [item({ id: 'big', skills: ['s1', 's2'] })],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
          ],
        }),
      ],
    );
    const draft = build(catalog, { skillLevels: { s2: 1 } });
    expect(draft.items[0]?.why).toBe(
      'Teaches Skill s1 and Skill s2 – the role weights them 4–5 and you rated them Never used and Basic.',
    );
  });

  it('uses the level labels of questions.json', () => {
    const q = CATALOG_QUESTIONS.find((x) => x.id === 'skill_levels') as unknown as {
      scale: { value: number; label: string }[];
    };
    expect(q.scale.map((s) => s.label)).toEqual([...LEVEL_LABELS]);
  });
});

describe('request schema', () => {
  const ok = () => request();

  it('accepts a normal request and applies defaults', () => {
    const parsed = BuildRequestSchema.parse(ok());
    expect(parsed.extraSkillIds).toEqual([]);
    expect(parsed.certificateOptIns).toEqual([]);
    expect(parsed.priorityOverrides).toEqual({});
  });

  it('rejects unknown keys, at the top and inside the budget and the week pattern', () => {
    for (const bad of [
      { ...ok(), userId: 'abc' },
      { ...ok(), note: 'hello' },
      { ...ok(), budget: { mode: 'free', currency: 'ILS' } },
      { ...ok(), weekPattern: { ...ok().weekPattern, label: 'mine' } },
      { ...ok(), examDates: [{ catalogId: 'x', date: '2026-12-01', start: '10:00', note: 'hi' }] },
    ]) {
      expect(BuildRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects any string that is not an id, a date, a time or a time zone', () => {
    for (const bad of [
      { ...ok(), targetRoleIds: ['Operations Associate'] },
      { ...ok(), targetRoleIds: ['<script>'] },
      { ...ok(), extraSkillIds: ['my own skill'] },
      { ...ok(), mustInclude: ['Hello, world'] },
      { ...ok(), startDate: 'tomorrow' },
      { ...ok(), deadline: '2026-13-40' },
      { ...ok(), skillLevels: { 'free text': 1 } },
      { ...ok(), weekPattern: { ...ok().weekPattern, windowStart: 'morning' } },
      { ...ok(), weekPattern: { ...ok().weekPattern, timezone: 'my home town' } },
      { ...ok(), examDates: [{ catalogId: 'x', date: '2026-12-01', start: 'noon' }] },
      { ...ok(), certPreference: 'maybe' },
    ]) {
      expect(BuildRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('needs an amount for a limit and bounds every list', () => {
    expect(BuildRequestSchema.safeParse({ ...ok(), budget: { mode: 'limit' } }).success).toBe(
      false,
    );
    expect(
      BuildRequestSchema.safeParse({ ...ok(), budget: { mode: 'limit', amount: 100 } }).success,
    ).toBe(true);
    expect(
      BuildRequestSchema.safeParse({ ...ok(), budget: { mode: 'limit', amount: 0 } }).success,
    ).toBe(false);
    expect(BuildRequestSchema.safeParse({ ...ok(), targetRoleIds: [] }).success).toBe(false);
    expect(BuildRequestSchema.safeParse({ ...ok(), targetRoleIds: ['a', 'b', 'c'] }).success).toBe(
      false,
    );
    expect(
      BuildRequestSchema.safeParse({ ...ok(), extraSkillIds: ['a', 'b', 'c', 'd', 'e', 'f'] })
        .success,
    ).toBe(false);
    expect(
      BuildRequestSchema.safeParse({
        ...ok(),
        certificateOptIns: Array.from({ length: 11 }, (_, i) => `x${i}`),
      }).success,
    ).toBe(false);
    expect(
      BuildRequestSchema.safeParse({
        ...ok(),
        skillLevels: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`s${i}`, 1])),
      }).success,
    ).toBe(false);
    expect(BuildRequestSchema.safeParse({ ...ok(), skillLevels: { s1: 4 } }).success).toBe(false);
  });

  it('buildPlan throws on a limit without an amount instead of guessing', () => {
    expect(() =>
      buildPlan({ today: TODAY, request: request({ budget: { mode: 'limit' } }) }, basicCatalog()),
    ).toThrow();
  });
});

describe('determinism and purity', () => {
  it('gives the same output twice, byte for byte', () => {
    const a = JSON.stringify(
      buildReal({ targetRoleIds: ['data-analyst'], certPreference: 'must' }),
    );
    const b = JSON.stringify(
      buildReal({ targetRoleIds: ['data-analyst'], certPreference: 'must' }),
    );
    expect(a).toBe(b);
  });

  it('does not depend on the order of the catalog items', () => {
    const catalog = basicCatalog();
    const reversed = { ...catalog, items: [...catalog.items].reverse() };
    const input = { today: TODAY, request: request({ interviewPrep: 'yes' }) };
    expect(JSON.stringify(buildPlan(input, reversed))).toBe(
      JSON.stringify(buildPlan(input, catalog)),
    );
  });

  it('does not change its input or the catalog', () => {
    const catalog = basicCatalog();
    const before = JSON.stringify(catalog);
    const input = { today: TODAY, request: request() };
    const inBefore = JSON.stringify(input);
    buildPlan(input, catalog);
    expect(JSON.stringify(catalog)).toBe(before);
    expect(JSON.stringify(input)).toBe(inBefore);
  });

  it('draftHash changes when the plan changes', () => {
    const a = build(basicCatalog());
    const b = build(basicCatalog(), { exclude: ['c-s3'] });
    expect(a.draftHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.draftHash).not.toBe(b.draftHash);
  });
});
