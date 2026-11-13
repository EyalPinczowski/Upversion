import { createHash } from 'node:crypto';
import {
  BuildRequestError,
  localDateOf,
  type BuildCatalog,
  type BuildDraft,
  type BuildRequest,
} from '@upversion/shared';
import { BUILDER_VERSION, buildPlan, BUNDLED_CATALOG } from '@upversion/shared/plan-builder';
import type { Database, UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { canonical, validateImport } from '../plans/import';
import * as plansRepo from '../plans/repository';
import type { PlanDetail } from '../plans/schemas';
import type { createPlanService } from '../plans/service';
import type { BuildBody } from './schemas';

const notFound = () => new HttpError(404, 'not_found', 'Resource not found.');

export interface BuildResult {
  /** False when the same build had already been made (an idempotent retry). */
  created: boolean;
  plan: PlanDetail;
}

/** The ids as a sorted set, so the order and repeats in a request do not matter. */
const asSet = (ids: readonly string[]) => [...new Set(ids)].sort();
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = asSet(a);
  const y = asSet(b);
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

const activePlanChanged = () =>
  new HttpError(
    409,
    'active_plan_changed',
    'Your active plans changed since you confirmed. Reload your plans and confirm again.',
  );

/**
 * The plan builder and plan restore (ADR 017). The user id is always the verified token's; no
 * method takes one from a request body. `catalog` is injectable for tests only.
 */
export function createPlanBuilderService(
  db: Database,
  plans: ReturnType<typeof createPlanService>,
  now: () => Date = () => new Date(),
  catalog: BuildCatalog = BUNDLED_CATALOG,
) {
  /** Runs the pure builder. `today` is the current date in the plan's time zone (as the schedule does). */
  function run(request: BuildRequest): BuildDraft {
    try {
      const today = localDateOf(now(), request.weekPattern.timezone);
      return buildPlan({ request, today }, catalog);
    } catch (error) {
      if (error instanceof BuildRequestError) {
        // Codes (and the ids the request itself named, which the schema limits to id characters):
        // never the messages, so nothing a client typed is echoed.
        throw new HttpError(422, 'unprocessable', 'The plan request could not be built.', {
          issues: error.issues.map(({ code, id }) => (id === undefined ? { code } : { code, id })),
        });
      }
      throw error;
    }
  }

  /** The state a retry is judged by: the request body, not the draft (a catalog deploy changes drafts). */
  const bodyHash = (body: BuildBody) =>
    createHash('sha256')
      .update(
        canonical({
          request: body.request,
          draftHash: body.draftHash,
          useAiExplanations: body.useAiExplanations === true,
        }),
      )
      .digest('hex');

  /** Archives the plans in `ids` (all of the user's active plans) and records why. */
  async function archive(
    ctx: UserContext,
    userId: string,
    ids: readonly string[],
    by: 'plan_builder' | 'restore',
    replacedBy: string,
  ) {
    for (const id of ids) {
      await plansRepo.setPlanStatus(ctx, userId, id, 'archived');
      await plansRepo.insertEvent(ctx, userId, id, 'plan.archived', { by, replacedBy });
    }
  }

  return {
    /** The draft for a request. Saves nothing. */
    preview: (request: BuildRequest): BuildDraft => run(request),

    /**
     * One transaction (the import service's): the per-user lock, then the idempotency check on
     * the request body, then a fresh draft compared with `draftHash`, then the check of the
     * active plans against `replacesPlanIds`, then archive and insert. Any failure rolls it all
     * back.
     */
    async build(userId: string, body: BuildBody): Promise<BuildResult> {
      return plans.importFrom(userId, body.id, {
        payloadHash: bodyHash(body),
        createdFrom: 'builder',
        prepare: async (ctx) => {
          const draft = run(body.request);
          if (draft.draftHash !== body.draftHash) {
            throw new HttpError(
              409,
              'draft_changed',
              'The plan changed since you previewed it. Preview it again.',
            );
          }
          const active = await plansRepo.lockActivePlanIds(ctx, userId);
          if (!sameSet(active, body.replacesPlanIds)) throw activePlanChanged();
          await archive(ctx, userId, active, 'plan_builder', body.id);
          // The same checks as a file import (size limits, taxonomy ids, characters Postgres
          // cannot store), as a safety net: the draft is a valid plan file already.
          const valid = validateImport(draft.plan as unknown as Record<string, unknown>, 'active');
          return {
            status: 'active',
            plan: valid.plan,
            summaryExtra: {
              targetRoleIds: body.request.targetRoleIds,
              builderVersion: BUILDER_VERSION,
            },
            eventExtra: { createdFrom: 'builder', builderVersion: BUILDER_VERSION },
          };
        },
      });
    },

    /**
     * Archived plan to active, and the plans that are active now to archived, in one
     * transaction. A retry (the plan is already the only active plan) answers the plan again.
     */
    restore: (userId: string, planId: string, replaces: readonly string[]): Promise<PlanDetail> =>
      db.withUser(userId, async (ctx) => {
        await plansRepo.lockUserPlans(ctx, userId);
        const status = await plansRepo.lockPlanStatus(ctx, userId, planId);
        if (status === null) throw notFound();
        const active = await plansRepo.lockActivePlanIds(ctx, userId);
        if (status === 'active' && active.length === 1 && active[0] === planId) {
          return (await plansRepo.loadPlan(ctx, userId, planId))!;
        }
        if (status !== 'archived') {
          throw new HttpError(409, 'plan_not_archived', 'Only an archived plan can be restored.');
        }
        if (!sameSet(active, replaces)) throw activePlanChanged();
        await archive(ctx, userId, active, 'restore', planId);
        await plansRepo.setPlanStatus(ctx, userId, planId, 'active');
        await plansRepo.insertEvent(ctx, userId, planId, 'plan.restored', { replaced: active });
        return (await plansRepo.loadPlan(ctx, userId, planId))!;
      }),
  };
}

export type PlanBuilderService = ReturnType<typeof createPlanBuilderService>;
