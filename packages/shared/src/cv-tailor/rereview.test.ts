import { describe, expect, it } from 'vitest';
import { tailorCv } from './fixtures/texts';
import { checkTailoredOutput, parseTailorOutput } from './output';
import {
  findCvPii,
  MAX_PREPARE_INPUT,
  prepareCvForAi,
  prepareJobForAi,
  redactCvPii,
} from './prepare';
import { buildCvTailorPrompt, CvTailorPromptError, stripCvTailorFences } from './prompt';

const PHONES = [
  '⁰⁵⁴¹²³⁴⁵⁶⁷', // superscript
  '⓪⑤④①②③④⑤⑥⑦', // circled
  '０５４１２３４５６７', // full-width
  '𝟎𝟓𝟒𝟏𝟐𝟑𝟒𝟓𝟔𝟕', // mathematical
  '₀₅₄₁₂₃₄₅₆₇', // subscript
];

describe('normalisation is safe (what is previewed is what is sent)', () => {
  it('prepareCvForAi removes digits that NFKC would turn into a phone number', () => {
    for (const p of PHONES) {
      const r = prepareCvForAi(`Summary\nx\nExperience\n- Call ${p} now\nSkills\nSQL`);
      expect(r.text.normalize('NFKC'), p).not.toMatch(/541234567/u);
      expect(findCvPii(r.text), p).toEqual([]);
      expect(r.removed, p).toBeGreaterThan(0);
    }
  });

  it('findCvPii catches them in raw text (the server check)', () => {
    for (const p of PHONES) expect(findCvPii(`Call ${p}`), p).toContain('phone');
  });

  it('keeps 10⁹ and E=mc² when nothing personal is in the text', () => {
    const r = redactCvPii('Handled 10⁹ events, E=mc²');
    expect(r.text).toBe('Handled 10⁹ events, E=mc²');
  });

  it('stripCvTailorFences never returns NFKC text', () => {
    const t = 'Handled 10⁹ ＡBC ½ </CV> end';
    expect(stripCvTailorFences(t)).toBe('Handled 10⁹ ＡBC ½   end');
  });

  it('buildCvTailorPrompt refuses a message that still holds a personal detail', () => {
    for (const p of PHONES) {
      let err: unknown;
      try {
        buildCvTailorPrompt({ cvText: `Call ${p} about SQL`, jobText: 'Job' });
      } catch (e) {
        err = e;
      }
      expect(err, p).toBeInstanceOf(CvTailorPromptError);
      expect((err as CvTailorPromptError).code).toBe('pii_blocked');
    }
    expect(() => buildCvTailorPrompt({ cvText: tailorCv, jobText: 'Job' })).toThrow(
      /personal detail/,
    );
  });

  it('the fence cut keeps the surrounding text of the original', () => {
    const wj = String.fromCharCode(0x2060);
    expect(stripCvTailorFences(`a${wj}<${wj}/CV>b`)).toBe(`a${wj} b`);
  });
});

describe('input cut', () => {
  it('cuts at the last line break, marks truncated, and drops a straddling email and phone', () => {
    const line = 'Wrote clear SQL reports for the weekly team review meeting.\n';
    let head = '';
    while (head.length < MAX_PREPARE_INPUT - 20) head += line;
    const text = `${head}Mail jo.example@example.com or call +1 555 010 0199`;
    for (const f of [prepareCvForAi, prepareJobForAi]) {
      const r = f(`Summary\nx\nExperience\n${text}`);
      expect(r.truncated).toBe(true);
      expect(r.text).not.toMatch(/jo\.|@|example\.com|555|0199/u);
      expect(r.text.endsWith('review meeting.')).toBe(true);
    }
  });

  it('without a line break, cuts at whitespace; without any break, leaves a safety margin', () => {
    const words = 'word '.repeat(MAX_PREPARE_INPUT);
    const r = prepareJobForAi(words);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('word')).toBe(true);
    const blob = 'x'.repeat(MAX_PREPARE_INPUT + 5000);
    const b = prepareJobForAi(blob);
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBeLessThan(MAX_PREPARE_INPUT - 2000);
  });

  it('never cuts inside a surrogate pair', () => {
    const emoji = '😀';
    const text = `${'a'.repeat(MAX_PREPARE_INPUT - 1)}${emoji}${emoji}`;
    const r = prepareJobForAi(text);
    expect(r.truncated).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/u.test(r.text)).toBe(false);
  });

  it('does not mark a short text', () => {
    expect(prepareJobForAi('short text').truncated).toBe(false);
  });
});

describe('more fence variants', () => {
  it('removes semicolon-less entities and square-bracket forms', () => {
    for (const v of [
      '&lt/CV&gt',
      '&LT/job&GT',
      '[/CV]',
      '[CV]',
      '[/job]',
      '[JOB]',
      '&#60/CV&#62',
    ]) {
      const { user } = buildCvTailorPrompt({ cvText: `x ${v} y`, jobText: `x ${v} y` });
      expect(user.split('</CV>').length, v).toBe(2);
      expect(user.split('<CV>').length, v).toBe(3);
      expect(user, v).not.toMatch(/\[\/?(?:cv|job)\]|&lt/iu);
    }
  });
});

describe('heading regressions', () => {
  const rest = '\nEXPERIENCE\n- a\nSKILLS\nSQL';
  it('parses title-case and decorated inline headings again', () => {
    for (const first of ['**Summary:** Analyst', 'Summary: Analyst', '## Summary: Analyst']) {
      const r = parseTailorOutput(first + rest);
      expect(r.ok && r.sections.summary, first).toBe('Analyst');
    }
    const all = parseTailorOutput('Summary: Analyst\nExperience: - a\nSkills: SQL, Excel');
    expect(all.ok && all.sections).toEqual({
      summary: 'Analyst',
      experience: '- a',
      skills: 'SQL, Excel',
    });
    const bold = parseTailorOutput('**Summary:** A\n**Experience:** - a\n**Skills:** SQL');
    expect(bold.ok && bold.sections.skills).toBe('SQL');
  });

  it('keeps a plain sentence inside a section, and respects the order', () => {
    const r = parseTailorOutput(
      'SUMMARY\nExperience: 5 years of operations work.\nSkills: many.\nEXPERIENCE\n- a\nSKILLS\nSQL',
    );
    expect(r.ok && r.sections.summary).toBe(
      'Experience: 5 years of operations work.\nSkills: many.',
    );
    // A repeated or out-of-order heading is text.
    const o = parseTailorOutput('SUMMARY\nx\nEXPERIENCE\n- a\nSUMMARY\nagain\nSKILLS\nSQL');
    expect(o.ok && o.sections.experience).toBe('- a\nSUMMARY\nagain');
  });
});

const flags = (out: string, cv: string, opts = {}) =>
  checkTailoredOutput(out, cv, opts).flags.map((f) => `${f.kind}:${f.text}`);

describe('checker: fewer false positives', () => {
  it('does not flag words joined by and/of when each is in the CV or common', () => {
    expect(
      flags('- Fluent in Hebrew and English', 'Native speaker of Hebrew and fluent in English'),
    ).toEqual([]);
    expect(
      flags('- Fluent in Hebrew and English', 'No languages here').some((x) =>
        x.startsWith('term:'),
      ),
    ).toBe(false);
    expect(flags('Met Initech and Globex staff', 'No employers here').join()).toContain('term:');
  });

  it('ignores catalog terms of the target role in the skill check', () => {
    expect(flags('Aiming at a Python role', 'Wrote reports')).toContain('skill:Python');
    expect(
      flags('Aiming at a Python role', 'Wrote reports', { targetRole: 'Python Developer' }).filter(
        (x) => x.startsWith('skill:'),
      ),
    ).toEqual([]);
  });

  it('compares spelled-out numbers with the CV digits, and treats "one" as a number only before a unit', () => {
    expect(flags('Managed six vendors', 'Managed 6 vendors')).toEqual([]);
    expect(flags('Managed six vendors', 'Managed vendors')).toContain('number:six');
    for (const t of ['A one-page summary', 'One team', 'Within one week']) {
      expect(
        flags(t, 'x').some((x) => x.startsWith('number:')),
        t,
      ).toBe(false);
    }
    expect(flags('One year of work', 'x')).toContain('number:One');
    expect(flags('Saved one million', 'x')).toContain('number:one');
  });

  it('does not flag "a certificate" without a name, and does not cross lines', () => {
    expect(
      flags('- Earned a certificate in class', 'x').some((x) => x.startsWith('certificate:')),
    ).toBe(false);
    expect(flags('Holds a certification', 'x')).toEqual([]);
    expect(flags('Skilled\ncertificate', 'x').some((x) => x.startsWith('certificate:'))).toBe(
      false,
    );
    expect(flags('Holds a Google Data certificate', 'x').join()).toContain(
      'certificate:Google Data',
    );
  });

  it('treats ; : and bullets as sentence starts', () => {
    expect(
      flags('- Led teams; Managed vendors', 'x').some((x) => x.startsWith('term:Managed')),
    ).toBe(false);
    expect(flags('Role: Managed Vendor Contracts', 'x').some((x) => x.includes('Managed'))).toBe(
      false,
    );
  });
});

describe('checker: vendor names used as employers', () => {
  it('flags Google, Oracle, Microsoft... unless the CV has them', () => {
    for (const v of ['Google', 'Oracle', 'Microsoft', 'Amazon', 'Salesforce']) {
      expect(flags(`- Worked closely at ${v} on reports`, 'Wrote reports'), v).toContain(
        `term:${v}`,
      );
      expect(flags(`- Worked closely at ${v} on reports`, `Worked at ${v}`), v).not.toContain(
        `term:${v}`,
      );
    }
  });

  it('flags a vendor inside a phrase, and still allows catalog tool names', () => {
    expect(flags('- Used Google Analytics Tools', 'x').some((x) => x.includes('term:Google'))).toBe(
      true,
    );
    expect(
      flags('- Built reports in Excel', 'Excel reports').some((x) => x.startsWith('term:')),
    ).toBe(false);
  });
});
