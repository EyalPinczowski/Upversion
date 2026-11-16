import {
  ProfileImportSchema,
  SetupStatusUpdateSchema,
  TAXONOMY_SKILL_IDS,
  UserProfileSchema,
} from '@upversion/shared';
import { z } from 'zod';
import { noNulCharacters } from '../../validation';

/** The profile as the client sees it. Defaults (not started, nothing stored) when no row exists. */
export const profileView = UserProfileSchema;

/** Strict: a `userId` or any other unknown key is refused. Values are validated per question. */
export const putAnswersBody = noNulCharacters(
  z.strictObject({
    answers: z.record(z.string().min(1).max(60), z.unknown()),
  }),
);

export const MAX_LEVELS_PER_REQUEST = 20;

/**
 * Levels the user sets by hand: taxonomy skill ids to integers 0..3, at most 20 per request.
 * Strict, so a `userId` or any other key is a 400.
 */
export const putSkillsBody = noNulCharacters(
  z.strictObject({
    levels: z
      .record(z.string().min(1).max(80), z.number().int().min(0).max(3))
      .refine((r) => Object.keys(r).length >= 1, 'levels must not be empty')
      .refine((r) => Object.keys(r).length <= MAX_LEVELS_PER_REQUEST, 'too many levels')
      .refine((r) => Object.keys(r).every((id) => TAXONOMY_SKILL_IDS.has(id)), 'unknown skill id'),
  }),
);

/** The CV-derived allowlist payload (shared schema, strict). */
export const importBody = noNulCharacters(ProfileImportSchema);

export const setupBody = noNulCharacters(SetupStatusUpdateSchema);

/** No query parameters exist on these routes: a `userId` (or anything else) is a 400. */
export const emptyQuery = z.strictObject({});

/** DELETE takes no body; a body that names a user (or anything) is refused. */
export const emptyBody = noNulCharacters(z.strictObject({}));
