import { describe, expect, it } from 'vitest';
import { findPii, knownIdentifiersFor, redactPii } from '../practice/redact';
import { TAILOR_CANARY, TAILOR_CONTACT_STRINGS, tailorCv, tailorJob } from './fixtures/texts';
import { findCvPii, prepareCvForAi, prepareJobForAi, redactCvPii } from './prepare';

const known = knownIdentifiersFor({
  email: 'dana.example@example.com',
  displayName: 'Dana Example',
});

describe('prepareCvForAi', () => {
  const out = prepareCvForAi(tailorCv, { knownIdentifiers: known });

  it('drops the header block, and lists the dropped lines', () => {
    expect(out.text).not.toContain('Imaginary Street');
    expect(out.dropped.join('\n')).toContain('12 Imaginary Street');
    expect(out.dropped.join('\n')).toContain('dana.example@example.com');
  });

  it('drops a References section (other people names and phones)', () => {
    expect(out.text).not.toContain('Riley');
    expect(out.text).not.toContain('555 010 0123');
    expect(out.dropped).toContain('Riley Referee, Example Corp, 555 010 0123');
  });

  it('drops a Contact section later in the CV', () => {
    const r = prepareCvForAi(
      'Summary\nAnalyst.\nExperience\nAnalyst, Acme Ltd 2019 - 2021\nContact\nCall Sam at 555 010 7777\nSkills\nSQL',
    );
    expect(r.text).not.toContain('555');
    expect(r.text).toContain('SQL');
  });

  it('never lets a canary contact detail through, and keeps the body', () => {
    for (const secret of TAILOR_CONTACT_STRINGS) expect(out.text).not.toContain(secret);
    expect(out.text).toContain(TAILOR_CANARY);
    expect(findCvPii(out.text, { knownIdentifiers: known })).toEqual([]);
  });

  it('redacts contact details in the body and counts them', () => {
    const r = prepareCvForAi(
      'Summary\nAnalyst.\nExperience\n- Mail me at dana.example@example.com or see www.dana-example.com, or @dana_example\nSkills\nSQL',
      { knownIdentifiers: known },
    );
    expect(r.text).not.toMatch(/example\.com|@dana/);
    expect(r.removed).toBeGreaterThanOrEqual(3);
  });

  it('keeps ASP.NET and monday.com (tool names), and the redactPii limit is documented by this test', () => {
    expect(out.text).toContain('monday.com');
    expect(out.text).toContain('ASP.NET');
    // Plain redactPii would remove them; this is what the allowance changes.
    expect(redactPii('monday.com, ASP.NET').text).toBe('[removed], [removed]');
  });

  it('with no heading, drops the first two non-empty lines like the matcher', () => {
    const r = prepareCvForAi(
      'Dana Example\ndana.example@example.com\nAnalyst at Acme 2019 - 2021\nUsed SQL',
    );
    expect(r.dropped).toEqual(['Dana Example', 'dana.example@example.com']);
    expect(r.text).toBe('Analyst at Acme 2019 - 2021\nUsed SQL');
  });

  it('neutralises markup and control characters', () => {
    const r = prepareCvForAi('Summary\nHi <b>there</b>\u0000\u202e x\nSkills\nSQL');
    // eslint-disable-next-line no-control-regex
    expect(r.text).not.toMatch(/[<>\u0000\u202e]/u);
  });

  it('is linear: a 6000 character CV in well under 50 ms', () => {
    const big =
      `Summary\nx\nExperience\n${'- Wrote SQL reports and ran Jira boards 2019 - 2021\n'.repeat(120)}`.slice(
        0,
        6000,
      );
    const t = performance.now();
    prepareCvForAi(big, { knownIdentifiers: known });
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('tool-name allowance (shared by browser and server)', () => {
  it('lets ASP.NET and monday.com pass the same check the server runs', () => {
    expect(findCvPii('I used ASP.NET and monday.com daily.')).toEqual([]);
    expect(findPii('I used ASP.NET and monday.com daily.')).toContain('url');
  });

  it('still finds an email or URL that merely contains a tool name', () => {
    for (const bad of [
      'write to jo@monday.com',
      'see https://monday.com/jobs',
      'see www.monday.com',
      'monday.com/login',
      'monday.com.evil.io',
      'visit monday.com:8080',
      'aspx.ASP.NET.com',
    ]) {
      expect(findCvPii(bad).length, bad).toBeGreaterThan(0);
      expect(redactCvPii(bad).count, bad).toBeGreaterThan(0);
    }
  });

  it('accepts a full stop right after the name', () => {
    expect(findCvPii('Built forms in ASP.NET. Then monday.com.')).toEqual([]);
  });

  it('removes a real email next to an allowed name', () => {
    const r = redactCvPii('ASP.NET and jo@example.com and monday.com');
    expect(r.text).toBe('ASP.NET and [removed] and monday.com');
    expect(r.count).toBe(1);
  });

  it('does not allow a name that holds one of the user known identifiers', () => {
    const r = redactCvPii('Worked with monday.com', { knownIdentifiers: ['monday'] });
    expect(r.text).toContain('[removed]');
    expect(findCvPii('Worked with monday.com', { knownIdentifiers: ['monday'] })).toContain(
      'identifier',
    );
  });

  it('gives identical results when the server runs it on the browser output', () => {
    const browser = prepareCvForAi(tailorCv, { knownIdentifiers: known });
    expect(findCvPii(browser.text, { knownIdentifiers: known })).toEqual([]);
  });
});

describe('prepareJobForAi', () => {
  it('keeps the first lines (the title) and redacts contact details', () => {
    const r = prepareJobForAi(`${tailorJob}\nApply: jobs@initech-example.com`);
    expect(r.text.startsWith('Business Operations Analyst, Initech Ltd')).toBe(true);
    expect(r.text).not.toContain('jobs@');
    expect(r.dropped).toEqual([]);
  });
});
