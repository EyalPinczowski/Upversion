import type { ProgressCatalog } from '@upversion/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import {
  approveBody,
  approveResult,
  emptyQuery,
  goalProgressParams,
  goalProgressSchema,
} from './schemas';
import { createGoalService } from './service';

export interface GoalRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  now?: () => Date;
  /** Tests only: a different catalog than the bundled one. */
  catalog?: ProgressCatalog;
}

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  429: errorResponseSchema,
};
const security = [{ bearerAuth: [] }];
const tags = ['goal'];

/**
 * Goal progress and level approval (ADR 018, docs/api-goal-progress.md). Not behind a feature
 * flag: the read is harmless and the write needs an explicit call for a suggestion that exists
 * only with progress. The user id comes from the verified token only; no body field, query or
 * path value names a user (400 if one appears).
 */
export const goalRoutes: FastifyPluginAsyncZod<GoalRoutesOptions> = async (
  app,
  { verifier, db, now, catalog },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const user = (request: FastifyRequest) => request.accountId!;
  // Without a database the guard already answered 503, so a handler never runs with `db` null.
  const service = createGoalService(db!, now, catalog);

  app.get(
    '/plans/:id/goal-progress',
    {
      schema: {
        tags,
        summary: 'The goal, plan coverage per skill and level suggestions of a plan',
        description:
          'Read only. `goal` comes from the plan (or, for older plans, from its skill ids); `progress` is plan coverage per goal skill (a task’s skills are its own `skillIds`, else its catalog item’s) with the levels from the user’s profile; `suggestions` lists skills whose tasks are all done and whose level is below 2 (one level up). Practice scores are evidence only. `goal` and `progress` are null for a plan that names no skill; `suggestions` is empty for an archived plan. 404 for a plan that is not yours.',
        security,
        params: goalProgressParams,
        querystring: emptyQuery,
        response: { 200: goalProgressSchema, ...errors },
      },
    },
    async (request) => service.getProgress(user(request), request.params.id),
  );

  app.post(
    '/me/level-ups/approve',
    {
      schema: {
        tags,
        summary: 'Approve a suggested level update (writes one profile skill, source manual)',
        description:
          'The server recomputes the suggestions for the plan and accepts only one that is suggested right now: `toLevel` must be exactly one above the skill’s current level and at most 2. Writes that skill to the user’s profile with `source: manual`. 404 for a plan that is not yours; 409 `plan_archived` for an archived plan; 409 `not_suggested` when the update is not suggested (any more); 409 `profile_skills_full` when the profile holds 60 skills. Nothing is ever written without this call.',
        security,
        body: approveBody,
        response: { 200: approveResult, 409: errorResponseSchema, ...errors },
      },
    },
    async (request) => service.approveLevelUp(user(request), request.body),
  );
};
