import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import {
  busyQuery,
  busyView,
  callbackBody,
  calendarView,
  connectView,
  syncBody,
  syncView,
  updateSourcesBody,
} from './schemas';
import type { CalendarService } from './service';
import type { CalendarSync } from './sync';

export interface CalendarRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  /** Null together with `db`. */
  service: CalendarService | null;
  /** Null together with `db`. */
  sync: CalendarSync | null;
}

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  409: errorResponseSchema,
  429: errorResponseSchema,
  502: errorResponseSchema,
};
const security = [{ bearerAuth: [] }];
const tags = ['calendar'];

/**
 * Google Calendar connect and disconnect (spec 3.8). Registered only when FEATURE_CALENDAR is on,
 * so with the flag off these paths do not exist (404). The user id comes from the verified token
 * only: no body field, query value or OAuth state ever names a user. No response carries a token.
 */
export const calendarRoutes: FastifyPluginAsyncZod<CalendarRoutesOptions> = async (
  app,
  { verifier, db, service, sync },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const user = (request: FastifyRequest) => request.accountId!;

  app.get(
    '/calendar',
    {
      schema: {
        tags,
        summary: 'Calendar connection status and the calendars that block time',
        security,
        response: { 200: calendarView, ...errors },
      },
    },
    async (request) => service!.getCalendar(user(request)),
  );

  app.get(
    '/calendar/busy',
    {
      schema: {
        tags,
        summary: 'Busy time from the calendars that block study time',
        description:
          "Read only. `from` and `to` are local dates (inclusive, at most 14 days). Returns only the intervals of calendars the owner chose to block time (and slots of study blocks the owner deleted in Google), with start and end minutes of the day, an all-day flag and the event title. This is the owner's own calendar data for display to the owner; it is never sent to an AI model.",
        security,
        querystring: busyQuery,
        response: { 200: busyView, ...errors },
      },
    },
    async (request) => {
      const { from, to } = request.query;
      return { items: await service!.getBusy(user(request), from, to) };
    },
  );

  app.post(
    '/calendar/connect',
    {
      schema: {
        tags,
        summary: 'Start connecting Google Calendar',
        description:
          'Returns the Google consent URL (PKCE S256, single-use state valid for 10 minutes, only the calendar.app.created and calendar.readonly scopes). Redirect the browser there.',
        security,
        response: { 200: connectView, ...errors },
      },
    },
    async (request) => service!.startConnect(user(request)),
  );

  app.post(
    '/calendar/callback',
    {
      schema: {
        tags,
        summary: 'Finish connecting Google Calendar',
        description:
          'Send the `code` and `state` Google returned to the web app. The state must have been issued to the signed-in user and is single use. If Google granted less than both scopes, nothing is connected and the grant is revoked (400 `scopes_not_granted`).',
        security,
        body: callbackBody,
        response: { 200: calendarView, ...errors },
      },
    },
    async (request) =>
      service!.completeConnect(user(request), request.body.code, request.body.state),
  );

  app.put(
    '/calendar/sources',
    {
      schema: {
        tags,
        summary: 'Choose which calendars block study time',
        security,
        body: updateSourcesBody,
        response: { 200: calendarView, 404: errorResponseSchema, ...errors },
      },
    },
    async (request) => service!.setSources(user(request), request.body.sources),
  );

  app.post(
    '/calendar/sync',
    {
      schema: {
        tags,
        summary: 'Sync the calendar now (also called when the app opens)',
        description:
          'Reads busy time from the calendars that block time, mirrors the next 14 days of planned blocks into the app calendar, picks up blocks the user moved or deleted there (they become fixed decisions the schedule plans around) and returns what the calendar changed in the plan. Within 5 minutes of the last sync the stored result is returned without calling Google (`status: cached`); `force` skips that but is honoured at most once a minute. 409 `sync_in_progress` when a sync is already running, 409 `calendar_reconnect_required` when Google no longer accepts the connection (nothing is changed), 503 with `Retry-After` when Google cannot be reached (nothing is changed). The schedule works without any of this.',
        security,
        body: syncBody.nullish(),
        response: { 200: syncView, 503: errorResponseSchema, ...errors },
      },
    },
    async (request) => sync!.syncNow(user(request), { force: request.body?.force === true }),
  );

  app.delete(
    '/calendar',
    {
      schema: {
        tags,
        summary: 'Disconnect Google Calendar',
        description:
          'Deletes the events the app created (never the calendar itself and never other events), revokes the refresh token at Google (best effort) and deletes the calendar data the app stores. If Google rejects the stored credentials (consent revoked), the events cannot be deleted: the local data is still cleared and the events the app created may remain in Google until the user deletes the calendar there. If Google cannot be reached (502), nothing is deleted and the request can be repeated later.',
        security,
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await service!.disconnect(user(request));
      return reply.status(204).send(null);
    },
  );
};
