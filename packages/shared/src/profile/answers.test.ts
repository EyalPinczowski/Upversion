import { describe, expect, it } from 'vitest';
import { validateAnswer } from './answers';
import { CATALOG_QUESTIONS } from './catalog';

const q = (id: string) => {
  const found = CATALOG_QUESTIONS.find((x) => x.id === id);
  if (!found) throw new Error(`no question ${id}`);
  return found;
};

describe('validateAnswer', () => {
  it('single: only listed option values', () => {
    expect(validateAnswer(q('current_status'), 'employed').ok).toBe(true);
    expect(validateAnswer(q('current_status'), 'astronaut').ok).toBe(false);
    expect(validateAnswer(q('current_status'), ['employed']).ok).toBe(false);
    expect(validateAnswer(q('current_status'), 'Working full-time').ok).toBe(false);
  });

  it('multi: string options, no duplicates, no unknown', () => {
    expect(validateAnswer(q('tools_known'), ['Excel', 'SQL']).ok).toBe(true);
    expect(validateAnswer(q('tools_known'), []).ok).toBe(true);
    expect(validateAnswer(q('tools_known'), ['Excel', 'Excel']).ok).toBe(false);
    expect(validateAnswer(q('tools_known'), ['COBOL']).ok).toBe(false);
    expect(validateAnswer(q('tools_known'), 'Excel').ok).toBe(false);
  });

  it('weekdays: integers 0 to 6, at least one, sorted', () => {
    expect(validateAnswer(q('days_per_week'), [4, 0, 2])).toEqual({ ok: true, value: [0, 2, 4] });
    expect(validateAnswer(q('days_per_week'), []).ok).toBe(false);
    expect(validateAnswer(q('days_per_week'), [7]).ok).toBe(false);
    expect(validateAnswer(q('days_per_week'), [1.5]).ok).toBe(false);
    expect(validateAnswer(q('days_per_week'), [1, 1]).ok).toBe(false);
    expect(validateAnswer(q('days_per_week'), ['1']).ok).toBe(false);
  });

  it('number: bounds and step', () => {
    expect(validateAnswer(q('hours_per_day'), 0.5).ok).toBe(true);
    expect(validateAnswer(q('hours_per_day'), 12).ok).toBe(true);
    expect(validateAnswer(q('hours_per_day'), 2.5).ok).toBe(true);
    expect(validateAnswer(q('hours_per_day'), 0.4).ok).toBe(false);
    expect(validateAnswer(q('hours_per_day'), 12.5).ok).toBe(false);
    expect(validateAnswer(q('hours_per_day'), 2.25).ok).toBe(false);
    expect(validateAnswer(q('hours_per_day'), '3').ok).toBe(false);
    expect(validateAnswer(q('hours_per_day'), Number.NaN).ok).toBe(false);
  });

  it('yes_no: booleans only', () => {
    const yn = { type: 'yes_no' };
    expect(validateAnswer(yn, true).ok).toBe(true);
    expect(validateAnswer(yn, 'yes').ok).toBe(false);
  });

  it('multi_role: roles.json ids, count <= max, no Other, no unknown id', () => {
    const role = q('target_role');
    expect(validateAnswer(role, ['data-analyst']).ok).toBe(true);
    expect(validateAnswer(role, ['data-analyst', 'operations-associate']).ok).toBe(true);
    expect(validateAnswer(role, []).ok).toBe(true);
    expect(
      validateAnswer(role, ['data-analyst', 'operations-associate', 'technical-operations']).ok,
    ).toBe(false);
    expect(validateAnswer(role, ['Other']).ok).toBe(false);
    expect(validateAnswer(role, ['Chief Happiness Officer']).ok).toBe(false);
    expect(validateAnswer(role, ['no-such-role']).ok).toBe(false);
    expect(validateAnswer(role, ['data-analyst', 'data-analyst']).ok).toBe(false);
    expect(validateAnswer(role, 'data-analyst').ok).toBe(false);
  });

  it('multi_skill: skills.json ids, count <= max, no Other, no unknown id', () => {
    const skill = q('target_skills');
    const five = ['excel', 'sql', 'jira', 'python', 'project-management'];
    expect(validateAnswer(skill, ['excel', 'sql']).ok).toBe(true);
    expect(validateAnswer(skill, five).ok).toBe(true);
    expect(validateAnswer(skill, [...five, 'agile-scrum']).ok).toBe(false);
    expect(validateAnswer(skill, ['Other']).ok).toBe(false);
    expect(validateAnswer(skill, ['Underwater basket weaving']).ok).toBe(false);
    expect(validateAnswer(skill, ['no-such-skill']).ok).toBe(false);
  });

  it('rejects types outside the setup allowlist', () => {
    expect(validateAnswer({ type: 'text' }, 'hello').ok).toBe(false);
    expect(validateAnswer({ type: 'text_or_url' }, 'https://x.example').ok).toBe(false);
  });
});
