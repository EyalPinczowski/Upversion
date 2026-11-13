import { describe, expect, it } from 'vitest';
import { createContext } from './build';
import {
  catalogOf,
  item,
  request,
  role,
  TODAY,
  basicCatalog,
  build,
  itemIds,
  task,
} from './test-fixtures';
import { computeTargets } from './targets';
import { indexCatalog } from './catalog';
import { BuildRequestSchema } from './schemas';
import { closureOf } from './context';
import { itemBudgetReason, certificateBudgetReason, effectivePrice } from './budget';
import { ExclusionLog, selectCourses } from './select';
import { BuildRequestError } from './validate';
import { buildPlan } from './build';

const parse = (o = {}) => BuildRequestSchema.parse(request(o));

describe('step 1: targets and gaps', () => {
  const index = indexCatalog(basicCatalog());

  it('needs Comfortable for weight 4 and 5, Basic below, and ranks by weight x gap', () => {
    const targets = computeTargets(parse({ skillLevels: { s2: 1 } }), index);
    const by = Object.fromEntries(targets.map((t) => [t.skillId, t]));
    expect(by['s1']).toMatchObject({ need: 2, level: 0, gap: 2, priority: 10 });
    expect(by['s2']).toMatchObject({ need: 2, level: 1, gap: 1, priority: 4 });
    expect(by['s3']).toMatchObject({ need: 1, level: 0, gap: 1, priority: 2 });
    expect(targets.map((t) => t.skillId)).toEqual(['s1', 's2', 's3']);
  });

  it('lists a skill with no gap as already covered', () => {
    const draft = build(basicCatalog(), { skillLevels: { s1: 2, s2: 3 } });
    expect(draft.summary.skillsAlreadyCovered).toEqual(['s1', 's2']);
    expect(itemIds(draft)).not.toContain('c-s1');
    expect(itemIds(draft)).not.toContain('c-s2');
    expect(itemIds(draft)).toContain('c-s3');
  });

  it('gives an extra skill weight 4 and need 2, and keeps the larger weight when a role lists it too', () => {
    const targets = computeTargets(
      parse({ extraSkillIds: ['s3', 's4'] }),
      indexCatalog(
        catalogOf(
          [],
          [
            role({
              id: 'role-a',
              skills: [
                { skill: 's3', weight: 5 },
                { skill: 's1', weight: 3 },
              ],
            }),
          ],
        ),
      ),
    );
    const by = Object.fromEntries(targets.map((t) => [t.skillId, t]));
    expect(by['s4']).toMatchObject({ weight: 4, need: 2, gap: 2, priority: 8, extra: true });
    expect(by['s3']).toMatchObject({ weight: 5, need: 2, extra: true });
    expect(by['s1']).toMatchObject({ weight: 3, need: 1, extra: false });
  });

  it('takes the larger weight when two target roles list the same skill', () => {
    const idx = indexCatalog(
      catalogOf(
        [],
        [
          role({ id: 'role-a', skills: [{ skill: 's1', weight: 2 }] }),
          role({ id: 'role-b', skills: [{ skill: 's1', weight: 5 }] }),
        ],
      ),
    );
    const t = computeTargets(parse({ targetRoleIds: ['role-a', 'role-b'] }), idx);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ weight: 5, need: 2, roleIds: ['role-a', 'role-b'] });
  });
});

describe('step 2 and 3: eligible items and greedy selection', () => {
  const cat = (extra: Parameters<typeof item>[0][]) =>
    catalogOf(
      extra.map((e) => item(e)),
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 5 },
            { skill: 's2', weight: 4 },
          ],
          suggested_path: { core: [], optional: [], practice: [], free_only: [] },
        }),
      ],
    );

  it('picks the item that covers the most priority first, then does not repeat covered skills', () => {
    const draft = build(
      cat([
        { id: 'big', skills: ['s1', 's2'] },
        { id: 'only-1', skills: ['s1'] },
        { id: 'only-2', skills: ['s2'] },
      ]),
    );
    expect(itemIds(draft)).toEqual(['big']);
  });

  it('breaks ties by catalog id, whatever the order of the catalog', () => {
    const items = [
      { id: 'b-x', skills: ['s1', 's2'] },
      { id: 'a-x', skills: ['s1', 's2'] },
    ];
    expect(itemIds(build(cat(items)))).toEqual(['a-x']);
    expect(itemIds(build(cat([...items].reverse())))).toEqual(['a-x']);
  });

  it('adds 3 for the core path and 1 for a verified link', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a-plain', skills: ['s1'], url_verified: false }),
        item({ id: 'b-verified', skills: ['s1'] }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    // Without the verified bonus the lower id would win; with it b-verified does.
    expect(itemIds(build(catalog))).toEqual(['b-verified']);
    const onPath = catalogOf(
      [
        item({ id: 'a-plain', skills: ['s1'], url_verified: false }),
        item({ id: 'b-verified', skills: ['s1'] }),
      ],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['a-plain'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    expect(itemIds(build(onPath))).toEqual(['a-plain']);
  });

  it('prefers an intermediate item over a beginner one when the user already has the basics', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a-beg', skills: ['s1'], level: 'beginner' }),
        item({ id: 'b-inter', skills: ['s1'], level: 'intermediate' }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    expect(itemIds(build(catalog, { skillLevels: { s1: 1 } }))).toEqual(['b-inter']);
    expect(itemIds(build(catalog, { skillLevels: { s1: 0 } }))).toEqual(['a-beg']);
  });

  it('never chooses an item without a link, and lists the skill as a catalog gap', () => {
    const catalog = catalogOf(
      [item({ id: 'no-link', skills: ['s1'], url: null, url_verified: false })],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: [], optional: ['no-link'], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog);
    expect(itemIds(draft)).toEqual([]);
    expect(draft.summary.skillsNotCovered).toEqual([
      { skillId: 's1', name: 'Skill s1', reason: 'catalog_gap' },
    ]);
    expect(draft.excluded).toMatchObject([{ catalogId: 'no-link', reason: 'no_link' }]);
    expect(draft.warnings.some((w) => w.code === 'catalog_gap')).toBe(true);
  });

  it('drops items on the exclude list', () => {
    const draft = build(basicCatalog(), { exclude: ['c-s1'] });
    expect(itemIds(draft)).not.toContain('c-s1');
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'c-s1', reason: 'excluded_by_user' }),
    );
  });

  it('adds mustInclude items first, as core, even when the user has no gap for them', () => {
    const catalog = catalogOf(
      [item({ id: 'extra', skills: ['s9'] }), ...basicCatalog().items],
      [...basicCatalog().roles],
    );
    const draft = build(catalog, { mustInclude: ['extra'] });
    expect(draft.items.find((i) => i.catalogId === 'extra')).toMatchObject({
      tier: 'core',
      origin: 'must_include',
    });
  });

  it('applies priority overrides to the tier', () => {
    const draft = build(basicCatalog(), {
      priorityOverrides: { 'c-s1': 'optional', 'c-s3': 'core' },
    });
    const tier = (id: string) => draft.items.find((i) => i.catalogId === id)?.tier;
    expect(tier('c-s1')).toBe('optional');
    expect(tier('c-s3')).toBe('core');
    expect(tier('c-s2')).toBe('core');
  });

  it('marks items that teach a skill the user asked for by name as core', () => {
    const catalog = catalogOf(
      [item({ id: 'x', skills: ['s4'] })],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 1 }] })],
    );
    const draft = build(catalog, { extraSkillIds: ['s4'] });
    expect(draft.items[0]).toMatchObject({ catalogId: 'x', tier: 'core' });
    expect(draft.items[0]?.why).toBe('You asked to learn Skill s4.');
  });

  it('selectCourses leaves covered skills alone (called directly)', () => {
    const ctx = createContext({ today: TODAY, request: request() }, basicCatalog());
    const roots = selectCourses(ctx, new ExclusionLog());
    expect(roots.map((r) => r.id).sort()).toEqual(['c-s1', 'c-s2', 'c-s3']);
  });
});

describe('step 4: prerequisites', () => {
  const chain = () =>
    catalogOf(
      [
        item({ id: 'base', skills: ['s9'], est_hours: 2 }),
        item({
          id: 'mid',
          skills: ['s8'],
          prerequisites: ['base'],
          prerequisite_kinds: { base: 'required' },
          est_hours: 3,
        }),
        item({
          id: 'top',
          skills: ['s1'],
          prerequisites: ['mid'],
          prerequisite_kinds: { mid: 'required' },
          est_hours: 4,
        }),
        item({
          id: 'hint',
          skills: ['s7'],
          est_hours: 1,
        }),
        item({
          id: 'with-hint',
          skills: ['s2'],
          prerequisites: ['hint'],
          prerequisite_kinds: { hint: 'recommended' },
          est_hours: 4,
        }),
      ],
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

  it('adds every transitive required prerequisite and orders prerequisites first', () => {
    const draft = build(chain());
    expect(itemIds(draft)).toEqual(expect.arrayContaining(['base', 'mid', 'top']));
    const order = (id: string) => task(draft, `c-${id}`).order;
    expect(order('base')).toBeLessThan(order('mid'));
    expect(order('mid')).toBeLessThan(order('top'));
    expect(task(draft, 'c-top').dependsOn).toEqual(['c-mid']);
    expect(task(draft, 'c-mid').dependsOn).toEqual(['c-base']);
    expect(draft.items.find((i) => i.catalogId === 'base')).toMatchObject({
      origin: 'prerequisite',
      tier: 'optional',
    });
    expect(draft.items.find((i) => i.catalogId === 'mid')?.why).toBe('Required before Item top.');
  });

  it('gives a prerequisite the tier and priority of what needs it', () => {
    const draft = build(chain(), { priorityOverrides: { top: 'core' } });
    expect(draft.items.find((i) => i.catalogId === 'base')?.tier).toBe('core');
  });

  it('does not add a recommended prerequisite alone, but orders it first when both are present', () => {
    const alone = build(chain());
    expect(itemIds(alone)).not.toContain('hint');
    const both = build(chain(), { mustInclude: ['hint'] });
    expect(task(both, 'c-with-hint').dependsOn).toEqual(['c-hint']);
    expect(task(both, 'c-hint').order).toBeLessThan(task(both, 'c-with-hint').order);
  });

  it('skips a course prerequisite whose skills the user rated Comfortable, and says so', () => {
    const draft = build(chain(), { skillLevels: { s8: 2 } });
    expect(itemIds(draft)).toContain('top');
    expect(itemIds(draft)).not.toContain('mid');
    expect(itemIds(draft)).not.toContain('base');
    expect(draft.skippedPrerequisites).toEqual([
      { catalogId: 'mid', message: 'Skipped "Item mid": you rated Skill s8 Comfortable.' },
    ]);
    expect(task(draft, 'c-top').dependsOn).toEqual([]);
  });

  it('never skips the prerequisites of an exam, whatever the profile says', () => {
    const catalog = catalogOf(
      [
        item({ id: 'prep-course', skills: ['s8'], est_hours: 5 }),
        item({
          id: 'the-exam',
          type: 'cert_exam',
          cost_type: 'free',
          skills: ['s1'],
          est_hours: 1,
          certificate_type: 'official_exam',
          prerequisites: ['prep-course'],
          prerequisite_kinds: { 'prep-course': 'required' },
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const draft = build(catalog, { certPreference: 'must', skillLevels: { s8: 3 } });
    expect(itemIds(draft)).toEqual(expect.arrayContaining(['prep-course', 'the-exam']));
    expect(draft.skippedPrerequisites).toEqual([]);
  });

  it('drops an item whose required prerequisite is outside the budget, and reports it', () => {
    const catalog = catalogOf(
      [
        item({ id: 'paid-base', skills: ['s9'], cost_type: 'one_time', price: 50 }),
        item({
          id: 'wants-base',
          skills: ['s1'],
          prerequisites: ['paid-base'],
          prerequisite_kinds: { 'paid-base': 'required' },
        }),
        item({ id: 'alone', skills: ['s1'], est_hours: 9 }),
      ],
      [
        role({
          id: 'role-a',
          skills: [{ skill: 's1', weight: 5 }],
          suggested_path: { core: ['wants-base'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const draft = build(catalog, { budget: { mode: 'free' } });
    expect(itemIds(draft)).toEqual(['alone']);
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({
        catalogId: 'wants-base',
        reason: 'needs_prerequisite',
        relatedId: 'paid-base',
        message: 'Needs "Item paid-base", which is not free; "Item wants-base" is left out.',
      }),
    );
  });

  it('applies the item filter to the prerequisite of an exam as well', () => {
    const ctx = createContext(
      { today: TODAY, request: request({ budget: { mode: 'limit', amount: 40 } }) },
      catalogOf(
        [
          item({ id: 'dear', cost_type: 'one_time', price: 60 }),
          item({
            id: 'e',
            type: 'cert_exam',
            prerequisites: ['dear'],
            prerequisite_kinds: { dear: 'required' },
          }),
        ],
        [role({ id: 'role-a' })],
      ),
    );
    const closure = closureOf(ctx, ctx.index.byId.get('e')!);
    expect(closure).toMatchObject({ ok: false, reason: 'over_budget', relatedId: 'dear' });
  });
});

describe('budget filter', () => {
  const paid = item({ id: 'p', cost_type: 'one_time', price: 80 });
  const unknown = item({ id: 'u', cost_type: 'one_time', price: null });
  const audit = item({ id: 'a', cost_type: 'free_audit', price: 0, certificate_price: 49 });

  it('free: only free and free_audit items', () => {
    const b = { mode: 'free' as const };
    expect(itemBudgetReason(paid, b)).toBe('free_only');
    expect(itemBudgetReason(unknown, b)).toBe('free_only');
    expect(itemBudgetReason(audit, b)).toBeNull();
    expect(certificateBudgetReason(audit, b)).toBe('free_only');
  });

  it('limit: the price must be known and not above the limit; flexible keeps an unknown price', () => {
    expect(itemBudgetReason(paid, { mode: 'limit', amount: 100 })).toBeNull();
    expect(itemBudgetReason(paid, { mode: 'limit', amount: 70 })).toBe('over_budget');
    expect(itemBudgetReason(unknown, { mode: 'limit', amount: 100 })).toBe('price_unknown');
    expect(itemBudgetReason(unknown, { mode: 'flexible' })).toBeNull();
  });

  it('maxItemPrice is a per-item cap in every mode', () => {
    expect(itemBudgetReason(paid, { mode: 'flexible', maxItemPrice: 79 })).toBe('over_item_price');
    expect(itemBudgetReason(paid, { mode: 'flexible', maxItemPrice: 80 })).toBeNull();
    expect(certificateBudgetReason(audit, { mode: 'flexible', maxItemPrice: 30 })).toBe(
      'over_item_price',
    );
  });

  it('a free_audit item costs nothing', () => {
    expect(effectivePrice(audit)).toBe(0);
    expect(effectivePrice(unknown)).toBeNull();
  });
});

describe('request checks', () => {
  it('rejects unknown ids, a deadline that is not after the start, and a past deadline', () => {
    const cat = basicCatalog();
    const issues = (o: Parameters<typeof request>[0]) => {
      try {
        buildPlan({ today: TODAY, request: request(o) }, cat);
        return [];
      } catch (e) {
        if (e instanceof BuildRequestError) return e.issues.map((i) => i.code);
        throw e;
      }
    };
    expect(issues({ targetRoleIds: ['nope'] })).toEqual(['unknown_role']);
    expect(issues({ extraSkillIds: ['nope'] })).toEqual(['unknown_skill']);
    expect(issues({ exclude: ['nope'] })).toEqual(['unknown_catalog_id']);
    expect(issues({ deadline: '2026-11-03' })).toEqual(['deadline_not_after_start']);
    expect(issues({ startDate: '2026-10-01', deadline: '2026-10-20' })).toEqual([
      'deadline_in_past',
    ]);
    expect(issues({ certificateOptIns: ['c-s1'] })).toEqual(['not_a_certificate']);
  });
});
