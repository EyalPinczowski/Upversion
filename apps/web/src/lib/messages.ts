import { isApiError } from '../api/errors';

/**
 * Words for a failed request. No connection or no answer: say so and that nothing was saved. The
 * API's own message is shown only for 409 and 422, where it says what is wrong with the input
 * (field paths, never internals). Anything else gets the caller's plain sentence.
 */
export function describeError(error: unknown, whenRefused: string): string {
  if (isApiError(error)) {
    if (error.kind !== 'http') {
      return 'Can’t reach the server. Nothing was saved. Check your connection and try again.';
    }
    if (error.status === 409 && error.code === 'plan_archived') {
      return 'This plan is archived (read-only), so nothing can be changed. Restore it from the Plan page to make changes.';
    }
    if (error.status === 422 || error.status === 409 || error.status === 413) {
      return error.message;
    }
    if (error.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  }
  return whenRefused;
}

/** True when the request never got an answer, so repeating it with the same id is safe. */
export const isConnectionProblem = (error: unknown): boolean =>
  isApiError(error) && error.kind !== 'http';

/** A fresh id for a client-generated resource (plan import, time log). */
export const newId = (): string => globalThis.crypto.randomUUID();
