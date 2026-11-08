import { describe, expect, it } from 'vitest';
import { MAX_CV_TAILOR_OUTPUT } from './limits';
import { tailorCv } from './fixtures/texts';
import { checkTailoredOutput, parseTailorOutput } from './output';

const GOOD = `SUMMARY
Operations analyst moving toward business operations.

EXPERIENCE
Operations Analyst, Acme Widgets Ltd    Mar 2018 - Jun 2021
- Handled 300 orders a week and built dashboards in Power BI.
- Wrote SQL queries to find late deliveries.

SKILLS
SQL, Excel, Power BI, Jira

===NOTES===
gap: Python scripting for report automation
gap: Tableau dashboards
keyword: "project management" is shown as "weekly reviews"
`;

describe('parseTailorOutput', () => {
  it('parses the specified format', () => {
    const r = parseTailorOutput(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections.summary).toBe('Operations analyst moving toward business operations.');
    expect(r.sections.experience).toContain('- Wrote SQL queries');
    expect(r.sections.skills).toBe('SQL, Excel, Power BI, Jira');
    expect(r.gaps).toEqual(['Python scripting for report automation', 'Tableau dashboards']);
    expect(r.keywords).toHaveLength(1);
    expect(r.hasNotes).toBe(true);
    expect(r.text).not.toContain('NOTES');
    expect(r.text).not.toContain('gap:');
  });

  it('tolerates case, markdown decoration, extra spaces and a preamble', () => {
    const sloppy = `Here is your CV:
## Summary
  Analyst.
**Experience:**
- Did things
  SKILLS :   SQL, Excel
 === notes ===
 - GAP :   Python
* Keyword:  reporting
Something else the model said`;
    const r = parseTailorOutput(sloppy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections).toEqual({
      summary: 'Analyst.',
      experience: '- Did things',
      skills: 'SQL, Excel',
    });
    expect(r.gaps).toEqual(['Python']);
    expect(r.keywords).toEqual(['reporting']);
  });

  it('parses a heading with its text on the same line', () => {
    const r = parseTailorOutput('SUMMARY: One line.\nEXPERIENCE: - a\nSKILLS: SQL');
    expect(r.ok && r.sections.summary).toBe('One line.');
  });

  it('a missing ===NOTES=== still parses, without notes', () => {
    const r = parseTailorOutput(GOOD.split('===NOTES===')[0] as string);
    expect(r.ok && r.hasNotes).toBe(false);
    expect(r.ok && r.gaps).toEqual([]);
  });

  it('a wrong format returns the plain text so the UI can warn', () => {
    for (const raw of [
      'I cannot help with that.',
      '  Dear hiring manager, here is a rewritten CV.\n- one\n- two  ',
      'SUMMARY\nOnly a summary\nSKILLS\nSQL',
      '',
    ]) {
      const r = parseTailorOutput(raw);
      expect(r).toEqual({ ok: false, plainText: raw.trim() });
    }
  });

  it('does not treat a bullet that starts with "Skills" as a heading', () => {
    const r = parseTailorOutput(
      'SUMMARY\nx\nEXPERIENCE\n- Skills training for the team\nSKILLS\nSQL',
    );
    expect(r.ok && r.sections.experience).toBe('- Skills training for the team');
  });

  it('keeps notes at most 200 characters', () => {
    const r = parseTailorOutput(`${GOOD}gap: ${'x'.repeat(500)}`);
    expect(r.ok && Math.max(...r.gaps.map((g) => g.length))).toBe(200);
  });
});

const kinds = (out: string, cv = tailorCv, opts = {}) =>
  checkTailoredOutput(out, cv, opts).flags.map((f) => `${f.kind}:${f.text}`);

describe('checkTailoredOutput', () => {
  it('passes a faithful rewrite with no flags', () => {
    const parsed = parseTailorOutput(GOOD);
    if (!parsed.ok) throw new Error('parse');
    const r = checkTailoredOutput(parsed.text, tailorCv);
    expect(r.flags).toEqual([]);
    expect(r.redacted).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('flags an invented number (30 copied from an example), not one in the CV', () => {
    const f = kinds('- Handled 300 orders a week\n- Cut report time by 30%\n- Led a team of 17');
    expect(f).toContain('number:30%');
    expect(f).toContain('number:17');
    expect(f.some((x) => x.startsWith('number:300'))).toBe(false);
  });

  it('does not match a number inside another number (30 is not in 300)', () => {
    expect(kinds('Handled 30 orders')).toContain('number:30');
  });

  it('flags an invented tool or skill from the catalog, not one the CV shows', () => {
    const f = kinds('Skills: SQL, Tableau, Python, Excel');
    expect(f).toContain('skill:Tableau');
    expect(f).toContain('skill:Python');
    expect(f.some((x) => x.includes('SQL'))).toBe(false);
    expect(f.some((x) => x.includes('Excel'))).toBe(false);
  });

  it('flags a catalog skill that is not a tool label (matched by keyword)', () => {
    const f = kinds('Ran daily scrum meetings and kept the kanban board tidy');
    expect(f.some((x) => x.startsWith('skill:'))).toBe(true);
  });

  it('flags a certificate and a degree the CV lacks, and accepts the CV degree spelled B.Sc / BSc', () => {
    const f = kinds('PMP certified. MBA from Elsewhere. BSc in Industrial Engineering');
    expect(f).toContain('certificate:PMP');
    expect(f).toContain('degree:MBA');
    expect(f.some((x) => x.startsWith('degree:BSc'))).toBe(false);
  });

  it('flags an employer-like phrase the CV lacks, not employers in the CV', () => {
    const f = kinds(
      'Operations Analyst, Acme Widgets Ltd\nOperations Lead, Initech Systems Ltd\n- Led Weekly Reviews for Globex Corp',
    );
    expect(f).toContain('term:Initech Systems Ltd');
    expect(f.some((x) => x.includes('Acme'))).toBe(false);
    expect(f.some((x) => x.includes('Globex'))).toBe(false);
    expect(f.some((x) => x.includes('Weekly Reviews'))).toBe(false);
  });

  it('allows capitalised words from the target role', () => {
    expect(
      kinds('Aiming for Business Operations Analyst', tailorCv, {
        targetRole: 'Business Operations Analyst',
      }),
    ).toEqual([]);
    expect(kinds('Aiming for Business Operations Analyst')).toContain(
      'term:Business Operations Analyst',
    );
  });

  it('removes personal details from the output and counts them', () => {
    const r = checkTailoredOutput(
      'Contact me: eve@example.org or https://eve.example.org',
      tailorCv,
    );
    expect(r.text).not.toMatch(/eve@|example\.org/);
    expect(r.redacted).toBeGreaterThanOrEqual(2);
    const known = checkTailoredOutput('Prepared for Dana', tailorCv, {
      knownIdentifiers: ['Dana'],
    });
    expect(known.text).toBe('Prepared for [removed]');
  });

  it('keeps tool names like ASP.NET and monday.com when removing personal details', () => {
    const r = checkTailoredOutput('Skills: ASP.NET, monday.com', 'ASP.NET and monday.com');
    expect(r.text).toBe('Skills: ASP.NET, monday.com');
    expect(r.redacted).toBe(0);
  });

  it('allows [number?] and counts it, but flags every other bracketed placeholder', () => {
    const r = checkTailoredOutput(
      '- Cut delays by [number?]\n- Managed [number?] vendors\n- Reported to [Your Name] at [Company]\n- [removed] stays',
      tailorCv,
    );
    expect(r.numberPlaceholders).toBe(2);
    expect(r.removedMarkers).toBe(1);
    const f = r.flags.map((x) => `${x.kind}:${x.text}`);
    expect(f).toEqual(expect.arrayContaining(['placeholder:[Your Name]', 'placeholder:[Company]']));
    expect(f.some((x) => x.includes('number?'))).toBe(false);
    expect(f.some((x) => x.startsWith('number:'))).toBe(false);
  });

  it('removes control characters and cuts at a line boundary at the limit', () => {
    const line = '- Wrote clear notes for the team\n';
    const r = checkTailoredOutput(`\u0000${line.repeat(400)}`, tailorCv);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_CV_TAILOR_OUTPUT);
    expect(r.text).not.toContain('\u0000');
    expect(r.text.endsWith('team')).toBe(true);
  });

  it('is linear: 6000 characters in under 50 ms', () => {
    const text = '- Built Power BI dashboards for Acme Widgets Ltd with 300 orders\n'.repeat(95);
    const t = performance.now();
    checkTailoredOutput(text, tailorCv);
    expect(performance.now() - t).toBeLessThan(50);
  });
});
