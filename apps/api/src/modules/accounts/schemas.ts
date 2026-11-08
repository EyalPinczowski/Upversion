import { z } from 'zod';
import { noNulCharacters } from '../../validation';
import { LEGAL_DOCUMENTS } from './legal';

const legalStatus = z.object({ currentVersion: z.string(), accepted: z.boolean() });

export const meSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(['user', 'admin']),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  legal: z.object({
    terms: legalStatus,
    privacy: legalStatus,
    allAccepted: z.boolean(),
  }),
});

/** Strict: unknown keys (a `userId`, a `role`, ...) are rejected, never ignored silently. */
export const updateMeBody = noNulCharacters(
  z.strictObject({
    displayName: z.string().trim().min(1).max(80).nullable(),
  }),
);

export const acceptLegalBody = z.strictObject({
  document: z.enum(LEGAL_DOCUMENTS),
  version: z.string().min(1).max(32),
});

export const DELETE_CONFIRMATION = 'delete my account';

export const deleteMeBody = noNulCharacters(z.strictObject({ confirmation: z.string().max(100) }));

const rows = z.array(z.record(z.string(), z.unknown()));

export const exportSchema = z.object({
  exportedAt: z.iso.datetime(),
  formatVersion: z.literal(1),
  user: z.record(z.string(), z.unknown()),
  legalAcceptances: rows,
  plans: rows,
  weekPatterns: rows,
  dayOverrides: rows,
  tasks: rows,
  logs: rows,
  events: rows,
  daySessions: rows,
  scheduleDays: rows,
  dayReviews: rows,
  adjustments: rows,
  practiceContexts: rows,
  practiceSessions: rows,
  practiceMessages: rows,
  practiceFeedback: rows,
  aiUsageDaily: rows,
  aiCache: rows,
  calendarConnections: rows,
  calendarEventLinks: rows,
  calendarLockedBlocks: rows,
  calendarBusy: rows,
  calendarSources: rows,
  userProfiles: rows,
});
