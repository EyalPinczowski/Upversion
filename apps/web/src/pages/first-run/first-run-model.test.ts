import { describe, expect, it } from 'vitest';
import { ROLES } from '../plan-builder/builder-model';
import type { BuilderState } from '../plan-builder/builder-model';
import { answersForStep, enjoyOptions, suggestRoles } from './first-run-model';
import { resumeStep, savedStep } from './steps';

describe('resumeStep', () => {
  it('reads a saved first-run step and ignores everything else', () => {
    expect(resumeStep(savedStep(1))).toBe(1);
    expect(resumeStep(savedStep(3))).toBe(3);
    // A stray fr:4 counts as the last question screen; the old wizard's steps are not ours.
    expect(resumeStep('fr:4')).toBe(3);
    expect(resumeStep('fr:9')).toBe(3);
    expect(resumeStep('fr:0')).toBeNull();
    expect(resumeStep('fr:x')).toBeNull();
    expect(resumeStep('q:current_status')).toBeNull();
    expect(resumeStep(null)).toBeNull();
  });

  it('never saves the draft step: leaving screen 3 saves fr:3, which resumes at 3', () => {
    expect(savedStep(4)).toBe('fr:3');
    expect(resumeStep(savedStep(4))).toBe(3);
    expect(savedStep(0)).toBe('fr:1');
  });

  it('saved ids fit the 40 character limit', () => {
    expect(savedStep(3).length).toBeLessThanOrEqual(40);
  });
});

describe('suggestRoles', () => {
  const known = new Set(ROLES.map((r) => r.id));

  it('returns nothing for no choice', () => {
    expect(suggestRoles([], null)).toEqual([]);
  });

  it('returns at most 4 roles, all from roles.json, without repeats', () => {
    const all = enjoyOptions().map((o) => o.value);
    for (const picks of [[all[0]!], all.slice(0, 3), all]) {
      const out = suggestRoles(picks, null);
      expect(out.length).toBeLessThanOrEqual(4);
      expect(new Set(out).size).toBe(out.length);
      for (const id of out) expect(known.has(id)).toBe(true);
    }
  });

  it('puts a role named by two choices first', () => {
    // business-analyst is listed under both "data" and "product".
    expect(suggestRoles(['data', 'product'], null)[0]).toBe('business-analyst');
  });

  it('is deterministic, and a work style only breaks ties', () => {
    expect(suggestRoles(['data'], null)).toEqual(suggestRoles(['data'], null));
    const plain = suggestRoles(['data', 'people'], null);
    const leaning = suggestRoles(['data', 'people'], 'people');
    expect(plain[0]).toBe('data-analyst');
    expect(leaning[0]).toBe('customer-success');
    expect(leaning).toHaveLength(plain.length);
  });
});

describe('answersForStep', () => {
  const state = (hours: string) =>
    ({
      weekdays: [1, 0],
      hours,
      timeOfDay: 'morning',
      roleIds: [],
      extraSkillIds: [],
    }) as unknown as BuilderState;

  it('sends hours_per_day only as a multiple of 0.5, never dropping the other answers', () => {
    expect(answersForStep(3, state('2.5'))).toEqual({
      days_per_week: [0, 1],
      hours_per_day: 2.5,
      time_of_day: 'morning',
    });
    expect(answersForStep(3, state('2.3'))).toEqual({
      days_per_week: [0, 1],
      time_of_day: 'morning',
    });
    expect(answersForStep(3, state('0.25'))).not.toHaveProperty('hours_per_day');
  });
});
