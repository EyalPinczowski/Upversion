import { diffDays, LocalDateSchema } from '@upversion/shared';
import { z } from 'zod';
import { noNulCharacters } from '../../validation';

export const calendarStatus = z.enum(['connected', 'needs_reconnect', 'disconnected']);

export const calendarSourceView = z.object({
  calendarId: z.string(),
  name: z.string(),
  /** Whether events in this calendar are subtracted from capacity. */
  blocksTime: z.boolean(),
});

/** Never carries a token, ciphertext or the app calendar's id. */
export const calendarView = z.object({
  status: calendarStatus,
  lastSyncedAt: z.iso.datetime().nullable(),
  /** A short machine code such as `invalid_grant`; null when the last call worked. */
  lastErrorCode: z.string().nullable(),
  sources: z.array(calendarSourceView),
});

export const connectView = z.object({
  /** Send the browser here; Google redirects back to the web app with `code` and `state`. */
  authorizationUrl: z.url(),
});

/** Strict: a `userId` or any other unknown key is rejected, never ignored. */
export const callbackBody = noNulCharacters(
  z.strictObject({
    code: z.string().min(1).max(2048),
    state: z.string().min(16).max(256),
  }),
);

export const updateSourcesBody = noNulCharacters(
  z.strictObject({
    sources: z
      .array(z.strictObject({ calendarId: z.string().min(1).max(500), blocksTime: z.boolean() }))
      .min(1)
      .max(200),
  }),
);

/** Strict and optional: an empty body (or none) is a normal sync; `userId` or anything else is rejected. */
export const syncBody = noNulCharacters(
  z.strictObject({
    /** Skip the five-minute throttle (still at most once a minute). */
    force: z.boolean().optional(),
  }),
);

export const syncView = z.object({
  /** `cached`: synced within the last five minutes, so Google was not called. */
  status: z.enum(['synced', 'cached']),
  syncedAt: z.iso.datetime().nullable(),
  /** Tasks whose blocks moved because of the calendar (busy events, day-offs, locked blocks). */
  movedTaskIds: z.array(z.string()),
  finishChanged: z.boolean(),
  /** Plain-English change summary to show the user. */
  text: z.string(),
});

/** The longest range the busy list answers for, counted in days including both ends. */
export const BUSY_MAX_DAYS = 14;

const valid = (q: { from: unknown; to: unknown }) =>
  LocalDateSchema.safeParse(q.from).success && LocalDateSchema.safeParse(q.to).success;

/** Strict: a `userId` or any other unknown key is rejected, never ignored. */
export const busyQuery = z
  .strictObject({ from: LocalDateSchema, to: LocalDateSchema, planId: z.uuid().optional() })
  // Refinements can run when a field already failed, so they accept anything and never throw.
  .refine((q) => !valid(q) || q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => !valid(q) || diffDays(q.from, q.to) < BUSY_MAX_DAYS, {
    message: `The range can be at most ${BUSY_MAX_DAYS} days.`,
  });

/**
 * One busy interval of the owner's own calendar, for the time grid. Minutes are counted from
 * midnight of `date` in the plan's time zone. No event id, calendar id or user id.
 */
export const busyItem = z.object({
  date: LocalDateSchema,
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  allDay: z.boolean(),
  /**
   * `busy` counts as busy time, `tentative` is a "maybe", `non_blocking` is an all-day event that
   * does not block the day. The grid draws each differently and labels it in text.
   */
  kind: z.enum(['busy', 'tentative', 'non_blocking']),
  /** The event's title as the owner's calendar has it (empty when there is none). */
  title: z.string(),
});

export const busyView = z.object({ items: z.array(busyItem) });
