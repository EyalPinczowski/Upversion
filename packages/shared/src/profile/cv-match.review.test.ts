import { describe, expect, it } from 'vitest';
import { extractProfileFromText } from './cv-match';
import { CV_NOW } from './fixtures/cvs';
import type { MatchTaxonomy } from './types';

const runReal = (text: string) => extractProfileFromText(text, { now: CV_NOW });
const run = (text: string, taxonomy: MatchTaxonomy) =>
  extractProfileFromText(text, { now: CV_NOW, taxonomy, tools: [] });

const timed = (text: string): number => {
  const t0 = performance.now();
  runReal(text);
  return performance.now() - t0;
};

describe('hostile input', () => {
  it('whitespace and separator runs finish quickly, a 1 MB input too', () => {
    runReal('warm up');
    expect(timed('a' + ' '.repeat(1e5) + 'b')).toBeLessThan(300);
    expect(timed('Experience\n' + 'a' + ': '.repeat(5e4) + 'b')).toBeLessThan(300);
    expect(timed('Experience\n' + ' -'.repeat(5e4))).toBeLessThan(300);
    expect(timed('Experience\n' + 'Analyst' + ' -'.repeat(5e4) + ' x')).toBeLessThan(300);
    expect(timed('x'.repeat(1e6))).toBeLessThan(500);
    expect(timed('Experience\n' + 'Excel SQL\n'.repeat(1e5))).toBeLessThan(2000);
  });
});

describe('line cap and privacy', () => {
  it('an email or phone number straddling the line cap never leaves a fragment', () => {
    for (let pad = 1955; pad <= 1995; pad += 1) {
      const filler = 'w'.repeat(pad);
      for (const tail of ['noalevinson@gmail.com', '+1 555 010 0199 call me']) {
        const out = JSON.stringify(
          extractProfileFromText(`Experience\n${filler} Excel ${tail}`, {
            now: CV_NOW,
            tools: ['Excel'],
          }),
        );
        expect(out).not.toMatch(/noale|@|555|010/);
      }
    }
  });

  it('a Contact section after the first heading is dropped like the pre-heading block', () => {
    const r = extractProfileFromText(
      'Experience\nAnalyst 2019 - 2021\nContact\nDana Example, 12 Herzl Street, Excel\nSkills\nSQL',
      { now: CV_NOW, tools: ['Excel', 'SQL'] },
    );
    expect(r.tools.find((t) => t.tool === 'Excel')?.evidence).toBe('');
    expect(JSON.stringify(r)).not.toMatch(/Herzl|Dana/);
    const he = extractProfileFromText('Experience\nAnalyst 2019 - 2021\nפרטי קשר\nDana Excel\n', {
      now: CV_NOW,
      tools: ['Excel'],
    });
    expect(he.tools[0]?.evidence).toBe('');
  });
});

describe('titles and dates', () => {
  it('a title without a date does not borrow the next entry date', () => {
    const r = runReal('Experience\nOperations Analyst\nData Analyst 2019 - 2021');
    const ops = r.rolesHeld.find((x) => x.roleId === 'operations-associate');
    expect(ops?.years).toBeNull();
    const data = r.rolesHeld.find((x) => x.roleId === 'data-analyst');
    expect(data?.years).toBe(2);
  });

  it('parses 05.2010 - 06.2011 and ISO 2012-03 – 2013-06', () => {
    const y = (d: string) => runReal(`Experience\nOperations Analyst, Acme ${d}`).yearsExperience;
    expect(y('05.2010 - 06.2011')).toBe(1);
    expect(y('2012-03 – 2013-06')).toBe(1.5);
    expect(y('2019-2021')).toBe(2);
  });

  it('a range ending in the future is capped at now, not discarded', () => {
    const r = runReal('Experience\nOperations Analyst, Acme 2024 – 2030');
    expect(r.yearsExperience).toBe(2.5);
    expect(runReal('Experience\nAnalyst 2030 – 2032').yearsExperience).toBeNull();
  });
});

describe('tokens and precision', () => {
  it('Hebrew prefix letters joined to a Latin term are split off', () => {
    const r = extractProfileFromText('כישורים\nבSQL ובPython', {
      now: CV_NOW,
      tools: ['SQL', 'Python'],
    });
    expect(r.tools.map((t) => t.tool)).toEqual(['SQL', 'Python']);
  });

  const taxonomy: MatchTaxonomy = {
    skills: [
      { id: 'nc', name: 'No-code tools', keywords: ['no-code'] },
      { id: 'auto', name: 'Automation', keywords: ['make', 'zapier'] },
      { id: 'pm', name: 'Project management', keywords: ['scope', 'milestones'] },
    ],
    roles: [],
  };

  it('a hyphenated keyword is strong only in its hyphenated form', () => {
    expect(run('Experience\nWe have a no code of conduct.', taxonomy).skills).toEqual([]);
    const ok = run('Experience\nBuilt no-code tools.', taxonomy);
    expect(ok.skills).toEqual([expect.objectContaining({ skillId: 'nc', strength: 'strong' })]);
  });

  it('the skill keyword "make" needs automation context', () => {
    const plain = run('Experience\nMake sure the plan works.\nUsed zapier.', taxonomy);
    expect(plain.skills).toEqual([]);
    const ctx = run('Experience\nBuilt Make automation flows.\nUsed zapier.', taxonomy);
    expect(ctx.skills).toEqual([expect.objectContaining({ skillId: 'auto' })]);
  });

  it('the same weak term on two lines is one weak hit', () => {
    expect(run('Experience\nManaged scope.\nReviewed scope again.', taxonomy).skills).toEqual([]);
    expect(run('Experience\nManaged scope.\nTracked milestones.', taxonomy).skills).toHaveLength(1);
  });
});
