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

/** Files of the first run that only the lazy `FirstRunPage` chunk loads (they share the builder's steps). */
const LAZY_FIRST_RUN = [
  'FirstRunPage.tsx',
  'RoleDiscovery.tsx',
  'CvPrefill.tsx',
  'first-run-model.ts',
];

/** The static imports of a source (`import x from`, `export ... from`, `import 'x'`), not `import()`. */
function staticImports(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');
  return (
    [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base].find(
      (candidate) => candidate in sources,
    ) ?? null
  );
}

/** Every file loaded at start-up from the given entry points: static imports only. */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path) || !(path in sources)) continue;
    seen.add(path);
    for (const spec of staticImports(sources[path]!)) {
      const target = resolve(path, spec);
      if (target) queue.push(target);
    }
  }
  return seen;
}

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
        !LAZY_FIRST_RUN.some((name) => path.endsWith(`/pages/first-run/${name}`)) &&
        /from\s+['"][^'"]*plan-builder\/[^'"]*['"]/.test(text),
    );
    expect(importers.map(([path]) => path)).toEqual([]);
  });

  it('never imports @upversion/shared/plan-builder (the builder and its catalog stay on the API)', () => {
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/(?:from|import\()\s*['"]@upversion\/shared\/plan-builder/);
    }
  });

  it('nothing loaded at start-up (App, the shell, the first-run gate) imports the builder', () => {
    const reachable = reachableFrom(['../main.tsx', '../App.tsx', '../layout/Shell.tsx']);
    expect(reachable.has('../layout/Shell.tsx')).toBe(true);
    expect(reachable.has('../pages/first-run/use-first-run-state.ts')).toBe(true);
    const offenders = [...reachable].filter(
      (path) =>
        path.includes('/plan-builder/') ||
        staticImports(sources[path]!).some((spec) => /plan-builder\//.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  it('the graph walk can fail: from the lazy first-run page it does reach the builder', () => {
    const page = sources['../pages/first-run/FirstRunPage.tsx']!;
    expect(staticImports(page).some((s) => s.includes('plan-builder/'))).toBe(true);
    const reachable = reachableFrom(['../pages/first-run/FirstRunPage.tsx']);
    expect(reachable.has('../pages/plan-builder/StartPlan.tsx')).toBe(true);
  });
});
