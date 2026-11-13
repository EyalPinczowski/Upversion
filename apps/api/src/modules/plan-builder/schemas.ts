import { BuildDraftSchema, BuildRequestSchema } from '@upversion/shared';
import { z } from 'zod';

/** Most plans a build or a restore may archive at once (several can be active through import). */
export const MAX_REPLACED_PLANS = 10;

export const replacesPlanIds = z.array(z.uuid()).max(MAX_REPLACED_PLANS);

/**
 * The preview body is the shared `BuildRequestSchema` itself: strict, with no free text and no
 * user id. The create body wraps it. `useAiExplanations` is accepted so the web client can send
 * it, but it has no effect until the AI explanations ship (ADR 017 WP-4): templates are saved.
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

export const restoreBody = z.strictObject({ replacesPlanIds });

export const draftSchema = BuildDraftSchema;

export type BuildBody = z.infer<typeof buildBody>;
