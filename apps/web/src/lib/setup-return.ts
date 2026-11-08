/**
 * Where the calendar callback sends the person back to when the connect flow started in the setup
 * wizard (ADR 015). The path lives in sessionStorage, never in a URL parameter, and only the one
 * allowlisted path is ever accepted. Storage can be blocked: then the callback simply offers
 * "Back to Settings" as before.
 */
const KEY = 'upversion.calendar-return';
export const SETUP_PATH = '/setup';

export function rememberSetupReturn(): void {
  try {
    window.sessionStorage.setItem(KEY, SETUP_PATH);
  } catch {
    // No return path: the callback page shows its normal link.
  }
}

/** Reads the return path without removing it (safe to call from a state initializer). */
export function peekSetupReturn(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === SETUP_PATH;
  } catch {
    return false;
  }
}

export function clearSetupReturn(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
