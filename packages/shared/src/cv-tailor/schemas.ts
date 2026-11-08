import { z } from 'zod';
import {
  MAX_CV_TAILOR_CV,
  MAX_CV_TAILOR_JOB,
  MAX_CV_TAILOR_OUTPUT,
  MIN_CV_TAILOR_CV,
  MIN_CV_TAILOR_JOB,
} from './limits';

/** Body of `POST /api/v1/me/cv/tailor` (ADR 016 section 3). Strict: unknown keys are rejected. */
export const CvTailorRequestSchema = z
  .object({
    cvText: z.string().trim().min(MIN_CV_TAILOR_CV).max(MAX_CV_TAILOR_CV),
    jobText: z.string().trim().min(MIN_CV_TAILOR_JOB).max(MAX_CV_TAILOR_JOB),
    roleId: z.string().min(1).max(80).optional(),
  })
  .strict();
export type CvTailorRequest = z.infer<typeof CvTailorRequestSchema>;

export const CV_TAILOR_NOTE_KINDS = [
  'missing_keyword',
  'matched_keyword',
  'model_note',
  'check_number',
  'check_skill',
  'check_term',
  'output_redacted',
] as const;

export const CvTailorNoteSchema = z
  .object({
    kind: z.enum(CV_TAILOR_NOTE_KINDS),
    text: z.string().max(200),
  })
  .strict();
export type CvTailorNote = z.infer<typeof CvTailorNoteSchema>;

/** The response without the provider fields, which the API adds (`provider`, `switched`, `usage`). */
export const CvTailorResponseSchema = z
  .object({
    text: z.string().max(MAX_CV_TAILOR_OUTPUT),
    notes: z.array(CvTailorNoteSchema).max(40),
  })
  .strict();
export type CvTailorResponse = z.infer<typeof CvTailorResponseSchema>;
