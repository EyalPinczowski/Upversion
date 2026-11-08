import { APP_CALENDAR_NAME, splitByDay } from '@upversion/shared';
import { CalendarCryptoError, type CalendarTokenCrypto } from '../../calendar-crypto';
import type { GoogleCalendarConfig } from '../../config';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import {
  CalendarAuthError,
  CalendarRequestError,
  CalendarRetryableError,
  CalendarSyncTokenExpiredError,
} from './errors';
import {
  buildAuthorizationUrl,
  CALENDAR_SCOPES,
  createPkce,
  createStateNonce,
  exchangeAuthorizationCode,
  OAuthCodeRejectedError,
  revokeToken,
  sha256Hex,
  type OAuthClientOptions,
} from './google-oauth';
import {
  createRefreshingTokenSupplier,
  GoogleCalendarProvider,
  refreshAccessToken,
  type AccessTokenSupplier,
} from './google-provider';
import type { CalendarProvider } from './provider';
import { calendarRepo, type ConnectionRow, type SourceRow } from './repo';
import { syncRepo } from './sync-repo';
import { createWriteGuard } from './write-guard';

export interface CalendarServiceOptions {
  db: Database;
  google: GoogleCalendarConfig;
  crypto: CalendarTokenCrypto;
  /** Only the `warn` level is used, and only with non-sensitive fields. */
  log: { warn(obj: object, msg: string): void };
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface CalendarView {
  status: 'connected' | 'needs_reconnect' | 'disconnected';
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  sources: { calendarId: string; name: string; blocksTime: boolean }[];
}

export interface BusyItem {
  date: string;
  startMinute: number;
  endMinute: number;
  allDay: boolean;
  kind: 'busy' | 'tentative' | 'non_blocking';
  title: string;
}

/** Codes are stored and shown to the client, so keep them short and plain. */
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,100}$/;
const safeCode = (code: string) => (SAFE_CODE.test(code) ? code : 'auth_error');

const reconnectRequired = () =>
  new HttpError(
    409,
    'calendar_reconnect_required',
    'Google no longer accepts the calendar connection. Reconnect your calendar.',
  );
const unavailable = () =>
  new HttpError(502, 'calendar_unavailable', 'Google Calendar is not reachable. Try again later.');

export function createCalendarService(options: CalendarServiceOptions) {
  const { db, google, crypto, log } = options;
  const now = options.now ?? (() => new Date());
  const oauth: OAuthClientOptions = {
    oauthBase: google.oauthBase,
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /** Provider whose access tokens come from the (decrypted) refresh token. */
  function providerFor(
    refreshToken: string,
    firstAccessToken: string | null = null,
  ): CalendarProvider {
    const refreshing = createRefreshingTokenSupplier(
      (token) => refreshAccessToken({ ...oauth, refreshToken: token }),
      async () => refreshToken,
    );
    let first = firstAccessToken;
    const getAccessToken: AccessTokenSupplier = async (opts) => {
      if (first && !opts?.forceRefresh) return first;
      first = null;
      return refreshing(opts);
    };
    return new GoogleCalendarProvider({
      apiBase: google.apiBase,
      getAccessToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /**
   * On provider CalendarAuthError (and an unreadable stored token): the connection stays as it is
   * but is flagged, so the app shows "Reconnect calendar". Other data is kept.
   */
  async function markNeedsReconnect(userId: string, code: string): Promise<void> {
    await db.withUser(userId, (ctx) =>
      calendarRepo.markNeedsReconnect(ctx, userId, safeCode(code)),
    );
  }

  /** Turns a failure into a client answer (marking the connection when the credentials are dead). */
  async function toHttpError(
    userId: string,
    error: unknown,
    markConnection = true,
  ): Promise<Error> {
    if (error instanceof HttpError) return error;
    if (error instanceof CalendarAuthError) {
      if (markConnection) await markNeedsReconnect(userId, error.code);
      return reconnectRequired();
    }
    if (error instanceof CalendarCryptoError) {
      if (markConnection) await markNeedsReconnect(userId, 'token_unreadable');
      return reconnectRequired();
    }
    if (error instanceof CalendarRetryableError) return unavailable();
    if (error instanceof CalendarRequestError || error instanceof CalendarSyncTokenExpiredError) {
      return new HttpError(502, 'calendar_error', 'Google Calendar returned an unexpected answer.');
    }
    return error instanceof Error ? error : new Error('unknown error');
  }

  function toView(conn: ConnectionRow | null, sources: SourceRow[]): CalendarView {
    if (!conn)
      return { status: 'disconnected', lastSyncedAt: null, lastErrorCode: null, sources: [] };
    return {
      status: conn.status,
      lastSyncedAt: conn.last_synced_at?.toISOString() ?? null,
      lastErrorCode: conn.last_error_code,
      sources: sources.map((s) => ({
        calendarId: s.calendar_id,
        name: s.name,
        blocksTime: s.blocks_time,
      })),
    };
  }

  const view = (userId: string) =>
    db.withUser(userId, async (ctx) =>
      toView(
        await calendarRepo.getConnection(ctx, userId),
        await calendarRepo.listSources(ctx, userId),
      ),
    );

  /**
   * Removes the app's events (events only, never the calendar), revokes the refresh token and
   * deletes every calendar row of the user. With `bestEffort` (account deletion) a Google failure
   * is logged and skipped so it can never block the deletion.
   */
  async function disconnectUser(userId: string, bestEffort: boolean): Promise<void> {
    const conn = await db.withUser(userId, (ctx) => calendarRepo.getConnection(ctx, userId));
    if (conn) {
      let refreshToken: string | null = null;
      try {
        refreshToken = conn.refresh_token_ciphertext
          ? crypto.decrypt(conn.refresh_token_ciphertext, userId)
          : null;
        if (refreshToken && conn.app_calendar_id) {
          const guard = createWriteGuard(providerFor(refreshToken), conn.app_calendar_id);
          await guard.deleteAllAppEvents(conn.app_calendar_id);
        }
      } catch (error) {
        const credentialsDead =
          error instanceof CalendarAuthError || error instanceof CalendarCryptoError;
        if (credentialsDead && !bestEffort) {
          // Without a usable token the events cannot be deleted, but the user must still be able
          // to leave. The rows are cleared below; the app's events may remain in Google until the
          // user deletes the calendar there.
          log.warn(
            { reason: error.name },
            'calendar disconnected without deleting events: credentials no longer work',
          );
        } else if (!bestEffort) {
          throw await toHttpError(userId, error);
        } else {
          log.warn(
            { reason: error instanceof Error ? error.name : 'unknown' },
            'calendar cleanup before account deletion did not finish',
          );
        }
      }
      // Best effort in both modes: a failed revoke never blocks the disconnect.
      if (refreshToken) await revokeToken(oauth, refreshToken);
    }
    await db.withUser(userId, (ctx) => calendarRepo.deleteAll(ctx, userId));
  }

  return {
    markNeedsReconnect,
    /** A provider for a decrypted refresh token; used by the sync engine. */
    providerFor,

    getCalendar: view,

    /**
     * What the calendar view shows from the owner's other calendars for [from, to] (inclusive
     * local dates), plus the slots of blocks the owner deleted in Google for one plan: `planId`,
     * or the newest active plan (as the sync does). Those slots are split in the plan's time zone.
     * Read only; for display to the owner alone.
     */
    async getBusy(userId: string, from: string, to: string, planId?: string): Promise<BusyItem[]> {
      return db.withUser(userId, async (ctx) => {
        const items: BusyItem[] = (await calendarRepo.listBusy(ctx, userId, from, to)).map((r) => ({
          date: r.date,
          startMinute: r.start_minute,
          endMinute: r.end_minute,
          allDay: r.all_day,
          kind: r.kind,
          title: r.title,
        }));
        let plan: { id: string; timezone: string } | null = null;
        if (planId) {
          const timezone = await calendarRepo.planTimezone(ctx, userId, planId);
          if (timezone === null) throw new HttpError(404, 'not_found', 'Resource not found.');
          plan = { id: planId, timezone };
        } else {
          const newest = (await syncRepo.activePlans(ctx, userId, 1))[0];
          if (newest) plan = { id: newest.id, timezone: newest.timezone };
        }
        if (plan) {
          for (const l of await calendarRepo.listDeletedLocks(ctx, userId, plan.id, from, to)) {
            for (const i of splitByDay(l.starts_at.getTime(), l.ends_at.getTime(), plan.timezone)) {
              if (i.date < from || i.date > to || i.endMinute <= i.startMinute) continue;
              items.push({
                date: i.date,
                startMinute: i.startMinute,
                endMinute: i.endMinute,
                allDay: false,
                kind: 'busy',
                title: '',
              });
            }
          }
        }
        return items.sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
      });
    },

    async startConnect(userId: string): Promise<{ authorizationUrl: string }> {
      const state = createStateNonce();
      const pkce = createPkce();
      await db.withUser(userId, (ctx) =>
        calendarRepo.insertState(
          ctx,
          userId,
          sha256Hex(state),
          crypto.encrypt(pkce.verifier, userId),
          now(),
        ),
      );
      return {
        authorizationUrl: buildAuthorizationUrl({
          clientId: google.clientId,
          redirectUri: google.redirectUri,
          state,
          codeChallenge: pkce.challenge,
        }),
      };
    },

    /** `userId` is the signed-in user's. The state is looked up for THIS user only. */
    async completeConnect(userId: string, code: string, state: string): Promise<CalendarView> {
      const invalidState = () =>
        new HttpError(
          400,
          'invalid_state',
          'This connection attempt is not valid or has expired. Start again.',
        );
      const consumed = await db.withUser(userId, (ctx) =>
        calendarRepo.consumeState(ctx, userId, sha256Hex(state)),
      );
      if (!consumed || consumed.expiresAt.getTime() <= now().getTime()) throw invalidState();

      let verifier: string;
      try {
        verifier = crypto.decrypt(consumed.verifierCiphertext, userId);
      } catch {
        throw invalidState();
      }

      let tokens;
      try {
        tokens = await exchangeAuthorizationCode(oauth, code, verifier);
      } catch (error) {
        if (error instanceof OAuthCodeRejectedError) {
          throw new HttpError(
            400,
            'code_rejected',
            'Google did not accept this connection attempt. Start again.',
          );
        }
        // No connection is stored for this token yet: nothing to flag.
        throw await toHttpError(userId, error, false);
      }

      const toRevoke = tokens.refreshToken ?? tokens.accessToken;
      const missing = CALENDAR_SCOPES.some((scope) => !tokens.scopes.includes(scope));
      if (missing) {
        await revokeToken(oauth, toRevoke);
        throw new HttpError(
          400,
          'scopes_not_granted',
          'Both calendar permissions are needed. Nothing was connected; try again and allow both.',
        );
      }
      if (!tokens.refreshToken) {
        await revokeToken(oauth, toRevoke);
        throw new HttpError(
          400,
          'no_refresh_token',
          'Google did not allow lasting access. Nothing was connected; try again.',
        );
      }

      try {
        const existing = await db.withUser(userId, (ctx) =>
          calendarRepo.getConnection(ctx, userId),
        );
        const provider = providerFor(tokens.refreshToken, tokens.accessToken);
        const calendars = await provider.listCalendars();
        // Reuse the stored calendar if the user did not delete it; otherwise make a new one.
        const reuse =
          existing?.app_calendar_id && calendars.some((c) => c.id === existing.app_calendar_id)
            ? existing.app_calendar_id
            : null;
        const appCalendarId = reuse ?? (await provider.createCalendar(APP_CALENDAR_NAME)).id;
        const ciphertext = crypto.encrypt(tokens.refreshToken, userId);
        await db.withUser(userId, async (ctx) => {
          await calendarRepo.upsertConnection(ctx, userId, {
            appCalendarId,
            refreshTokenCiphertext: ciphertext,
            grantedScopes: tokens.scopes.slice(0, 20),
          });
          // The primary calendar blocks time by default; the rest are opt-in. The app's own
          // calendar is never a source. Known calendars keep the user's earlier choice.
          for (const calendar of calendars.slice(0, 200)) {
            if (calendar.id === appCalendarId) continue;
            await calendarRepo.upsertSource(
              ctx,
              userId,
              calendar.id,
              calendar.name.slice(0, 300),
              calendar.primary,
            );
          }
        });
      } catch (error) {
        // Nothing was stored for this token: do not leave a live grant behind.
        await revokeToken(oauth, tokens.refreshToken);
        // The failure belongs to the NEW token: an existing healthy connection stays as it is.
        throw await toHttpError(userId, error, false);
      }
      // The old refresh token is overwritten and deliberately NOT revoked: Google may treat a
      // revoke as ending the whole grant, which would kill the new token too (needs check).
      // Google allows several refresh tokens per client and user; the oldest expires after 100.
      return view(userId);
    },

    async setSources(
      userId: string,
      sources: { calendarId: string; blocksTime: boolean }[],
    ): Promise<CalendarView> {
      return db.withUser(userId, async (ctx) => {
        for (const s of sources) {
          const n = await calendarRepo.setBlocksTime(ctx, userId, s.calendarId, s.blocksTime);
          // Throwing rolls the whole change back.
          if (n === 0) {
            throw new HttpError(404, 'unknown_calendar', 'One of the calendars is not connected.');
          }
        }
        return toView(
          await calendarRepo.getConnection(ctx, userId),
          await calendarRepo.listSources(ctx, userId),
        );
      });
    },

    /** The user's own disconnect. Google trouble is reported and nothing is deleted. */
    disconnect: (userId: string) => disconnectUser(userId, false),

    /**
     * Account deletion, before any account data is removed. Never throws for Google trouble: the
     * deletion must go ahead, and the rows go with the account anyway.
     */
    async cleanupForAccountDeletion(userId: string): Promise<void> {
      try {
        await disconnectUser(userId, true);
      } catch (error) {
        // Only the database can fail here; the account deletion that follows reports it.
        log.warn(
          { reason: error instanceof Error ? error.name : 'unknown' },
          'calendar rows were not cleared before account deletion',
        );
      }
    },
  };
}

export type CalendarService = ReturnType<typeof createCalendarService>;
