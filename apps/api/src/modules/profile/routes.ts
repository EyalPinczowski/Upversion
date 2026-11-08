import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import {
  emptyBody,
  emptyQuery,
  importBody,
  profileView,
  putAnswersBody,
  setupBody,
} from './schemas';
import { createProfileService } from './service';

export interface ProfileRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  now?: () => Date;
}

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  429: errorResponseSchema,
};
const security = [{ bearerAuth: [] }];
const tags = ['profile'];

/**
 * The person-level profile and first-time setup (ADR 015). Registered only with
 * FEATURE_PROFILE_SETUP on, so with the flag off these paths do not exist (404). The user id
 * comes from the verified token only: no body field or query value names a user (400 if one
 * appears). Answers are never logged.
 */
export const profileRoutes: FastifyPluginAsyncZod<ProfileRoutesOptions> = async (
  app,
  { verifier, db, now },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const service = db ? createProfileService(db, now) : null;
  const user = (request: FastifyRequest) => request.accountId!;

  app.get(
    '/me/profile',
    {
      schema: {
        tags,
        summary: 'The signed-in user’s profile and setup state',
        description:
          'Defaults when nothing is stored yet: `setupStatus: not_started`, empty answers, skills and roles.',
        security,
        querystring: emptyQuery,
        response: { 200: profileView, ...errors },
      },
    },
    async (request) => service!.get(user(request)),
  );

  app.put(
    '/me/profile/answers',
    {
      schema: {
        tags,
        summary: 'Save setup answers (partial merge, idempotent)',
        description:
          'Keys are ids of the setup questions in `questions.json`; each value is checked against its question (`multi_role` and `multi_skill` take taxonomy ids only, within `max`; "Other" and typed values are refused). An unknown or non-setup id, or an invalid value, answers 400 and nothing is saved. Answers not named in the body are kept.',
        security,
        querystring: emptyQuery,
        body: putAnswersBody,
        response: { 200: profileView, ...errors },
      },
    },
    async (request) => service!.putAnswers(user(request), request.body.answers),
  );

  app.put(
    '/me/profile/import',
    {
      schema: {
        tags,
        summary: 'Save what the user confirmed from a CV read in the browser',
        description:
          'The body is the allowlist payload only (skills with levels, roles held, years, education, tools): never CV text, evidence or a file name. Replaces all skills with `source: cv` by the confirmed ones; `manual` and `setup` skills are kept, and a confirmed skill the user already has as `manual` or `setup` leaves that item unchanged. Replaces roles held and years of experience, sets `cvImportedAt`, and pre-fills the `education` and `tools_known` answers only where empty. 400 for an unknown skill or role id, a duplicate skill, or a role title that holds an email, link, handle or phone number.',
        security,
        querystring: emptyQuery,
        body: importBody,
        response: { 200: profileView, ...errors },
      },
    },
    async (request) => service!.importCv(user(request), request.body),
  );

  app.patch(
    '/me/profile/setup',
    {
      schema: {
        tags,
        summary: 'Move setup to a status and step',
        description:
          '`completed` sets `setupCompletedAt` (kept if already set). `step` is optional and is left as it is when omitted. Creates the profile row when none exists.',
        security,
        querystring: emptyQuery,
        body: setupBody,
        response: { 200: profileView, ...errors },
      },
    },
    async (request) => service!.setSetup(user(request), request.body),
  );

  app.delete(
    '/me/profile',
    {
      schema: {
        tags,
        summary: 'Clear my profile',
        description:
          'Clears answers, skills, roles held, years and `cvImportedAt`, and sets `setupStatus: dismissed` so clearing never sends the user back into setup. Returns the cleared profile.',
        security,
        querystring: emptyQuery,
        body: emptyBody.nullish(),
        response: { 200: profileView, ...errors },
      },
    },
    async (request) => service!.clear(user(request)),
  );
};
