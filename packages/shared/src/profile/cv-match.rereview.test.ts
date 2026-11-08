import { describe, expect, it } from 'vitest';
import { extractProfileFromText } from './cv-match';
import { CV_NOW } from './fixtures/cvs';
import type { MatchTaxonomy } from './types';

const runReal = (text: string) => extractProfileFromText(text, { now: CV_NOW });
const run = (text: string, taxonomy: MatchTaxonomy) =>
  extractProfileFromText(text, { now: CV_NOW, taxonomy, tools: [] });

describe('more contact headings', () => {
  for (const heading of [
    'CONTACT INFO',
    'Contact info',
    'Personal info',
    'Personal',
    'Get in touch',
    'יצירת קשר',
  ]) {
    it(`${heading}: lines under it never reach titles or evidence`, () => {
      const r = extractProfileFromText(
        `Experience\nAnalyst 2019 - 2021\n${heading}\nDana Example Excel, 12 Herzl Street 2018 - 2019\nSkills\nSQL`,
        { now: CV_NOW, tools: ['Excel', 'SQL'] },
      );
      expect(r.tools.find((t) => t.tool === 'Excel')?.evidence).toBe('');
      expect(JSON.stringify(r)).not.toMatch(/Herzl|Dana/);
      expect(r.yearsExperience).toBe(2);
    });
  }
});

describe('evidence of a loose hyphenated hit', () => {
  const taxonomy: MatchTaxonomy = {
    skills: [{ id: 'nc', name: 'No-code tools', keywords: ['no-code'] }],
    roles: [],
  };
  it('prefers the real no-code line over the "no code of conduct" line', () => {
    const r = run(
      'Experience\nThere was no code of conduct.\nBuilt no-code workflows with Make',
      taxonomy,
    );
    expect(r.skills).toEqual([expect.objectContaining({ skillId: 'nc', strength: 'strong' })]);
    expect(r.skills[0]?.evidence).toBe('Built no-code workflows with Make');
  });
});

describe('borrowed dates', () => {
  it('a bracketed range on the next line is borrowed', () => {
    const r = runReal('Experience\nOperations Analyst\n(2020 – 2021)');
    expect(r.rolesHeld[0]).toMatchObject({ roleId: 'operations-associate', years: 1 });
  });

  it('a bracketed range on the same line keeps the title clean', () => {
    const r = runReal('Experience\nOperations Analyst (2020 – 2021)');
    expect(r.rolesHeld[0]).toMatchObject({ title: 'Operations Analyst', years: 1 });
  });

  it('a range followed by a location is borrowed and the location is not a title', () => {
    const r = runReal('Experience\nAssistant\nJan 2021 - Present, Tel Aviv');
    expect(r.rolesHeld).toEqual([
      expect.objectContaining({ roleId: null, title: 'Assistant', years: 5.5 }),
    ]);
    expect(r.rolesHeld.some((x) => x.title.includes('Tel Aviv'))).toBe(false);
  });
});

describe('dropped lines and dates', () => {
  const taxonomy: MatchTaxonomy = {
    skills: [{ id: 'pm', name: 'Project management', keywords: ['risk management'] }],
    roles: [],
  };
  it('a skill found only in the contact block or before the first heading is not suggested', () => {
    expect(run('risk management expert\nExperience\nAnalyst', taxonomy).skills).toEqual([]);
    expect(run('Experience\nAnalyst\nContact\nrisk management', taxonomy).skills).toEqual([]);
    expect(run('Experience\nrisk management', taxonomy).skills).toHaveLength(1);
  });

  it('a version number is not a date range', () => {
    expect(
      runReal('Experience\nOperations Analyst, built v3.2019 - 2020').yearsExperience,
    ).toBeNull();
  });

  it('full ISO dates parse', () => {
    const r = runReal('Experience\nOperations Analyst 2018-03-01 – 2019-06-30');
    expect(r.yearsExperience).toBe(1.5);
  });

  it('a range inside one year counts 0 years (documented)', () => {
    expect(runReal('Experience\nOperations Analyst 2014 - 2014').yearsExperience).toBe(0);
  });
});
