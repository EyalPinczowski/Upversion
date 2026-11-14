import { describe, expect, it } from 'vitest';

/**
 * ADR 017: the plan builder page is its own chunk. Nothing in the main bundle may import it
 * statically, and the web never imports the builder or the bundled catalog at all (the API runs
 * the builder). This checks the source; `pnpm --filter @upversion/web build` shows the chunks.
 */
const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

describe('the plan builder chunk', () => {
  it('sees the source files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(([path]) => path.endsWith('/pages/plan-builder/PlanBuilderPage.tsx'))).toBe(
      true,
    );
  });

  it('is loaded only through a dynamic import() in App.tsx', () => {
    const app = sources['../App.tsx']!;
    expect(app).toMatch(/lazy\(\(\) =>\s*import\('\.\/pages\/plan-builder\/PlanBuilderPage'\)/);
    const importers = files.filter(
      ([path, text]) =>
        !path.includes('/pages/plan-builder/') &&
        /from\s+['"][^'"]*pages\/plan-builder\/[^'"]*['"]/.test(text),
    );
    expect(importers.map(([path]) => path)).toEqual([]);
  });

  it('never imports @upversion/shared/plan-builder (the builder and its catalog stay on the API)', () => {
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/(?:from|import\()\s*['"]@upversion\/shared\/plan-builder/);
    }
  });
});
