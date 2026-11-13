import { describe, expect, it } from 'vitest';
import { buildPlan, composeFor, createContext } from './build';
import { BUNDLED_CATALOG } from './catalog';
import { fitRoots, MAX_FIT_RUNS } from './fit';
import type { BuildRequestInput } from './schemas';
import { ExclusionLog, selectCertificates, selectCourses, selectPractice } from './select';

/** The role with the most catalog items on its suggested paths: the biggest drafts. */
const largest = [...BUNDLED_CATALOG.roles].sort((a, b) => {
  const size = (r: typeof a) =>
    new Set([...r.suggested_path.core, ...r.suggested_path.optional, ...r.suggested_path.practice])
      .size;
  return size(b) - size(a) || (a.id < b.id ? -1 : 1);
})[0]!;

// A tight deadline with a generous budget makes the fit loop work the hardest: many items,
// drops one at a time, then the three options (binary search and the essentials loop).
const hard: BuildRequestInput = {
  targetRoleIds: [largest.id],
  startDate: '2026-11-03',
  deadline: '2026-11-24',
  weekPattern: {
    studyWeekdays: [0, 1, 2, 3, 4],
    defaultHours: 2,
    windowStart: '09:00',
    windowEnd: '17:30',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    timezone: 'Asia/Jerusalem',
  },
  budget: { mode: 'flexible' },
  certPreference: 'must',
  interviewPrep: 'yes',
};

describe('engine time budget', () => {
  it(`stays well inside a generous bound on the largest role (${largest.id})`, () => {
    // ADR 017 expects about 200 ms for the fit loop on a normal machine. The bound here is
    // generous (CI machines are slow and noisy); it still catches a loop that runs away.
    buildPlan({ today: '2026-11-02', request: hard }, BUNDLED_CATALOG); // warm up
    const start = performance.now();
    const draft = buildPlan({ today: '2026-11-02', request: hard }, BUNDLED_CATALOG);
    const ms = performance.now() - start;
    expect(draft.items.length + draft.excluded.length).toBeGreaterThan(8);
    expect(ms).toBeLessThan(2000);
  });

  it('uses a bounded number of engine runs for the fit loop', () => {
    const ctx = createContext({ today: '2026-11-02', request: hard }, BUNDLED_CATALOG);
    const log = new ExclusionLog();
    const courses = selectCourses(ctx, log);
    const certs = selectCertificates(ctx, courses, log);
    const roots = [...courses, ...certs.roots];
    roots.push(...selectPractice(ctx, roots, log));
    const outcome = fitRoots(ctx, composeFor(ctx), roots);
    expect(roots.length).toBeGreaterThan(8);
    expect(outcome.runs).toBeLessThanOrEqual(MAX_FIT_RUNS);
    expect(outcome.runs).toBeLessThanOrEqual(roots.length + 1);
  });
});
