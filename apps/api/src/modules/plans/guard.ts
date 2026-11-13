import type { UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import { lockPlanStatus } from './repository';

/**
 * The read-only rule of an archived plan (ADR 017 section 4.1). Call it first in the
 * transaction of every user-facing write on a plan: it locks the plan row (`for no key update`,
 * the same lock as `lockPlan`), so a build or a restore that archives the plan cannot interleave
 * with the write, and answers 404 for a plan that is not the caller's (row-level security) or 409
 * `plan_archived` for an archived one.
 *
 * `shared` is for the task-level writes (logs, complete, reopen, skip), which must not wait for a
 * review or an accept (see `lockPlanStatus`); every other write uses the default.
 *
 * It rejects only `archived`: `draft` plans exist (import can create them) and `done` is set by
 * no code today, so both stay writable. Server-internal writes (the progress rollover, calendar
 * sync, the `plan.archived` event) must not call it, nor must the closing of a practice session
 * that was already open, and deleting or restoring a plan.
 */
export async function requireWritablePlan(
  ctx: UserContext,
  userId: string,
  planId: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<void> {
  const status = await lockPlanStatus(ctx, userId, planId, mode);
  if (status === null) throw new HttpError(404, 'not_found', 'Resource not found.');
  if (status === 'archived') {
    throw new HttpError(
      409,
      'plan_archived',
      'This plan is archived and read-only. Restore it to change it.',
    );
  }
}
