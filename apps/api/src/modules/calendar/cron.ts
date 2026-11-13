import { createHash, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import type { CalendarSync } from './sync';

/**
 * Scheduled calendar sync (docs/calendar-cron.md). A Cloudflare cron worker calls one endpoint
 * every 15 minutes; this file is what that call does. Each due user goes through the SAME
 * `CalendarSync.syncNow` as the user's own request, so the same write guard, the same scopes and
 * the same row-level security apply. Nothing here reads or writes calendar data itself.
 */

/** A user is due when the last sync is older than this (or missing). */
export const DUE_AFTER_MS = 10 * 60 * 1000;
/** One user may take this long before the run moves on (the sync itself is not aborted). */
export const USER_BUDGET_MS = 45_000;
/** The whole run stops starting new users after this long; the rest wait for the next run. */
export const RUN_BUDGET_MS = 120_000;
/** Authenticated runs per minute across all callers. */
export const GLOBAL_RUNS_PER_MINUTE = 6;

/** Counts only: no user id, e-mail, event title or token is ever part of a result. */
export interface CronRunResult {
  /** How many users the database named as due (at most the batch limit). */
  due: number;
  /** Synced against Google. */
  synced: number;
  /** Answered from stored data (another sync got there first). */
  cached: number;
  /** Google unavailable or unexpected, a timeout or an internal error: retried on the next run. */
  failed: number;
  /** Not synced on purpose: reconnect required, disconnected meanwhile, already running, out of time. */
  skipped: number;
}

/** Constant-time comparison: both sides are hashed to equal-length digests first. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** The token of an `Authorization: Bearer <token>` header; null for anything else. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

export interface CronServiceOptions {
  db: Database;
  sync: Pick<CalendarSync, 'syncNow'>;
  maxUsers: number;
  /** Only counts and error codes are passed. */
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  userBudgetMs?: number;
  runBudgetMs?: number;
  now?: () => number;
}

const SKIP_CODES = new Set([
  'calendar_reconnect_required',
  'calendar_not_connected',
  'sync_in_progress',
]);
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,100}$/;

export function createCalendarCron(options: CronServiceOptions) {
  const { db, sync, log, maxUsers } = options;
  const userBudgetMs = options.userBudgetMs ?? USER_BUDGET_MS;
  const runBudgetMs = options.runBudgetMs ?? RUN_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  /** One run at a time in this process (the free plan runs one API process). */
  let running = false;
  const recent: number[] = [];

  const codeOf = (error: unknown): string => {
    const raw = error instanceof HttpError ? error.code : error instanceof Error ? error.name : '';
    return SAFE_CODE.test(raw) ? raw : 'unknown';
  };

  async function withBudget<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new HttpError(504, 'user_budget_exceeded', 'The sync took too long.')),
        userBudgetMs,
      );
    });
    // If the budget wins, the sync still ends later: its failure must not become unhandled.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** Authenticated calls are limited to GLOBAL_RUNS_PER_MINUTE a minute across all callers. */
    allowRun(): boolean {
      const t = now();
      while (recent.length > 0 && t - recent[0]! >= 60_000) recent.shift();
      if (recent.length >= GLOBAL_RUNS_PER_MINUTE) return false;
      recent.push(t);
      return true;
    },

    /** 409 `already_running` when a run is in progress (single flight, never overlapping). */
    async run(): Promise<CronRunResult> {
      if (running) {
        throw new HttpError(409, 'already_running', 'A scheduled sync is already running.');
      }
      running = true;
      const result: CronRunResult = { due: 0, synced: 0, cached: 0, failed: 0, skipped: 0 };
      const codes: Record<string, number> = {};
      try {
        const ids = await db.dueCalendarUsers(DUE_AFTER_MS, maxUsers);
        result.due = ids.length;
        const started = now();
        for (const userId of ids) {
          if (now() - started >= runBudgetMs) {
            result.skipped += 1;
            continue;
          }
          try {
            const outcome = await withBudget(sync.syncNow(userId));
            if (outcome.status === 'cached') result.cached += 1;
            else result.synced += 1;
          } catch (error) {
            const code = codeOf(error);
            codes[code] = (codes[code] ?? 0) + 1;
            if (SKIP_CODES.has(code)) result.skipped += 1;
            else result.failed += 1;
          }
        }
        // Counts and error codes only: never a user id, token or event content.
        log.info({ ...result, codes }, 'scheduled calendar sync finished');
        return result;
      } finally {
        running = false;
      }
    },
  };
}

export type CalendarCron = ReturnType<typeof createCalendarCron>;
