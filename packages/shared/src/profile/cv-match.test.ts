import { describe, expect, it } from 'vitest';
import { extractProfileFromText, MAX_EVIDENCE_LENGTH } from './cv-match';
import {
  analystCv,
  CANARY,
  changerCv,
  CONTACT_STRINGS,
  CV_NOW,
  hebrewCv,
  noSectionsCv,
  opsCv,
  twoColumnCv,
} from './fixtures/cvs';
import type { MatchTaxonomy } from './types';

const run = (text: string, taxonomy?: MatchTaxonomy) =>
  extractProfileFromText(text, { now: CV_NOW, taxonomy, tools: ['Excel', 'SQL', 'Jira'] });
const runReal = (text: string) => extractProfileFromText(text, { now: CV_NOW });

const ALL = {
  opsCv,
  analystCv,
  changerCv,
  hebrewCv,
  twoColumnCv,
  noSectionsCv,
};

const ids = (r: ReturnType<typeof runReal>) => r.skills.map((s) => s.skillId);

describe('evidence snippets', () => {
  const long =
    'Junior Data Analyst, Example Retail Ltd. Built weekly sales dashboards in Excel and Power BI. Wrote SQL queries against a PostgreSQL warehouse every single day.';

  it('keep the matched word when a long token runs into it', () => {
    const line = `${'a'.repeat(45)}/SQL ${'b '.repeat(30)}`;
    const r = runReal(`Experience\n${line}\nSkills: Excel`);
    const sql = r.tools.find((t) => t.tool === 'SQL');
    expect(sql).toBeDefined();
    expect(sql?.evidence).toContain('SQL');
    expect(sql!.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_LENGTH);
  });

  it('cut on word boundaries and mark each cut with an ellipsis', () => {
    const r = runReal(`Experience\n${long}\nSkills: SQL, Excel`);
    const snippets = [...r.skills.map((s) => s.evidence), ...r.tools.map((t) => t.evidence)].filter(
      (e) => e.length > 0,
    );
    expect(snippets.some((e) => e.startsWith('…') || e.endsWith('…'))).toBe(true);
    const words = long.split(/\s+/u);
    for (const e of snippets) {
      expect(e.length).toBeLessThanOrEqual(MAX_EVIDENCE_LENGTH);
      const body = e.replace(/^…/u, '').replace(/…$/u, '');
      // Every word in the snippet is a whole word of the source line.
      for (const w of body.split(' ')) expect(words).toContain(w);
    }
  });
});

describe('normal CV', () => {
  const r = runReal(opsCv);

  it('suggests skills with levels, strength and the default checkbox', () => {
    const pm = r.skills.find((s) => s.skillId === 'project-management');
    expect(pm).toMatchObject({ strength: 'strong', checked: true, level: 2 });
    expect(ids(r)).toContain('bi-visualization');
    // Listed under Skills only: Basic.
    expect(r.skills.find((s) => s.skillId === 'sql')?.level).toBe(1);
  });

  it('finds roles with years, total years, education and tools', () => {
    expect(r.rolesHeld).toEqual([
      expect.objectContaining({
        roleId: 'operations-associate',
        title: 'Operations Analyst',
        years: 3.5,
      }),
      expect.objectContaining({
        roleId: 'operations-associate',
        title: 'Operations Manager (junior)',
        years: 4.5,
      }),
    ]);
    expect(r.yearsExperience).toBe(7.5);
    expect(r.education?.value).toBe('bachelor');
    expect(r.tools.map((t) => t.tool)).toEqual(['Excel', 'SQL', 'Jira', 'Power BI']);
  });

  it('never guesses level 0 or 3', () => {
    for (const cv of Object.values(ALL)) {
      for (const s of runReal(cv).skills) expect([1, 2]).toContain(s.level);
    }
  });
});

describe('analyst, career changer, two-column', () => {
  it('data analyst', () => {
    const r = runReal(analystCv);
    expect(r.rolesHeld.map((x) => x.roleId)).toContain('data-analyst');
    expect(r.yearsExperience).toBe(6);
    expect(r.education?.value).toBe('master');
    expect(r.tools.map((t) => t.tool)).toEqual(['Excel', 'SQL', 'Tableau', 'Python']);
  });

  it('career changer: unmatched title is offered unchecked, bootcamp does not beat a degree', () => {
    const r = runReal(changerCv);
    expect(r.rolesHeld).toEqual([
      expect.objectContaining({
        roleId: null,
        title: 'High School Teacher',
        checked: false,
        years: 12,
      }),
    ]);
    // "High School" sits in an experience title and must not count as education.
    expect(r.education?.value).toBe('bachelor');
    expect(r.yearsExperience).toBe(12);
  });

  it('two-column order: bag-of-words still works, years from the date range', () => {
    const r = runReal(twoColumnCv);
    expect(r.tools.map((t) => t.tool)).toEqual(['Excel', 'SQL', 'Jira', 'Tableau']);
    expect(r.yearsExperience).toBe(4);
    expect(r.education?.value).toBe('bachelor');
    expect(r.rolesHeld.some((x) => x.roleId === 'operations-associate')).toBe(true);
  });
});

describe('Hebrew lines', () => {
  const r = runReal(hebrewCv);
  it('finds the Latin-script terms and ignores the Hebrew words', () => {
    expect(r.tools.map((t) => t.tool)).toEqual([
      'Excel',
      'SQL',
      'Jira',
      'Power BI',
      'Zapier / Make',
    ]);
    expect(r.education?.value).toBe('bachelor');
    expect(r.yearsExperience).toBe(4);
    expect(r.rolesHeld).toEqual([
      expect.objectContaining({ roleId: null, title: 'מנהל תפעול', checked: false, years: 4 }),
    ]);
  });
});

describe('privacy', () => {
  for (const [name, cv] of Object.entries(ALL)) {
    it(`${name}: no contact detail and no canary in the output`, () => {
      const json = JSON.stringify(runReal(cv));
      for (const c of CONTACT_STRINGS) expect(json).not.toContain(c);
      expect(json).not.toContain(CANARY);
      expect(json).not.toContain('purple walrus cooperative');
    });
  }

  it('evidence is redacted and at most 80 characters', () => {
    const r = runReal(opsCv);
    const all = [
      ...r.skills.map((s) => s.evidence),
      ...r.rolesHeld.map((x) => x.evidence),
      ...r.tools.map((t) => t.evidence),
      r.education?.evidence ?? '',
    ];
    for (const e of all) expect(e.length).toBeLessThanOrEqual(MAX_EVIDENCE_LENGTH);
    // The line with a URL and an email still gives evidence, with both removed.
    const portfolio = runReal(
      'Experience\nPortfolio at www.dana-example.com and dana.example@example.com using Excel',
    );
    expect(portfolio.tools[0]?.evidence).toContain('Excel');
    expect(portfolio.tools[0]?.evidence).not.toMatch(/dana|example\.com/);
  });

  it('free-text titles are redacted (a title that holds an email is replaced)', () => {
    const r = runReal('Experience\nOperations Analyst dana.example@example.com | 2019 - 2021');
    for (const x of r.rolesHeld) expect(x.title).not.toContain('dana');
  });
});

describe('contact block', () => {
  it('no sections: drops only the first 2 non-empty lines from evidence', () => {
    const text = [
      'Dana Example Excel',
      '',
      'dana.example@example.com SQL',
      'Used Jira daily.',
      'Used Excel daily.',
    ].join('\n');
    const r = extractProfileFromText(text, { now: CV_NOW, tools: ['Excel', 'SQL', 'Jira'] });
    const by = Object.fromEntries(r.tools.map((t) => [t.tool, t.evidence]));
    expect(by.SQL).toBe(''); // only on dropped line 3 (second non-empty line)
    expect(by.Jira).toBe('Used Jira daily.'); // line 4 is kept
    expect(by.Excel).toBe('Used Excel daily.'); // the first hit is on a dropped line, later one is used
  });

  it('with a heading: every line before the first heading is dropped from evidence and titles', () => {
    const text = [
      'Dana Example',
      'Tel Aviv, dana.example@example.com',
      'Excel and SQL wizard, 2010 - 2012',
      'Experience',
      'Used Jira daily.',
    ].join('\n');
    const r = extractProfileFromText(text, { now: CV_NOW, tools: ['Excel', 'SQL', 'Jira'] });
    const by = Object.fromEntries(r.tools.map((t) => [t.tool, t.evidence]));
    expect(by.Excel).toBe('');
    expect(by.SQL).toBe('');
    expect(by.Jira).toBe('Used Jira daily.');
    expect(r.rolesHeld).toEqual([]);
    expect(r.yearsExperience).toBeNull();
  });

  it('no sections CV still reads roles, years and skills on the later lines', () => {
    const r = runReal(noSectionsCv);
    expect(r.rolesHeld[0]).toMatchObject({ roleId: 'operations-associate', years: 3.5 });
    expect(r.yearsExperience).toBe(3.5);
    expect(ids(r)).toContain('project-management');
    expect(r.tools.map((t) => t.tool)).toEqual(['Excel', 'SQL', 'Power BI']);
  });
});

describe('matching rules', () => {
  const taxonomy: MatchTaxonomy = {
    skills: [
      { id: 'dotnet', name: '.NET', keywords: ['ASP.NET'] },
      { id: 'monday', name: 'monday.com', keywords: [] },
      {
        id: 'pm',
        name: 'Project management',
        keywords: ['scope', 'milestones', 'risk management'],
      },
    ],
    roles: [],
  };

  it('ASP.NET and monday.com are matched on the raw text, not split or redacted away', () => {
    const r = run('Skills\nASP.NET, monday.com', taxonomy);
    expect(r.skills.map((s) => s.skillId).sort()).toEqual(['dotnet', 'monday']);
    expect(r.skills.every((s) => s.checked)).toBe(true);
  });

  it('one weak single-word hit alone suggests nothing; two do; a Skills section does', () => {
    expect(run('Experience\nResponsible for scope.', taxonomy).skills).toEqual([]);
    const two = run('Experience\nManaged scope.\nTracked milestones.', taxonomy);
    expect(two.skills).toEqual([
      expect.objectContaining({ skillId: 'pm', strength: 'weak', checked: false }),
    ]);
    const skills = run('Skills\nscope', taxonomy);
    expect(skills.skills).toEqual([expect.objectContaining({ skillId: 'pm', checked: true })]);
  });

  it('a multi-word keyword is a strong hit on its own', () => {
    const r = run('Experience\nDid risk management for a bank.', taxonomy);
    expect(r.skills).toEqual([
      expect.objectContaining({ skillId: 'pm', strength: 'strong', checked: true }),
    ]);
  });

  it('matches whole words only, case-insensitively', () => {
    expect(run('Skills\nMONDAY.COM', taxonomy).skills.map((s) => s.skillId)).toEqual(['monday']);
    expect(run('Skills\nscopes, ASP.NETWORK', taxonomy).skills).toEqual([]);
  });

  it('level 2 needs an experience entry of 2 or more years', () => {
    const longEntry = run('Experience\nAnalyst 2018 - 2022\n- risk management', taxonomy);
    expect(longEntry.skills[0]?.level).toBe(2);
    const shortEntry = run('Experience\nAnalyst 2021 - 2022\n- risk management', taxonomy);
    expect(shortEntry.skills[0]?.level).toBe(1);
  });

  it('ambiguous English words are not tools: Make, Notion, Excel', () => {
    const none = extractProfileFromText('Experience\nMake sure the notion of excel holds.', {
      now: CV_NOW,
    });
    expect(none.tools).toEqual([]);
    const some = extractProfileFromText('Experience\nBuilt Zapier / Make automation flows.', {
      now: CV_NOW,
    });
    expect(some.tools.map((t) => t.tool)).toEqual(['Zapier / Make']);
    const split = extractProfileFromText('Experience\nBuilt flows in Zapier.', { now: CV_NOW });
    expect(split.tools.map((t) => t.tool)).toEqual(['Zapier / Make']);
  });
});

describe('date ranges', () => {
  const years = (line: string) =>
    runReal(`Experience\nOperations Analyst, Acme ${line}`).yearsExperience;

  it('2019 – 2023', () => expect(years('2019 – 2023')).toBe(4));
  it('Jan 2020 – Present uses the given now', () => expect(years('Jan 2020 – Present')).toBe(6.5));
  it('03/2018 - 06/2021', () => expect(years('03/2018 - 06/2021')).toBe(3.5));
  it('other dashes and "to"', () => {
    expect(years('2019 — 2021')).toBe(2);
    expect(years('2019 to 2021')).toBe(2);
    expect(years('2019-2021')).toBe(2);
  });

  it('date on the next line pairs with the title line', () => {
    const r = runReal('Experience\nOperations Analyst, Acme\nMarch 2019 - March 2021');
    expect(r.rolesHeld[0]).toMatchObject({ roleId: 'operations-associate', years: 2 });
  });

  it('overlapping ranges count once, total is capped at 50', () => {
    expect(runReal('Experience\nAnalyst 2019 - 2021\nConsultant 2020 - 2022').yearsExperience).toBe(
      3,
    );
    const long = runReal('Experience\nAnalyst 1950 - 2026');
    expect(long.yearsExperience).toBeLessThanOrEqual(50);
  });

  it('ranges outside the experience section are ignored', () => {
    expect(
      runReal('Education\nBSc 2012 - 2016\nExperience\nAnalyst 2020 - 2021').yearsExperience,
    ).toBe(1);
    expect(runReal('Education\nBSc 2012 - 2016').yearsExperience).toBeNull();
  });
});

describe('education', () => {
  const edu = (line: string) => runReal(`Education\n${line}`).education?.value ?? null;

  it('BA and MA are case-sensitive abbreviations', () => {
    expect(edu('BA in Economics')).toBe('bachelor');
    expect(edu('ba in economics')).toBeNull();
    expect(edu('MA in History')).toBe('master');
    expect(edu('ma in history')).toBeNull();
  });

  it('full words are case-insensitive and the highest level wins', () => {
    expect(edu('bachelor of science')).toBe('bachelor');
    expect(edu('Master of Science')).toBe('master');
    expect(edu('Bachelor of Arts\nMBA')).toBe('master');
    expect(edu('PhD in Physics')).toBe('master');
    expect(edu('B.Sc.')).toBe('bachelor');
    expect(edu('Diploma in marketing')).toBe('some_college');
    expect(edu('Online courses')).toBe('some_college');
    expect(edu('Bagrut certificate')).toBe('high_school');
    expect(edu('Certificate program in UX')).toBe('some_college');
  });

  it('"Scrum Master" in an experience entry is not a degree', () => {
    expect(
      runReal('Experience\nScrum Master, Acme 2020 - 2021\nEducation\nBagrut').education?.value,
    ).toBe('high_school');
  });
});

describe('education scope without an Education section', () => {
  it('experience lines are not read, other lines are', () => {
    expect(runReal('Experience\nScrum Master, Acme 2020 - 2021').education).toBeNull();
    expect(runReal('Experience\nAnalyst 2020 - 2021\nSummary\nBSc graduate').education?.value).toBe(
      'bachelor',
    );
  });
});

describe('performance and safety', () => {
  it('a 10-page CV is read in under 50 ms', () => {
    const page = opsCv.repeat(6); // about 60 lines per page
    const tenPages = page.repeat(10);
    runReal(opsCv); // build the term index once
    const t0 = performance.now();
    runReal(tenPages);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('hostile input stays linear', () => {
    const hostile = [
      'Experience',
      'a.'.repeat(40000),
      '2019 - '.repeat(10000),
      '1/'.repeat(20000),
      'Jan '.repeat(10000),
      ' '.repeat(100000),
    ].join('\n');
    const t0 = performance.now();
    runReal(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('empty text gives an empty result', () => {
    expect(runReal('')).toEqual({
      skills: [],
      rolesHeld: [],
      yearsExperience: null,
      education: null,
      tools: [],
    });
  });
});
