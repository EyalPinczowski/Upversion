import { describe, expect, it } from 'vitest';
import { CATALOG_QUESTIONS } from './catalog';
import { setupQuestions } from './setup';
import type { CatalogQuestion } from './types';

const SETUP_IDS = [
  'current_status',
  'education',
  'tools_known',
  'days_per_week',
  'hours_per_day',
  'time_of_day',
  'target_role',
  'target_skills',
];

/** The catalog with the ADR 015 `setup` flags applied (the flags themselves come from WP-D). */
function flagged(): CatalogQuestion[] {
  return CATALOG_QUESTIONS.map((q) => {
    const i = SETUP_IDS.indexOf(q.id);
    if (i < 0) return q;
    const extra = i >= 6 ? { ignore_show_if: true, choices_only: true, optional: true } : {};
    return { ...q, setup: { order: i + 1, ...extra } };
  });
}

describe('setupQuestions', () => {
  it('returns the flagged questions sorted by setup.order, whatever the file order', () => {
    const shuffled = [...flagged()].reverse();
    expect(setupQuestions(shuffled).map((q) => q.id)).toEqual(SETUP_IDS);
  });

  it('strips show_if and allow_other, and treats optional as not required', () => {
    const out = setupQuestions(flagged());
    expect(out).toHaveLength(8);
    for (const q of out) {
      expect(q).not.toHaveProperty('show_if');
      expect(q).not.toHaveProperty('allow_other');
    }
    const byId = Object.fromEntries(out.map((q) => [q.id, q]));
    expect(byId.target_role?.required).toBe(false);
    expect(byId.target_skills?.required).toBe(false);
    expect(byId.current_status?.required).toBe(true);
    expect(byId.days_per_week?.required).toBe(true);
    expect(byId.education?.required).toBe(false);
  });

  it('uses setup.why instead of why in setup, and leaves the plan-builder why alone', () => {
    const skills = setupQuestions().find((q) => q.id === 'target_skills');
    expect(skills?.why).toBe('Pick up to 5.');
    expect(skills?.why).not.toMatch(/type/i);
    expect(CATALOG_QUESTIONS.find((q) => q.id === 'target_skills')?.why).toMatch(/You can type/);
  });

  it('does not touch the plan-builder definitions', () => {
    setupQuestions(flagged());
    const role = CATALOG_QUESTIONS.find((q) => q.id === 'target_role');
    expect(role?.show_if).toBeDefined();
    expect(role?.allow_other).toBe(true);
    expect(role?.required).toBe(true);
  });

  it('returns nothing for questions without a setup flag', () => {
    expect(setupQuestions(CATALOG_QUESTIONS.filter((q) => !q.setup))).toEqual([]);
  });

  // Becomes active once the catalog carries the flags (WP-D).
  it.skipIf(setupQuestions().length === 0)('reads the real catalog: the 8 ids in order', () => {
    expect(setupQuestions().map((q) => q.id)).toEqual(SETUP_IDS);
  });
});
