import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks a production build when one exists in dist/ (`vite build`; skipped otherwise): no chunk
 * may create a Zod schema without the jitless setting having run first, or Zod's `new Function`
 * probe is reported as a CSP violation. Whatever the chunk layout, every chunk that contains
 * Zod's eval probe must contain the `jitless` setting itself, or import a chunk that does.
 */
const dist = join(__dirname, '../../dist/assets');
const built = existsSync(dist);

describe.skipIf(!built)('the production build', () => {
  it('sets zod jitless in the module every chunk with zod depends on', () => {
    const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
    const text = new Map(files.map((f) => [f, readFileSync(join(dist, f), 'utf8')]));
    const setsJitless = (t: string) => /jitless\s*:\s*(?:!0|true)/.test(t);
    const hasProbe = (t: string) => /Function\(\s*(?:`{2}|"{2}|'{2})\s*\)/.test(t);
    const probes = files.filter((f) => hasProbe(text.get(f)!));
    expect(probes.length).toBeGreaterThan(0);
    for (const f of probes) {
      const t = text.get(f)!;
      const reachable = [f, ...[...t.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].map((m) => m[1]!)];
      expect(
        reachable.some((r) => setsJitless(text.get(r) ?? '')),
        `${f} has zod's eval probe but nothing that sets jitless`,
      ).toBe(true);
    }
  });
});
