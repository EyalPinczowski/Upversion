import { describe, expect, it } from 'vitest';
import { extractProfileFromText } from './cv-match';
import { toImportPayload } from './cv-payload';
import { CANARY, CONTACT_STRINGS, CV_NOW, opsCv } from './fixtures/cvs';
import { ProfileImportSchema } from './schemas';

const extraction = extractProfileFromText(opsCv, { now: CV_NOW });

/** Everything the review screen holds, evidence and raw text included. */
const confirmed = {
  skills: extraction.skills,
  rolesHeld: extraction.rolesHeld,
  yearsExperience: extraction.yearsExperience,
  education: extraction.education?.value ?? null,
  tools: extraction.tools.map((t) => t.tool),
  rawText: opsCv,
  fileName: 'dana-example-cv.pdf',
  evidence: CANARY,
};

describe('toImportPayload', () => {
  const payload = toImportPayload(confirmed);

  it('has exactly the allowlisted keys, at every level', () => {
    expect(Object.keys(payload).sort()).toEqual(
      ['education', 'rolesHeld', 'skills', 'tools', 'yearsExperience'].sort(),
    );
    for (const s of payload.skills) expect(Object.keys(s).sort()).toEqual(['level', 'skillId']);
    for (const r of payload.rolesHeld) {
      expect(Object.keys(r).sort()).toEqual(['roleId', 'title', 'years']);
    }
    expect(ProfileImportSchema.safeParse(payload).success).toBe(true);
  });

  it('carries no evidence, raw text, file name, contact detail or canary', () => {
    const json = JSON.stringify(payload);
    for (const c of CONTACT_STRINGS) expect(json).not.toContain(c);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain('purple walrus');
    expect(json).not.toContain('Acme Widgets');
    expect(json).not.toContain('.pdf');
    expect(json).not.toContain('evidence');
  });

  it('keeps the confirmed values', () => {
    expect(payload.yearsExperience).toBe(7.5);
    expect(payload.education).toBe('bachelor');
    expect(payload.tools).toEqual(['Excel', 'SQL', 'Jira', 'Power BI']);
    expect(payload.skills.map((s) => s.skillId)).toContain('project-management');
  });

  it('drops titles holding personal details and unknown ids, clamps levels', () => {
    const p = toImportPayload({
      skills: [
        { skillId: 'excel', level: 9 },
        { skillId: 'excel', level: 1 },
        { skillId: 'not-a-skill', level: 1 },
        { skillId: 'sql', level: -2 },
      ],
      rolesHeld: [
        { roleId: 'data-analyst', title: 'Analyst, mail me at dana.example@example.com', years: 2 },
        { roleId: 'no-such-role', title: '  Teacher  ', years: 70 },
        { title: 'x'.repeat(200) },
      ],
      yearsExperience: 99,
      education: 'wizard',
      tools: ['Excel', 'COBOL'],
    });
    expect(p.skills).toEqual([
      { skillId: 'excel', level: 3 },
      { skillId: 'sql', level: 0 },
    ]);
    expect(p.rolesHeld).toEqual([
      { roleId: null, title: 'Teacher', years: 50 },
      { roleId: null, title: 'x'.repeat(80), years: null },
    ]);
    expect(p.yearsExperience).toBe(50);
    expect(p.education).toBeNull();
    expect(p.tools).toEqual(['Excel']);
  });
});
