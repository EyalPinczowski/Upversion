/**
 * Limits of the CV tailoring feature (ADR 016 section 3, WP-E). The API enforces them; the web
 * app reads the same numbers. They are chosen so the longest prompt fits the smallest provider
 * window: system (at most 2,000) + CV (6,000) + job post (3,000) stays under 11,000, below the
 * providers' 12,000-character limit.
 */
export const MAX_CV_TAILOR_CV = 6000;
export const MIN_CV_TAILOR_CV = 200;
export const MAX_CV_TAILOR_JOB = 3000;
export const MIN_CV_TAILOR_JOB = 100;
export const MAX_CV_TAILOR_OUTPUT = 8000;
/** The whole request: system text plus user message. */
export const MAX_CV_TAILOR_PROMPT = 11_000;
/** The system prompt budget (it is part of MAX_CV_TAILOR_PROMPT). */
export const MAX_CV_TAILOR_SYSTEM = 2000;
/** The optional "Target role" line (a catalog role title). */
export const MAX_CV_TAILOR_ROLE = 100;
