import { describe, expect, it } from 'vitest';
import { compareDates } from '../dates';
import { parsePlanFile, WeekPatternSchema } from '../schemas';
import { schedule } from '../scheduling/engine';
import { buildPlan } from './build';
import { BUNDLED_CATALOG } from './bundled';
import type { CatalogItem } from './catalog';
import { BuildDraftSchema, type BuildDraft, type BuildRequestInput } from './schemas';
import {
  NEEDS_CHECK_EXAM_LENGTH,
  NEEDS_CHECK_LINK,
  NEEDS_CHECK_PRICE,
  PRICE_VARIES,
} from './tasks';

/** Seeded generator (mulberry32): the same numbers on every run, no Math.random. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TODAY = '2026-11-02';
const items = new Map(BUNDLED_CATALOG.items.map((i) => [i.id, i]));
const roles = BUNDLED_CATALOG.roles;

function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

function pattern(hours: number): BuildRequestInput['weekPattern'] {
  return {
    studyWeekdays: [0, 1, 2, 3, 4],
    defaultHours: hours,
    windowStart: '09:00',
    windowEnd: '17:30',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    timezone: 'Asia/Jerusalem',
  };
}

type Profile = 'novice' | 'mixed' | 'expert';
function levels(roleId: string, profile: Profile, random: () => number): Record<string, number> {
  const role = roles.find((r) => r.id === roleId)!;
  const out: Record<string, number> = {};
  for (const s of role.skills) {
    out[s.skill] =
      profile === 'novice'
        ? 0
        : profile === 'expert'
          ? 2 + Math.floor(random() * 2)
          : Math.floor(random() * 4);
  }
  return out;
}

interface Scenario {
  name: string;
  make: (roleId: string, random: () => number) => BuildRequestInput;
}

const base = (roleId: string): Pick<BuildRequestInput, 'targetRoleIds' | 'startDate'> => ({
  targetRoleIds: [roleId],
  startDate: '2026-11-03',
});

const scenarios: Scenario[] = [
  {
    name: 'free, novice, 4 weeks, 3 h, interview prep',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'novice', rnd),
      deadline: addDaysIso('2026-11-03', 28),
      weekPattern: pattern(3),
      budget: { mode: 'free' },
      certPreference: 'none',
      interviewPrep: 'yes',
    }),
  },
  {
    name: 'limit 100, mixed, 8 weeks, 2 h, certificates a must, practice later',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'mixed', rnd),
      deadline: addDaysIso('2026-11-03', 56),
      weekPattern: pattern(2),
      budget: { mode: 'limit', amount: 100 },
      certPreference: 'must',
      interviewPrep: 'later',
    }),
  },
  {
    name: 'flexible, novice, 8 weeks, 4 h, certificates a must',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'novice', rnd),
      deadline: addDaysIso('2026-11-03', 56),
      weekPattern: pattern(4),
      budget: { mode: 'flexible' },
      certPreference: 'must',
      interviewPrep: 'yes',
    }),
  },
  {
    name: 'free, mixed, 2 weeks, 2 h, certificates nice',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'mixed', rnd),
      deadline: addDaysIso('2026-11-03', 14),
      weekPattern: pattern(2),
      budget: { mode: 'free' },
      certPreference: 'nice',
      interviewPrep: 'no',
    }),
  },
  {
    name: 'limit 100 and 50 per item, novice, 4 weeks, certificates a must',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'novice', rnd),
      deadline: addDaysIso('2026-11-03', 28),
      weekPattern: pattern(3),
      budget: { mode: 'limit', amount: 100, maxItemPrice: 50 },
      certPreference: 'must',
      interviewPrep: 'yes',
    }),
  },
  {
    name: 'flexible, expert, 4 weeks',
    make: (r, rnd) => ({
      ...base(r),
      skillLevels: levels(r, 'expert', rnd),
      deadline: addDaysIso('2026-11-03', 28),
      weekPattern: pattern(3),
      budget: { mode: 'flexible' },
      certPreference: 'must',
      interviewPrep: 'yes',
    }),
  },
];

/** Sentences a task note may consist of, once catalog names are replaced by <N>. */
const SENTENCES: RegExp[] = [
  /^Teaches [^.]+ – the role weights (it|them) \d(–\d)? and you rated (it|them) [A-Za-z ]+\.$/,
  /^You asked to learn [^.]+\.$/,
  /^Part of the suggested path for [^.]+\.$/,
  /^Required before [^.]+\.$/,
  /^Practice for interviews \(you asked for interview prep\)\.$/,
  /^You chose to add (this exam|the certificate for this course)\.$/,
  /^You asked to include this item\.$/,
  /^A free alternative to a paid item that was over your budget\.$/,
  /^Official exam for [^.]+; you asked for certificates\.$/,
  /^Official exam; you asked for certificates\.$/,
  /^Preparation for the exam; the exam itself is a separate task\.$/,
  /^A practice task from the catalog; no outside link is needed\.$/,
  /^Price per catalog: (free|\d+(\.\d+)? USD( per (month|year))?) \(prices change; re-check before (paying|relying on it)\)\.$/,
  /^Needs check: certificate fee \(\d+(\.\d+)? USD per catalog, not verified\)\.$/,
  /^Certificate fee varies – check the price on the provider’s page\.$/,
  /^Pick a date and book the exam on the provider's own page\.$/,
  /^Create the accounts the plan needs and prepare a folder for notes and exercises\.$/,
  /^Look back at what you finished and check next week's tasks\.$/,
];
const FIXED = new Set([NEEDS_CHECK_LINK, NEEDS_CHECK_PRICE, NEEDS_CHECK_EXAM_LENGTH, PRICE_VARIES]);

const NAMES = [
  ...BUNDLED_CATALOG.items.map((i) => i.title),
  ...BUNDLED_CATALOG.skills.map((s) => s.name),
  ...BUNDLED_CATALOG.roles.map((r) => r.title),
].sort((a, b) => b.length - a.length);

function templateProblems(note: string): string[] {
  let text = note;
  for (const name of NAMES) text = text.split(name).join('<N>');
  const bad: string[] = [];
  for (const sentence of text.split(/(?<=\.) (?=[A-Z])/)) {
    if (FIXED.has(sentence)) continue;
    if (!SENTENCES.some((re) => re.test(sentence))) bad.push(sentence);
  }
  return bad;
}

function catalogItemOf(ref: string | undefined): CatalogItem | undefined {
  return ref?.startsWith('catalog:') ? items.get(ref.slice(8)) : undefined;
}

function checkDraft(draft: BuildDraft, req: BuildRequestInput, label: string): void {
  const where = (msg: string) => `${label}: ${msg}`;

  // The plan is a normal plan file, and the engine can schedule it.
  const roundTrip = JSON.parse(JSON.stringify(draft)) as BuildDraft;
  expect(() => parsePlanFile(roundTrip.plan), where('parsePlanFile')).not.toThrow();
  expect(() => BuildDraftSchema.parse(roundTrip), where('BuildDraftSchema')).not.toThrow();
  const tasks = draft.plan.tasks;
  const titles = req.targetRoleIds.map((id) => roles.find((r) => r.id === id)!.title).join(' + ');
  expect(draft.plan.name, where('plan name')).toBe(`${titles} plan`);
  const ids = new Set(tasks.map((t) => t.id));
  expect(ids.size, where('unique task ids')).toBe(tasks.length);
  expect(
    tasks.some((t) => t.type === 'cv_update'),
    where('no cv_update'),
  ).toBe(false);
  expect(
    tasks.map((t) => t.order),
    where('orders are positions'),
  ).toEqual(tasks.map((_, i) => i));

  // Sources: a link is shown only when verified; anything else says "Needs check".
  for (const t of tasks) {
    const item = catalogItemOf(t.externalRef);
    if (t.type === 'admin') {
      expect(t.url, where(`${t.id} admin has no url`)).toBeUndefined();
      const bookedExam = catalogItemOf(t.externalRef);
      const adminTitles = [
        'Set up learning accounts and study workspace',
        ...(bookedExam ? [`Book the ${bookedExam.title} exam`] : []),
      ];
      expect(
        adminTitles.includes(t.title) || /^Weekly review \d+$/.test(t.title),
        where(`${t.id} admin title is a template`),
      ).toBe(true);
      continue;
    }
    expect(item, where(`${t.id} refers to a catalog item`)).toBeDefined();
    if (!item) continue;
    expect(
      [item.title, `Prepare for ${item.title}`, `${item.title} \u2013 exam`],
      where(`${t.id} title is from the catalog`),
    ).toContain(t.title);
    if (t.url !== undefined) {
      expect(item.url_verified, where(`${t.id} url only when verified`)).toBe(true);
      expect(t.url).toBe(item.url);
    } else if (item.type !== 'practice') {
      expect(t.notes ?? '', where(`${t.id} flagged`)).toContain('Needs check: link');
    }
    if (item.url_verified === false)
      expect(t.url, where(`${t.id} no unverified url`)).toBeUndefined();
    expect(t.lessons, where('no lessons')).toEqual([]);
    if (!item.price_verified && item.type !== 'practice' && t.type !== 'course' ? true : false) {
      expect(t.notes ?? '').toMatch(/Needs check: price not verified|Price varies/);
    }
    if (
      item.price_verified &&
      item.price !== null &&
      item.cost_type !== 'free' &&
      item.cost_type !== 'free_audit'
    ) {
      expect(t.notes ?? '', where('verified price shown per catalog')).not.toContain(
        'price not verified',
      );
    }
  }

  // Notes are fixed templates filled with catalog names and numbers.
  for (const t of tasks) {
    if (t.notes) expect(templateProblems(t.notes), where(`${t.id} note is a template`)).toEqual([]);
  }
  for (const i of draft.items) {
    expect(templateProblems(i.why), where(`${i.catalogId} why`)).toEqual([]);
    const cat = items.get(i.catalogId)!;
    expect(i.needsCheckLink, where('needsCheckLink matches')).toBe(
      !(cat.url !== null && cat.url_verified) && !(cat.type === 'practice' && cat.url === null),
    );
  }

  // Dependencies exist and come first.
  const orderOf = new Map(tasks.map((t) => [t.id, t.order]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      expect(orderOf.has(d), where(`${t.id} depends on a task in the plan`)).toBe(true);
      expect(orderOf.get(d)!, where(`${t.id} after ${d}`)).toBeLessThan(t.order);
    }
  }

  // Required prerequisites are in the plan or reported as skipped.
  const present = new Set(draft.items.map((i) => i.catalogId));
  const skipped = new Set(draft.skippedPrerequisites.map((s) => s.catalogId));
  for (const id of present) {
    const cat = items.get(id)!;
    for (const p of cat.prerequisites) {
      if (cat.prerequisite_kinds[p] === 'recommended') continue;
      expect(present.has(p) || skipped.has(p), where(`${id} needs ${p}`)).toBe(true);
    }
  }

  // The engine: every dependency finishes before its dependent starts, and a plan that fits finishes in time.
  const from = draft.summary.scheduleFrom;
  const result = schedule({
    tasks: draft.plan.tasks,
    pattern: WeekPatternSchema.parse(draft.plan.weekPattern),
    today: from,
  });
  const firstStart = new Map<string, string>();
  const lastEnd = new Map<string, string>();
  for (const b of result.blocks) {
    const s = `${b.date} ${b.start}`;
    const e = `${b.date} ${b.end}`;
    if (!firstStart.has(b.taskId) || s < (firstStart.get(b.taskId) as string))
      firstStart.set(b.taskId, s);
    if (!lastEnd.has(b.taskId) || e > (lastEnd.get(b.taskId) as string)) lastEnd.set(b.taskId, e);
  }
  for (const t of tasks) {
    if (t.isAnchor) continue; // the engine puts an anchor at its date and warns when its tasks are late
    for (const d of t.dependsOn) {
      const start = firstStart.get(t.id);
      const end = lastEnd.get(d);
      if (start && end) expect(end <= start, where(`${d} ends before ${t.id} starts`)).toBe(true);
    }
  }
  if (draft.fits) {
    expect(
      result.warnings.filter((w) => w.kind !== 'over_capacity'),
      where('no blocking engine warnings when it fits'),
    ).toEqual([]);
    expect(
      compareDates(result.finishDate as string, req.deadline),
      where('finish <= deadline'),
    ).toBeLessThanOrEqual(0);
    expect(draft.options).toBeNull();
  } else {
    expect(draft.options, where('options when it does not fit')).not.toBeNull();
    expect(draft.warnings.some((w) => w.code === 'schedule')).toBe(true);
  }

  // Budget.
  const { budget } = req;
  if (budget.mode === 'free') {
    expect(draft.summary.cost.total, where('free total')).toBe(0);
    for (const i of draft.items) {
      const cat = items.get(i.catalogId)!;
      expect(['free', 'free_audit'], where(`${i.catalogId} is free`)).toContain(cat.cost_type);
      expect(i.cost.kind, where(`${i.catalogId} no paid certificate`)).toBe('free');
    }
  }
  if (budget.mode === 'limit') {
    expect(
      draft.overBudget || draft.summary.cost.total <= (budget.amount as number),
      where('total within the limit'),
    ).toBe(true);
    for (const i of draft.items) {
      expect(
        items.get(i.catalogId)!.price,
        where(`${i.catalogId} price is known under a limit`),
      ).not.toBeNull();
    }
  }
  if (budget.maxItemPrice !== undefined) {
    for (const i of draft.items) {
      const cat = items.get(i.catalogId)!;
      if (cat.cost_type === 'one_time' || cat.cost_type === 'subscription') {
        expect(cat.price ?? 0, where(`${i.catalogId} within the per-item cap`)).toBeLessThanOrEqual(
          budget.maxItemPrice,
        );
      }
    }
  }
  // Over budget must come with the items to remove. On the real catalog a plan that fits is never
  // over budget (its months come from a real schedule). A plan that does not fit can be: its
  // subscription runs past the deadline, which the cost of the truncated schedule cannot show.
  if (draft.overBudget) expect(draft.removeToFit.length, where('removeToFit')).toBeGreaterThan(0);
  if (draft.fits) expect(draft.overBudget, where('a plan that fits is within budget')).toBe(false);
}

describe('property: every role x profile x budget x deadline', () => {
  roles.forEach((role, roleIndex) => {
    it(`${role.id}`, () => {
      scenarios.forEach((scenario, si) => {
        const random = rng(roleIndex * 100 + si);
        const req = scenario.make(role.id, random);
        const label = `${role.id} / ${scenario.name}`;
        const draft = buildPlan({ today: TODAY, request: req }, BUNDLED_CATALOG);
        checkDraft(draft, req, label);

        // Determinism: the same input gives the same bytes, also with the catalog in another order.
        const again = buildPlan({ today: TODAY, request: req }, BUNDLED_CATALOG);
        expect(JSON.stringify(again), `${label}: determinism`).toBe(JSON.stringify(draft));
        if (si % 2 === 1) {
          const shuffle = rng(si + roleIndex);
          const shuffled = [...BUNDLED_CATALOG.items].sort(() => shuffle() - 0.5);
          const other = buildPlan(
            { today: TODAY, request: req },
            { ...BUNDLED_CATALOG, items: shuffled },
          );
          expect(JSON.stringify(other), `${label}: catalog order`).toBe(JSON.stringify(draft));
        }
      });
    }, 30_000);
  });

  it('two target roles at once', () => {
    for (let i = 0; i + 1 < roles.length; i += 5) {
      const a = roles[i]!.id;
      const b = roles[i + 1]!.id;
      const req: BuildRequestInput = {
        targetRoleIds: [a, b],
        startDate: '2026-11-03',
        deadline: addDaysIso('2026-11-03', 56),
        weekPattern: pattern(3),
        budget: { mode: 'limit', amount: 150 },
        certPreference: 'must',
        interviewPrep: 'yes',
      };
      checkDraft(buildPlan({ today: TODAY, request: req }, BUNDLED_CATALOG), req, `${a}+${b}`);
    }
  }, 30_000);

  it('an exam date makes an anchor, and the plan still parses', () => {
    const req: BuildRequestInput = {
      targetRoleIds: ['data-analyst'],
      startDate: '2026-11-03',
      deadline: addDaysIso('2026-11-03', 90),
      weekPattern: pattern(4),
      budget: { mode: 'flexible' },
      certPreference: 'none',
      interviewPrep: 'no',
      certificateOptIns: ['hackerrank-sql-basic'],
      examDates: [{ catalogId: 'hackerrank-sql-basic', date: '2027-01-20', start: '10:00' }],
    };
    const draft = buildPlan({ today: TODAY, request: req }, BUNDLED_CATALOG);
    checkDraft(draft, req, 'anchor');
    const exam = draft.plan.tasks.find((t) => t.id === 'x-hackerrank-sql-basic')!;
    expect(exam).toMatchObject({
      isAnchor: true,
      anchorDate: '2027-01-20',
      anchorStartTime: '10:00',
    });
  });
});
