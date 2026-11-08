import { describe, expect, it } from 'vitest';
import { CATALOG_TAXONOMY } from '../profile/catalog';
import { dropContactLines, extractProfileFromText, matchSkillsInText } from '../profile/cv-match';
import { tailorCv, tailorJob } from './fixtures/texts';
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
