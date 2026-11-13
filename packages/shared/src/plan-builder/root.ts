/**
 * What `@upversion/shared` (the package root) exports of the plan builder: schemas, types and
 * helpers that do not need the catalog JSON. The builder itself and the bundled catalog are in
 * `@upversion/shared/plan-builder` (`index.ts`), which only the API imports.
 */
export * from './schemas';
export * from './catalog';
export {
  BuildRequestError,
  validateBuildRequest,
  examBlockHours,
  MAX_EXAM_BLOCK_HOURS,
  MAX_DEADLINE_DAYS,
} from './validate';
export type { BuildRequestIssue, BuildRequestIssueCode } from './validate';
export { prefillFromProfile, TIME_OF_DAY_WINDOWS } from './prefill';
export type { PrefillOptions, PrefillResult } from './prefill';
export { LEVEL_LABELS, levelLabel } from './context';
