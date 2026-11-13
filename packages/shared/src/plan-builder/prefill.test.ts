import { describe, expect, it } from 'vitest';
import { CATALOG_QUESTIONS } from '../profile/catalog';
import { BuildRequestSchema } from './schemas';
import { prefillFromProfile, TIME_OF_DAY_WINDOWS } from './prefill';

const options = { today: '2026-11-12', timezone: 'Asia/Jerusalem' };

const profile = {
  answers: {
    target_role: ['data-analyst'],
    target_skills: ['python'],
    days_per_week: [0, 2, 4],
    hours_per_day: 2.5,
    time_of_day: 'evening',
  },
  skills: [
    { skillId: 'sql', level: 2, source: 'cv' as const },
    { skillId: 'excel', level: 1, source: 'setup' as const },
    { skillId: 'jira', level: 3, source: 'manual' as const },
  ],
};

describe('prefillFromProfile', () => {
  it('fills roles, extra skills and the week pattern from the setup answers', () => {
    const { request } = prefillFromProfile(profile, CATALOG_QUESTIONS, options);
    expect(request.targetRoleIds).toEqual(['data-analyst']);
    expect(request.extraSkillIds).toEqual(['python']);
    expect(request.weekPattern).toMatchObject({
      studyWeekdays: [0, 2, 4],
      defaultHours: 2.5,
      windowStart: '18:00',
      windowEnd: '22:00',
      timezone: 'Asia/Jerusalem',
    });
  });

  it('starts tomorrow and ends after the default number of weeks of questions.json', () => {
    const { request } = prefillFromProfile(profile, CATALOG_QUESTIONS, options);
    expect(request.startDate).toBe('2026-11-13');
    expect(request.deadline).toBe('2026-12-11'); // default_weeks = 4
  });

  it('keeps the levels of the profile with their source and marks unrated skills', () => {
    const { request, levelSources, notRated } = prefillFromProfile(
      profile,
      CATALOG_QUESTIONS,
      options,
    );
    expect(request.skillLevels?.['sql']).toBe(2);
    expect(levelSources['sql']).toBe('cv');
    expect(levelSources['excel']).toBe('setup');
    // A skill the profile does not know starts at "never used" and is "not rated".
    expect(notRated).toContain('python');
    expect(request.skillLevels?.['python']).toBe(0);
    expect(levelSources['python']).toBeNull();
  });

  it('maps every time of day to a window, with flexible as the fallback', () => {
    expect(TIME_OF_DAY_WINDOWS).toEqual({
      morning: { windowStart: '08:00', windowEnd: '12:00' },
      afternoon: { windowStart: '12:00', windowEnd: '17:00' },
      evening: { windowStart: '18:00', windowEnd: '22:00' },
      flexible: { windowStart: '09:00', windowEnd: '17:30' },
    });
    const none = prefillFromProfile({ answers: {}, skills: [] }, CATALOG_QUESTIONS, options);
    expect(none.request.weekPattern).toMatchObject({
      windowStart: '09:00',
      windowEnd: '17:30',
      defaultHours: 3,
      studyWeekdays: [0, 1, 2, 3, 4],
    });
    expect(none.request.targetRoleIds).toBeUndefined();
  });

  it('ignores answers that are not catalog ids or valid options, and never guesses a budget', () => {
    const { request } = prefillFromProfile(
      {
        answers: {
          target_role: ['not-a-role', 'data-analyst', 'data-analyst'],
          target_skills: ['nope'],
          days_per_week: [9],
          hours_per_day: 'many',
          time_of_day: 'midnight',
          budget: 'unlimited',
          certificates: 'must',
        },
        skills: [],
      },
      CATALOG_QUESTIONS,
      options,
    );
    expect(request.targetRoleIds).toEqual(['data-analyst']);
    expect(request.extraSkillIds).toEqual([]);
    expect(request.budget).toBeUndefined();
    expect(request.certPreference).toBe('must');
    expect(request.weekPattern?.studyWeekdays).toEqual([0, 1, 2, 3, 4]);
  });

  it('makes a request the schema accepts once the user adds a budget and the choices', () => {
    const { request } = prefillFromProfile(profile, CATALOG_QUESTIONS, options);
    const full = {
      ...request,
      budget: { mode: 'free' },
      certPreference: 'nice',
      interviewPrep: 'no',
    };
    expect(BuildRequestSchema.safeParse(full).success).toBe(true);
  });
});
