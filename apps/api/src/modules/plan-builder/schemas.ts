import { BuildDraftSchema, BuildRequestSchema } from '@upversion/shared';
import { z } from 'zod';

/** Most plans a build or a restore may archive at once (several can be active through import). */
export const MAX_REPLACED_PLANS = 10;

export const replacesPlanIds = z.array(z.uuid()).max(MAX_REPLACED_PLANS);

/**
 * The preview body is the shared `BuildRequestSchema` itself: strict, with no free text and no
 * user id. The create body wraps it. `useAiExplanations` is accepted so the web client can send
 * it: with FEATURE_PLAN_BUILDER_AI on it saves the AI lines from the server's cache (ADR 017
 * WP-4), otherwise the templates.
 */
export const previewBody = BuildRequestSchema;

export const buildBody = z.strictObject({
  /** Client-generated plan id: a retry with the same body returns the same plan. */
  id: z.uuid(),
  request: BuildRequestSchema,
  /** The `draftHash` of the preview the user saw. */
  draftHash: z.string().regex(/^[0-9a-f]{1,64}$/),
  /** Exactly the plans that are active now (empty when there is none): what the user confirmed. */
  replacesPlanIds,
  useAiExplanations: z.boolean().optional(),
});

/** The explain body: the request and the hash of the preview. No free text anywhere. */
export const explainBody = z.strictObject({
  request: BuildRequestSchema,
  draftHash: z.string().regex(/^[0-9a-f]{1,64}$/),
});

export const explainResult = z.object({
  /** One line per item of the draft, in plan order: the AI's where it passed the checks, else the template. */
  lines: z
    .array(
      z.object({
        itemId: z.string(),
        text: z.string().max(400),
        source: z.enum(['ai', 'template']),
      }),
    )
    .max(200),
  /** Every provider the input was handed to (empty for a cached answer). */
  providers: z.array(z.object({ id: z.string(), label: z.string() })).max(4),
  usage: z.object({ used: z.number().int(), cap: z.number().int() }),
});

export const restoreBody = z.strictObject({ replacesPlanIds });

export const draftSchema = BuildDraftSchema;

export type BuildBody = z.infer<typeof buildBody>;
