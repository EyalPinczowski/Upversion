/**
 * The first run's step ids and resume rule. Kept free of plan-builder imports: the app shell reads
 * this on every page (to decide who gets the first run), so it must stay in the main bundle
 * without pulling the lazy plan builder chunk in with it.
 */
export const LAST_STEP = 4;

const SAVED_PREFIX = 'fr:';

/**
 * The step id saved in `setup_step` (at most 40 characters). The draft step (the last) is never
 * saved as such: leaving screen 3 saves `fr:3`, so a reload resumes on the last screen that asks
 * a question.
 */
export const savedStep = (step: number) =>
  `${SAVED_PREFIX}${Math.min(Math.max(step, 1), LAST_STEP - 1)}`;

/**
 * The step to resume at from a saved `setup_step`; null when it is not a first-run step. A stray
 * `fr:4` (or higher) counts as the last question screen.
 */
export function resumeStep(saved: string | null | undefined): number | null {
  if (!saved?.startsWith(SAVED_PREFIX)) return null;
  const n = Number(saved.slice(SAVED_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, LAST_STEP - 1);
}
