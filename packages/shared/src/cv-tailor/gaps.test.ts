import { describe, expect, it } from 'vitest';
import { CATALOG_TAXONOMY } from '../profile/catalog';
import { dropContactLines, extractProfileFromText, matchSkillsInText } from '../profile/cv-match';
import { tailorCv, tailorJob } from './fixtures/texts';
import type { MatchTaxonomy } from '../profile/types';
import { keywordGaps } from './gaps';

const NOW = new Date('2026-06-15T00:00:00Z');
const names = (items: { name: string }[]) => items.map((i) => i.name);
const ids = (items: { skillId: string }[]) => items.map((i) => i.skillId);

describe('keywordGaps', () => {
  const g = keywordGaps(tailorCv, tailorJob, { now: NOW });

  it('splits job skills into matched (in the CV) and missing (not in the CV)', () => {
    expect(ids(g.matched)).toEqual(
      expect.arrayContaining(['sql', 'excel', 'jira', 'project-management', 'bi-visualization']),
    );
    expect(ids(g.missing)).toContain('python');
    expect(ids(g.missing)).not.toContain('sql');
    expect(names(g.matched)).toContain('SQL');
  });

  it('lists skills only the CV has as cvOnly', () => {
    expect(ids(g.cvOnly)).toContain('work-management-tools');
    expect(ids(g.cvOnly)).not.toContain('sql');
  });

  it('is deterministic and sorted by hits in the job post, then name', () => {
    expect(keywordGaps(tailorCv, tailorJob, { now: NOW })).toEqual(g);
    for (const list of [g.matched, g.missing]) {
      for (let i = 1; i < list.length; i += 1) {
        const a = list[i - 1]!;
        const b = list[i]!;
        expect(a.hits > b.hits || (a.hits === b.hits && a.name.localeCompare(b.name) <= 0)).toBe(
          true,
        );
      }
    }
  });

  it('holds catalog names only, never text of the CV or the job post', () => {
    const all = JSON.stringify(g);
    expect(all).not.toContain('Acme');
    expect(all).not.toContain('Initech');
  });

  it('works on a job post whose first lines are its title (no contact-block drop)', () => {
    const r = keywordGaps(
      'Experience\nWrote Excel macros\nSkills\nExcel',
      'Python developer\nSQL\nSQL reports',
      {
        now: NOW,
      },
    );
    expect(ids(r.missing)).toContain('python');
  });

  it('adds the catalog skills of a picked role as wanted, and ignores an unknown roleId', () => {
    const role = CATALOG_TAXONOMY.roles.find((r) => r.id === 'operations-associate')!;
    const heavy = (role.skills ?? []).filter((s) => s.weight >= 4).map((s) => s.skill);
    const withRole = keywordGaps('Experience\nx', 'A short post about nothing', {
      now: NOW,
      roleId: 'operations-associate',
    });
    const ids = [...withRole.matched, ...withRole.missing].map((i) => i.skillId);
    for (const id of heavy) expect(ids).toContain(id);
    const unknown = keywordGaps('Experience\nx', 'A short post about nothing', {
      now: NOW,
      roleId: 'no-such-role',
    });
    expect(unknown.missing).toEqual([]);
  });
});

describe("keywordGaps terms (the texts' own wording)", () => {
  const tax: MatchTaxonomy = {
    skills: [
      { id: 'dbt', name: 'Data transformation basics', keywords: ['dbt', 'data build tool'] },
      { id: 'comm', name: 'Business communication', keywords: ['stakeholder communication'] },
      { id: 'py', name: 'Python basics', keywords: ['python'] },
      { id: 'mail', name: 'Mail tools', keywords: ['jane@example.com', 'mailing'] },
    ],
    roles: [],
  };
  const run = (cv: string, job: string) => keywordGaps(cv, job, { now: NOW, taxonomy: tax });

  it('shows the job post wording for matched and missing items, not the catalog name', () => {
    const r = run(
      'Experience\nx\nSkills\nPython',
      'We use dbt (data build tool) and Python. Strong stakeholder communication.',
    );
    const py = r.matched.find((i) => i.skillId === 'py')!;
    expect(py.name).toBe('Python basics');
    expect(py.label).toBe('Python');
    const dbt = r.missing.find((i) => i.skillId === 'dbt')!;
    expect(dbt.terms).toEqual(['dbt', 'data build tool']);
    expect(dbt.label).toBe('dbt');
    expect(r.missing.find((i) => i.skillId === 'comm')!.label).toBe('stakeholder communication');
  });

  it('shows the CV wording for cvOnly items', () => {
    const r = run('Experience\nBuilt models with the Data Build Tool', 'Nothing relevant here');
    const item = r.cvOnly.find((i) => i.skillId === 'dbt')!;
    expect(item.label).toBe('Data Build Tool');
    expect(item.name).toBe('Data transformation basics');
  });

  it('collapses duplicates case-insensitively, most frequent first, capped at three', () => {
    const job = 'dbt dbt DBT data build tool\ndata build tool\ndata build tool';
    const hit = matchSkillsInText(job, { taxonomy: tax }).find((h) => h.skillId === 'dbt')!;
    expect(hit.terms).toEqual(['dbt', 'data build tool']);
    const many: MatchTaxonomy = {
      skills: [{ id: 'x', name: 'X', keywords: ['aa1', 'bb2', 'cc3', 'dd4', 'ee5'] }],
      roles: [],
    };
    const capped = matchSkillsInText('aa1 bb2 cc3 dd4 ee5', { taxonomy: many })[0]!;
    expect(capped.terms).toHaveLength(3);
  });

  it('collapses whitespace inside a term and skips terms longer than the cap', () => {
    const long = 'stakeholder ' + 'x'.repeat(60);
    const t: MatchTaxonomy = {
      skills: [{ id: 'k', name: 'K', keywords: ['alpha beta', long] }],
      roles: [],
    };
    const hit = matchSkillsInText(`alpha    beta\n${long}`, { taxonomy: t })[0]!;
    expect(hit.terms).toEqual(['alpha beta']);
  });

  it('skips a term the PII redaction would change, and falls back to the catalog name', () => {
    const r = run('Experience\nx', 'jane@example.com and jane@example.com, plus mailing');
    expect(JSON.stringify(r)).not.toContain('jane@example.com');
    const mail = r.missing.find((i) => i.skillId === 'mail')!;
    expect(mail.terms).toEqual(['mailing']);
    const only = run('Experience\nx', 'jane@example.com jane@example.com').missing.find(
      (i) => i.skillId === 'mail',
    );
    if (only) {
      expect(only.terms).toEqual([]);
      expect(only.label).toBe('Mail tools');
    }
  });

  it('has no terms for a skill that comes only from the picked role', () => {
    const withRole = keywordGaps('Experience\nx', 'A short post about nothing', {
      now: NOW,
      roleId: 'operations-associate',
    });
    const item = withRole.missing[0]!;
    expect(item.terms).toEqual([]);
    expect(item.label).toBe(item.name);
  });
});

describe('matcher additions', () => {
  it('matchSkillsInText reads every line, including the first two', () => {
    const hits = matchSkillsInText('Tableau\nPython\nPython');
    expect(hits.map((h) => h.skillId)).toEqual(['python', 'bi-visualization']);
    // The CV matcher would drop these two lines as a contact block.
    expect(extractProfileFromText('Tableau\nPython\nWrote notes').skills).toEqual([]);
  });

  it('dropContactLines: header, Contact section and References section', () => {
    const lines = [
      'Name',
      'a@b.co',
      'Experience',
      'Role',
      'References',
      'Sam 555',
      'Skills',
      'SQL',
    ];
    expect([...dropContactLines(lines)].sort()).toEqual([0, 1, 4, 5]);
  });

  it('a References section is not read by the CV matcher', () => {
    const r = extractProfileFromText(
      'Experience\nAnalyst, Acme 2019 - 2021\nReferences\nPython developer, Python, Tableau, SQL',
    );
    expect(r.skills).toEqual([]);
  });
});
