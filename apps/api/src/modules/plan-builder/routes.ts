import type { BuildCatalog } from '@upversion/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import { planDetailSchema, planIdParams } from '../plans/schemas';
import { createPlanService } from '../plans/service';
import { buildBody, draftSchema, previewBody, restoreBody } from './schemas';
import { createPlanBuilderService } from './service';

export interface PlanBuilderRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  now?: () => Date;
  /** Tests only: a different catalog than the bundled one. */
  catalog?: BuildCatalog;
}

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
};
const security = [{ bearerAuth: [] }];
const tags = ['plan-builder'];

/**
 * The rule-based plan builder and plan restore (ADR 017, docs/api-plan-builder.md). Registered
 * only with FEATURE_PLAN_BUILDER on, so with the flag off these paths do not exist (404). The
 * user id comes only from the verified token; no body field names a user (400 if one appears).
 */
export const planBuilderRoutes: FastifyPluginAsyncZod<PlanBuilderRoutesOptions> = async (
  app,
  { verifier, db, now, catalog },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const user = (request: FastifyRequest) => request.accountId!;
  // Without a database the guard already answered 503, so a handler never runs with `db` null.
  const builder = createPlanBuilderService(db!, createPlanService(db!, now), now, catalog);

  app.post(
    '/plans/build/preview',
    {
      schema: {
        tags,
        summary: 'The plan the builder would make for these choices (saves nothing)',
        description:
          'Runs the rule-based builder on the bundled catalog and returns the draft: the plan file, items with flags, cost and a "why" line, skipped and excluded items, the fit against the deadline (with the three options when it does not fit), warnings and a `draftHash`. 422 with `issues` (codes only) when the request names an unknown role, skill or catalog id or the dates cannot work.',
        security,
        body: previewBody,
        response: { 200: draftSchema, ...errors },
      },
    },
    async (request) => builder.preview(request.body),
  );

  app.post(
    '/plans/build',
    {
      schema: {
        tags,
        summary: 'Create the plan from a confirmed draft (idempotent on the client-generated id)',
        description:
          'In one transaction: rebuilds the draft and compares `draftHash` (409 `draft_changed`), checks that `replacesPlanIds` is exactly the set of the user’s active plans (409 `active_plan_changed`), archives those plans and creates the new active plan with `createdFrom: builder`. 201 on creation; 200 with the stored plan when the same id and the same body are sent again (also after the catalog changed); 409 when the id exists with a different body.',
        security,
        body: buildBody,
        response: { 200: planDetailSchema, 201: planDetailSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await builder.build(user(request), request.body);
      return reply.status(result.created ? 201 : 200).send(result.plan);
    },
  );

  app.post(
    '/plans/:id/restore',
    {
      schema: {
        tags,
        summary: 'Make an archived plan the active plan again',
        description:
          'Only an archived plan can be restored. The plans that are active now are archived in the same transaction, after the same check as a build (`replacesPlanIds`, 409 `active_plan_changed`). 200 with the plan; a retry when the plan is already the only active plan also answers 200. 409 `plan_not_archived` for a draft or done plan.',
        security,
        params: planIdParams,
        body: restoreBody,
        response: { 200: planDetailSchema, ...errors },
      },
    },
    async (request) =>
      builder.restore(user(request), request.params.id, request.body.replacesPlanIds),
  );
};
