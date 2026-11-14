import { PlanFileSchema } from '@upversion/shared';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

describe('zod without eval', () => {
  it('is configured jitless by the module `zod` resolves to in the web build, with no other import', () => {
    // Nothing here imports src/zod-config.ts: the alias alone must have set it.
    expect(z.config().jitless).toBe(true);
    expect(PlanFileSchema).toBeDefined();
  });
});
