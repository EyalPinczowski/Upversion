import { CvTailorRequestSchema, CvTailorResponseSchema } from '@upversion/shared';
import { z } from 'zod';
import { noNulCharacters } from '../../validation';

/** Strict (unknown keys, `userId` included, are a 400); U+0000 is a 422 like everywhere else. */
export const tailorBody = noNulCharacters(CvTailorRequestSchema);

const flagSchema = z.object({
  kind: z.enum(['number', 'skill', 'certificate', 'degree', 'term', 'placeholder']),
  text: z.string().max(200),
});

const providerSchema = z.object({ id: z.string(), label: z.string() });

/**
 * What the shared schema defines (`text`, `notes`) plus what the API adds. `providers` names every
 * provider the text was handed to (the one that answered and, after a switch, the one that failed
 * first); `flags` are the items of the answer the CV does not support.
 */
export const tailorResult = CvTailorResponseSchema.extend({
  flags: z.array(flagSchema).max(100),
  providers: z.array(providerSchema).min(1).max(4),
  usage: z.object({ used: z.number().int(), cap: z.number().int() }),
});
