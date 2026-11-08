import { ProfileImportSchema, SetupStatusUpdateSchema, UserProfileSchema } from '@upversion/shared';
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

/** The CV-derived allowlist payload (shared schema, strict). */
export const importBody = noNulCharacters(ProfileImportSchema);

export const setupBody = noNulCharacters(SetupStatusUpdateSchema);

/** No query parameters exist on these routes: a `userId` (or anything else) is a 400. */
export const emptyQuery = z.strictObject({});

/** DELETE takes no body; a body that names a user (or anything) is refused. */
export const emptyBody = noNulCharacters(z.strictObject({}));
