import type { UserContext } from '../../db/database';
import { HttpError } from '../../errors';
import * as repo from './repository';

/**
 * "One active plan" (ADR 017 section 4.1, ADR 018 Q2): the confirm step shared by the plan
 * builder, the plan file import and restore. The caller must already hold the per-user lock
 * (`repo.lockUserPlans`).
 */

/** The ids as a sorted set, so the order and repeats in a request do not matter. */
const asSet = (ids: readonly string[]) => [...new Set(ids)].sort();
export const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = asSet(a);
  const y = asSet(b);
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

export const activePlanChanged = () =>
  new HttpError(
    409,
    'active_plan_changed',
    'Your active plans changed since you confirmed. Reload your plans and confirm again.',
  );

/** Archives the plans in `ids` and records why (a `plan.archived` event on each). */
export async function archivePlans(
  ctx: UserContext,
  userId: string,
  ids: readonly string[],
  by: 'plan_builder' | 'restore' | 'import',
  replacedBy: string,
): Promise<void> {
  for (const id of ids) {
    await repo.setPlanStatus(ctx, userId, id, 'archived');
    await repo.insertEvent(ctx, userId, id, 'plan.archived', { by, replacedBy });
  }
}

/**
 * Compares `replaces` with the user's active plans as sets (409 `active_plan_changed` when they
 * differ, nothing written) and archives them. Returns the archived ids.
 */
export async function archiveConfirmed(
  ctx: UserContext,
  userId: string,
  replaces: readonly string[],
  by: 'plan_builder' | 'import',
  replacedBy: string,
): Promise<string[]> {
  const active = await repo.lockActivePlanIds(ctx, userId);
  if (!sameSet(active, replaces)) throw activePlanChanged();
  await archivePlans(ctx, userId, active, by, replacedBy);
  return active;
}
