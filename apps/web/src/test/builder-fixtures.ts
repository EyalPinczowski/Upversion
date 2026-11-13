import type { AiUsage } from '../api/ai-hooks';
import type { BuildDraft, BuildRequestBody, PlanSummary } from '../api/client';
import { apiError, installApi, json, meBody } from './helpers';
import { NOW, planSummary } from './plan-fixtures';
import { profileView } from './setup-fixtures';

type Handler = (request: Request) => Response | Promise<Response>;
type Item = BuildDraft['items'][number];

export const usageBody = (planBuilder: boolean): AiUsage => ({
  day: '2026-11-10',
  resetsAt: '2026-11-11T00:00:00.000Z',
  configured: false,
  user: {
    practiceMessages: { used: 0, cap: 30 },
    practiceFeedback: { used: 0, cap: 10 },
    dayOverview: { used: 0, cap: 0 },
    cvTailor: { used: 0, cap: 3 },
  },
  features: { cvTailor: false, planBuilder },
  avoidedToday: 0,
  providers: [],
});

export const item = (over: Partial<Item> = {}): Item => ({
  catalogId: 'sql-basics',
  title: 'SQL for beginners',
  provider: 'Example Academy',
  kind: 'course',
  tier: 'core',
  origin: 'gap',
  taskIds: ['c-sql-basics'],
  hours: 6,
  skillIds: ['sql'],
  priority: 12,
  why: 'Teaches SQL – the role weights it 5 and you rated it Never used.',
  cost: { amount: null, kind: 'free' },
  needsCheckLink: false,
  needsCheckPrice: false,
  priceVaries: false,
  isCertificate: false,
  ...over,
});

/** A draft that fits, with one verified free course. Pass overrides for the case under test. */
export function draft(over: Partial<BuildDraft> = {}, items: Item[] = [item()]): BuildDraft {
  return {
    plan: {
      name: 'Operations plan',
      tasks: items.map((i, n) => ({
        id: i.taskIds[0] ?? `t${n}`,
        title: i.title,
        type: i.kind === 'exam' ? 'cert_exam' : 'course',
        estHours: i.hours,
        status: 'todo',
        order: n,
        dependsOn: [],
        isAnchor: false,
        splittable: true,
        isCertificate: i.isCertificate,
        ...(i.needsCheckLink
          ? { notes: 'Needs check: link not yet verified. Search the title.' }
          : { url: 'https://courses.example.test/sql' }),
      })),
    } as unknown as BuildDraft['plan'],
    items,
    excluded: [],
    skippedPrerequisites: [],
    summary: {
      scheduleFrom: '2026-11-14',
      deadline: '2026-12-12',
      finishDate: '2026-12-01',
      totalHours: items.reduce((n, i) => n + i.hours, 0),
      cost: {
        currency: 'USD',
        total: 0,
        estimated: false,
        unverifiedPriceCount: 0,
        assumedOneMonth: [],
        mayBeHigher: false,
        pricesToCheck: 0,
        lines: [],
        subscriptionMonths: {},
      },
      skillsAsked: 3,
      skillsCovered: ['sql'],
      skillsAlreadyCovered: [],
      skillsNotCovered: [],
      certificatesIncluded: [],
      certificatesOffered: [],
    },
    fits: true,
    options: null,
    overBudget: false,
    removeToFit: [],
    warnings: [],
    draftHash: 'hash-1',
    ...over,
  };
}

export const fitOptions = (): NonNullable<BuildDraft['options']> => ({
  finishOn: { date: '2027-01-20' },
  hoursPerDay: { value: 4.5, appliesToAllStudyDays: true },
  essentials: { possible: true, droppedItemIds: ['excel-pivot'], lostSkillIds: ['excel'] },
});

export const NEW_PLAN_ID = '33333333-3333-4333-8333-333333333333';
export const OLD_PLAN_ID = '22222222-2222-4222-8222-222222222222';

export const plan = (over: Partial<PlanSummary> = {}): PlanSummary =>
  planSummary({ id: OLD_PLAN_ID, name: 'Old plan', ...over });

interface Options {
  flag?: boolean;
  plans?: PlanSummary[];
  profile?: Parameters<typeof profileView>[0] | 404;
  preview?: (body: BuildRequestBody, request: Request) => Response | Promise<Response>;
  build?: Handler;
  restore?: Handler;
  extra?: Record<string, Handler>;
}

/** An API stand-in for the builder: usage flag, profile, plans, preview, build and restore. */
export function installBuilderApi(options: Options = {}) {
  let plans = options.plans ?? [];
  const state = {
    get plans() {
      return plans;
    },
    set plans(next: PlanSummary[]) {
      plans = next;
    },
  };
  const api = installApi({
    'GET /api/v1/me': () => json(meBody()),
    'GET /api/v1/ai/usage': () => json(usageBody(options.flag ?? true)),
    'GET /api/v1/me/profile': () =>
      options.profile === 404
        ? apiError(404, 'not_found', 'Resource not found.')
        : json(profileView({ setupStatus: 'completed', ...options.profile })),
    'GET /api/v1/plans': () => json({ plans }),
    'POST /api/v1/plans/build/preview': async (request) => {
      const body = (await request.clone().json()) as BuildRequestBody;
      return options.preview ? options.preview(body, request) : json(draft());
    },
    'POST /api/v1/plans/build':
      options.build ??
      (() => {
        const created = plan({ id: NEW_PLAN_ID, name: 'Operations plan', createdAt: NOW });
        plans = [created, ...plans.map((p) => ({ ...p, status: 'archived' as const }))];
        return json(created, 201);
      }),
    ...(options.restore ? { [`POST /api/v1/plans/${OLD_PLAN_ID}/restore`]: options.restore } : {}),
    ...options.extra,
  });
  return Object.assign(api, { state });
}

export const callsTo = (api: { calls: Request[] }, key: string) =>
  api.calls.filter((c) => `${c.method} ${new URL(c.url).pathname}` === key);
