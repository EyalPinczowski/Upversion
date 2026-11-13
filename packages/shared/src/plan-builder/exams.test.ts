import { describe, expect, it } from 'vitest';
import { catalogOf, item, role, build, itemIds, task, hasTask, buildReal } from './test-fixtures';

/** One role that wants s1, with exams and courses of fictional names. */
function examCatalog(
  exam: Partial<Parameters<typeof item>[0]> = {},
  extra: ReturnType<typeof item>[] = [],
) {
  return catalogOf(
    [
      item({
        id: 'ex',
        type: 'cert_exam',
        cost_type: 'one_time',
        price: 100,
        skills: ['s1'],
        est_hours: 20,
        certificate_type: 'official_exam',
        recognition: 'high',
        ...exam,
      }),
      ...extra,
    ],
    [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
  );
}

describe('step 5: exams', () => {
  it('an exam of at most 2 hours is one non-splittable block of its own length, plus a booking', () => {
    const draft = build(examCatalog({ est_hours: 1.5 }), { certPreference: 'must' });
    const exam = task(draft, 'x-ex');
    expect(exam).toMatchObject({
      type: 'cert_exam',
      estHours: 1.5,
      splittable: false,
      isCertificate: true,
      externalRef: 'catalog:ex',
      source: 'builder',
    });
    expect(hasTask(draft, 'p-ex')).toBe(false);
    expect(task(draft, 'b-ex')).toMatchObject({ type: 'admin', estHours: 0.25 });
    expect(exam.dependsOn).toContain('b-ex');
    expect(exam.notes).toContain("Needs check: exam length – see the provider's page.");
    expect(task(draft, 'b-ex').order).toBeLessThan(exam.order);
  });

  it('a longer exam is a preparation task, a 2 h exam block and a booking', () => {
    const draft = build(examCatalog({ est_hours: 20 }), { certPreference: 'must' });
    expect(task(draft, 'p-ex')).toMatchObject({
      type: 'course',
      splittable: true,
      estHours: 18,
      title: 'Prepare for Item ex',
    });
    expect(task(draft, 'x-ex')).toMatchObject({
      type: 'cert_exam',
      estHours: 2,
      splittable: false,
      title: 'Item ex – exam',
    });
    expect(task(draft, 'x-ex').dependsOn).toEqual(['p-ex', 'b-ex']);
    expect(task(draft, 'b-ex').title).toBe('Book the Item ex exam');
    const orders = ['p-ex', 'b-ex', 'x-ex'].map((id) => task(draft, id).order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('subtracts the hours of its required course prerequisites, with a 1 hour floor', () => {
    const prereq = (h: number) => item({ id: 'pre', skills: ['s9'], est_hours: h });
    const withPre = (examHours: number, preHours: number) =>
      build(
        examCatalog(
          { est_hours: examHours, prerequisites: ['pre'], prerequisite_kinds: { pre: 'required' } },
          [prereq(preHours)],
        ),
        { certPreference: 'must' },
      );
    expect(task(withPre(20, 6), 'p-ex').estHours).toBe(12); // 20 - 2 - 6
    expect(task(withPre(8, 10), 'p-ex').estHours).toBe(1); // floor
    expect(task(withPre(20, 6), 'x-ex').estHours).toBe(2);
  });

  it('is an anchor only when the request gives the exam a date', () => {
    const cat = examCatalog({ est_hours: 20 });
    const without = build(cat, { certPreference: 'must' });
    expect(task(without, 'x-ex').isAnchor).toBe(false);
    const withDate = build(cat, {
      certPreference: 'must',
      deadline: '2026-12-20',
      examDates: [{ catalogId: 'ex', date: '2026-12-10', start: '10:00' }],
    });
    expect(task(withDate, 'x-ex')).toMatchObject({
      isAnchor: true,
      anchorDate: '2026-12-10',
      anchorStartTime: '10:00',
    });
    // An exam date is itself a request for that exam.
    const onlyDate = build(cat, {
      certPreference: 'none',
      deadline: '2026-12-20',
      examDates: [{ catalogId: 'ex', date: '2026-12-10', start: '10:00' }],
    });
    expect(itemIds(onlyDate)).toContain('ex');
  });

  it('does the prerequisites of an exam with a fixed date first, so they are done in time', () => {
    const catalog = catalogOf(
      [
        item({ id: 'a-big', skills: ['s2'], est_hours: 30 }),
        item({ id: 'pre', skills: ['s9'], est_hours: 5 }),
        item({
          id: 'ex',
          type: 'cert_exam',
          cost_type: 'free',
          price: 0,
          skills: ['s1'],
          est_hours: 1,
          certificate_type: 'skills_test',
          prerequisites: ['pre'],
          prerequisite_kinds: { pre: 'required' },
        }),
      ],
      [
        role({
          id: 'role-a',
          skills: [
            { skill: 's1', weight: 3 },
            { skill: 's2', weight: 5 },
          ],
          suggested_path: { core: ['a-big'], optional: [], practice: [], free_only: [] },
        }),
      ],
    );
    const plain = build(catalog, { certificateOptIns: ['ex'] });
    expect(task(plain, 'c-a-big').order).toBeLessThan(task(plain, 'c-pre').order);
    const anchored = build(catalog, {
      deadline: '2026-12-20',
      examDates: [{ catalogId: 'ex', date: '2026-11-10', start: '10:00' }],
    });
    expect(task(anchored, 'c-pre').order).toBeLessThan(task(anchored, 'c-a-big').order);
    expect(anchored.fits).toBe(true);
  });

  it('certificates: must includes the best exam per role, nice offers, none neither', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'low',
          type: 'cert_exam',
          cost_type: 'one_time',
          price: 50,
          skills: ['s1'],
          est_hours: 1,
          recognition: 'low',
        }),
        item({
          id: 'high',
          type: 'cert_exam',
          cost_type: 'one_time',
          price: 90,
          skills: ['s1'],
          est_hours: 1,
          recognition: 'high',
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const must = build(catalog, { certPreference: 'must' });
    expect(itemIds(must)).toEqual(['high']);
    expect(must.items[0]).toMatchObject({ origin: 'certificate', tier: 'core' });
    expect(must.summary.certificatesOffered.map((c) => c.catalogId)).toEqual(['low']);
    expect(must.summary.certificatesIncluded).toEqual(['high']);

    const nice = build(catalog, { certPreference: 'nice' });
    expect(itemIds(nice)).toEqual([]);
    expect(nice.summary.certificatesOffered.map((c) => c.catalogId)).toEqual(['high', 'low']);

    const none = build(catalog, { certPreference: 'none' });
    expect(itemIds(none)).toEqual([]);
    expect(none.summary.certificatesOffered).toEqual([]);
  });

  it('includes an opted-in exam even when certificates are not wanted', () => {
    const draft = build(examCatalog({ est_hours: 1 }), {
      certPreference: 'none',
      certificateOptIns: ['ex'],
    });
    expect(itemIds(draft)).toEqual(['ex']);
    expect(draft.items[0]).toMatchObject({ origin: 'opt_in', isCertificate: true });
  });

  it('a prerequisite exam is its own exam with its own booking and cost, not taken off the preparation', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'basic',
          type: 'cert_exam',
          cost_type: 'one_time',
          price: 30,
          est_hours: 1,
          skills: ['s9'],
          certificate_type: 'skills_test',
        }),
        item({
          id: 'adv',
          type: 'cert_exam',
          cost_type: 'one_time',
          price: 70,
          est_hours: 10,
          skills: ['s1'],
          recognition: 'high',
          certificate_type: 'official_exam',
          prerequisites: ['basic'],
          prerequisite_kinds: { basic: 'required' },
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const draft = build(catalog, { certPreference: 'must' });
    expect(itemIds(draft).sort()).toEqual(['adv', 'basic']);
    expect(hasTask(draft, 'b-basic')).toBe(true);
    expect(task(draft, 'x-basic').estHours).toBe(1);
    expect(task(draft, 'p-adv').estHours).toBe(8); // 10 - 2, the exam is not subtracted
    expect(task(draft, 'p-adv').dependsOn).toEqual(['x-basic']);
    expect(task(draft, 'x-adv').dependsOn).toContain('p-adv');
    expect(draft.summary.cost.total).toBe(100);
  });

  it('puts a paid exam out of a free-only plan and a paid certificate out of the opt-ins', () => {
    const draft = build(examCatalog({ est_hours: 1 }), {
      certPreference: 'must',
      budget: { mode: 'free' },
      certificateOptIns: ['ex'],
    });
    expect(itemIds(draft)).toEqual([]);
    expect(draft.excluded).toContainEqual(
      expect.objectContaining({ catalogId: 'ex', reason: 'free_only' }),
    );
  });

  it('adds the paid certificate of a free_audit course only on opt-in', () => {
    const catalog = catalogOf(
      [
        item({
          id: 'aud',
          skills: ['s1'],
          cost_type: 'free_audit',
          price: 0,
          certificate_price: 49,
          certificate_type: 'completion',
        }),
      ],
      [role({ id: 'role-a', skills: [{ skill: 's1', weight: 5 }] })],
    );
    const plain = build(catalog, { certPreference: 'nice' });
    expect(plain.summary.cost.total).toBe(0);
    expect(task(plain, 'c-aud').isCertificate).toBe(false);
    expect(plain.summary.certificatesOffered).toEqual([
      expect.objectContaining({ catalogId: 'aud', price: 49 }),
    ]);

    const opted = build(catalog, { certificateOptIns: ['aud'] });
    expect(opted.summary.cost.total).toBe(49);
    expect(task(opted, 'c-aud')).toMatchObject({
      isCertificate: true,
      certificateName: 'Item aud (paid certificate)',
    });
    expect(opted.items[0]?.cost).toEqual({ amount: 49, kind: 'certificate' });

    const free = build(catalog, { certificateOptIns: ['aud'], budget: { mode: 'free' } });
    expect(free.summary.cost.total).toBe(0);
    expect(task(free, 'c-aud').isCertificate).toBe(false);
  });

  it('never creates cv_update tasks (the tasks module does that when a certificate is completed)', () => {
    const draft = build(examCatalog({ est_hours: 20 }), { certPreference: 'must' });
    expect(draft.plan.tasks.some((t) => t.type === 'cv_update')).toBe(false);
  });
});

describe('ADR examples on the real catalog', () => {
  it('capm: preparation is 1 h because its prerequisite course is 60 h', () => {
    const draft = buildReal({
      targetRoleIds: ['project-coordinator'],
      certificateOptIns: ['capm'],
      budget: { mode: 'flexible' },
      deadline: '2027-06-30',
    });
    expect(itemIds(draft)).toEqual(expect.arrayContaining(['capm', 'google-project-management']));
    expect(task(draft, 'p-capm').estHours).toBe(1);
    expect(task(draft, 'x-capm')).toMatchObject({ estHours: 2, splittable: false });
    expect(task(draft, 'p-capm').dependsOn).toEqual(['c-google-project-management']);
  });

  it('pl-300: preparation is its estimate minus 2 h minus its prerequisite course', () => {
    const draft = buildReal({
      targetRoleIds: ['data-analyst'],
      certificateOptIns: ['pl-300'],
      budget: { mode: 'flexible' },
      deadline: '2027-06-30',
    });
    // pl-300 is 80 h; its required course power-bi-learn-path is 30 h.
    expect(task(draft, 'c-power-bi-learn-path').estHours).toBe(30);
    expect(task(draft, 'p-pl-300').estHours).toBe(48);
    expect(task(draft, 'x-pl-300').estHours).toBe(2);
    // pl-300 has no price in the catalog: it is not counted and the draft says so.
    expect(draft.summary.cost.pricesToCheck).toBeGreaterThanOrEqual(1);
    expect(task(draft, 'x-pl-300').notes).toContain('Price varies');
  });

  it('hackerrank-sql-intermediate brings hackerrank-sql-basic as its own exam', () => {
    const draft = buildReal({
      targetRoleIds: ['data-analyst'],
      certificateOptIns: ['hackerrank-sql-intermediate'],
      budget: { mode: 'free' },
      deadline: '2027-06-30',
    });
    expect(itemIds(draft)).toEqual(
      expect.arrayContaining([
        'hackerrank-sql-intermediate',
        'hackerrank-sql-basic',
        'kaggle-advanced-sql',
      ]),
    );
    expect(hasTask(draft, 'b-hackerrank-sql-basic')).toBe(true);
    expect(hasTask(draft, 'b-hackerrank-sql-intermediate')).toBe(true);
    expect(task(draft, 'x-hackerrank-sql-intermediate').dependsOn).toEqual(
      expect.arrayContaining(['x-hackerrank-sql-basic', 'c-kaggle-advanced-sql']),
    );
    // Both are one short exam block (at most 2 h): no preparation task.
    expect(hasTask(draft, 'p-hackerrank-sql-intermediate')).toBe(false);
  });

  it('psm-1 is a single short exam block with its prerequisites before it', () => {
    const draft = buildReal({
      targetRoleIds: ['project-coordinator'],
      certificateOptIns: ['psm-1'],
      budget: { mode: 'flexible' },
      deadline: '2027-06-30',
    });
    expect(hasTask(draft, 'p-psm-1')).toBe(false);
    expect(task(draft, 'x-psm-1')).toMatchObject({
      estHours: 1,
      splittable: false,
      isCertificate: true,
    });
    expect(task(draft, 'x-psm-1').dependsOn).toEqual(
      expect.arrayContaining(['b-psm-1', 'c-scrum-guide', 'c-scrum-open']),
    );
    // scrum-open has an unverified link: no url, and a note.
    expect(task(draft, 'c-scrum-open').url).toBeUndefined();
    expect(task(draft, 'c-scrum-open').notes).toContain('Needs check: link');
  });
});

describe('thin catalog data on the real catalog', () => {
  it('lists the gaps of a free-only Technical Writer plan instead of padding it', () => {
    const draft = buildReal({ targetRoleIds: ['technical-writer'], budget: { mode: 'free' } });
    const gaps = draft.summary.skillsNotCovered.filter((s) => s.reason === 'catalog_gap');
    expect(gaps.map((g) => g.skillId)).toEqual(expect.arrayContaining(['git', 'ux-basics']));
    expect(draft.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['thin_role', 'catalog_gap']),
    );
    // Nothing paid and nothing invented: every item is a catalog item that costs nothing.
    expect(draft.summary.cost.total).toBe(0);
  });

  it('warns that a role with no free-only item has none', () => {
    const draft = buildReal({
      targetRoleIds: ['learning-development-coordinator'],
      budget: { mode: 'free' },
    });
    expect(draft.warnings.map((w) => w.code)).toContain('no_free_items');
  });
});
