import { isApiError } from '../api/errors';
import { describeError } from '../lib/messages';

/** The plain-words reason a restore failed. */
export function describeRestoreError(error: unknown): string {
  if (isApiError(error) && error.kind === 'http') {
    if (error.code === 'plan_not_archived') {
      return 'This plan is no longer archived, so there is nothing to restore. The list has been refreshed.';
    }
    if (error.code === 'active_plan_changed') {
      return 'Your active plans changed in the meantime. Check the names below and confirm again.';
    }
    if (error.status === 404) return 'This plan no longer exists.';
  }
  return describeError(error, 'The plan could not be restored. Nothing was changed.');
}
