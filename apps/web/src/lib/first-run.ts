/**
 * Whether this person left the first run with "Skip for now" (ADR 018). The setup status on the
 * server says the same thing when the profile API is on; this is the fallback for when it is off
 * (404) or the save failed. Remembered in this browser only, keyed by user id; storage can be
 * blocked, then it lasts for this visit.
 */
const keyFor = (userId: string) => `upversion.first-run-skipped.${userId}`;
const inMemory = new Set<string>();

export function hasSkippedFirstRun(userId: string): boolean {
  if (inMemory.has(userId)) return true;
  try {
    return window.localStorage.getItem(keyFor(userId)) === '1';
  } catch {
    return false;
  }
}

export function markFirstRunSkipped(userId: string): void {
  inMemory.add(userId);
  try {
    window.localStorage.setItem(keyFor(userId), '1');
  } catch {
    // Remembered for this visit only.
  }
}

/** Test helper. */
export function resetFirstRunMemory(): void {
  inMemory.clear();
}
