import { buildPlan } from './build';
import { BUNDLED_CATALOG, type BuildCatalog, type CatalogItem, type CatalogRole } from './catalog';
import type { BuildDraft, BuildRequestInput } from './schemas';

/** A small fictional catalog for unit tests. Nothing here comes from the real catalog. */

export function item(partial: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    type: 'course',
    title: `Item ${partial.id}`,
    provider: 'Test Provider',
    url: `https://example.test/${partial.id}`,
    url_verified: true,
    cost_type: 'free',
    price: 0,
    price_verified: true,
    currency: 'USD',
    subscription_period: null,
    subscription_group: null,
    certificate_price: null,
    certificate_type: 'none',
    recognition: 'low',
    level: 'beginner',
    est_hours: 4,
    skills: [],
    roles: [],
    prerequisites: [],
    prerequisite_kinds: {},
    free_alternative_ids: [],
    ...partial,
  };
}

export function role(partial: Partial<CatalogRole> & { id: string }): CatalogRole {
  return {
    title: `Role ${partial.id}`,
    skills: [],
    suggested_path: { core: [], optional: [], practice: [], free_only: [] },
    ...partial,
  };
}

export function catalogOf(items: CatalogItem[], roles: CatalogRole[]): BuildCatalog {
  const skillIds = new Set<string>();
  for (const i of items) for (const s of i.skills) skillIds.add(s);
  for (const r of roles) for (const s of r.skills) skillIds.add(s.skill);
  return {
    items,
    roles,
    skills: [...skillIds].sort().map((id) => ({ id, name: `Skill ${id}` })),
  };
}

export const TODAY = '2026-11-02';

/** A request with sensible defaults: four weeks, Sunday to Thursday, 3 hours a day. */
export function request(overrides: Partial<BuildRequestInput> = {}): BuildRequestInput {
  return {
    targetRoleIds: ['role-a'],
    startDate: '2026-11-03',
    deadline: '2026-12-01',
    weekPattern: {
      studyWeekdays: [0, 1, 2, 3, 4],
      defaultHours: 3,
      windowStart: '09:00',
      windowEnd: '17:30',
      lunchStart: '13:00',
      lunchEnd: '14:00',
      timezone: 'Asia/Jerusalem',
    },
    budget: { mode: 'flexible' },
    certPreference: 'none',
    interviewPrep: 'no',
    ...overrides,
  };
}

export function build(
  catalog: BuildCatalog,
  overrides: Partial<BuildRequestInput> = {},
  today = TODAY,
): BuildDraft {
  return buildPlan({ today, request: request(overrides) }, catalog);
}

export function buildReal(overrides: Partial<BuildRequestInput> = {}, today = TODAY): BuildDraft {
  return buildPlan({ today, request: request(overrides) }, BUNDLED_CATALOG);
}

export function task(draft: BuildDraft, id: string) {
  const t = draft.plan.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`No task ${id}; have ${draft.plan.tasks.map((x) => x.id).join(', ')}`);
  return t;
}

export function hasTask(draft: BuildDraft, id: string): boolean {
  return draft.plan.tasks.some((x) => x.id === id);
}

export function itemIds(draft: BuildDraft): string[] {
  return draft.items.map((i) => i.catalogId);
}

/** Two skills, two roles worth of items: enough for most unit tests. */
export function basicCatalog(): BuildCatalog {
  return catalogOf(
    [
      item({ id: 'c-s1', skills: ['s1'], est_hours: 6 }),
      item({ id: 'c-s2', skills: ['s2'], est_hours: 5 }),
      item({ id: 'c-s3', skills: ['s3'], est_hours: 3 }),
      item({
        id: 'p1',
        type: 'practice',
        url: null,
        url_verified: false,
        est_hours: 2,
        skills: ['s1'],
      }),
    ],
    [
      role({
        id: 'role-a',
        skills: [
          { skill: 's1', weight: 5 },
          { skill: 's2', weight: 4 },
          { skill: 's3', weight: 2 },
        ],
        suggested_path: {
          core: ['c-s1', 'c-s2'],
          optional: ['c-s3'],
          practice: ['p1'],
          free_only: ['c-s1'],
        },
      }),
    ],
  );
}
