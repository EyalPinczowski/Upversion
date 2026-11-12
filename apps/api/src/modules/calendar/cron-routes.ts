import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema, HttpError } from '../../errors';
import { noNulCharacters } from '../../validation';
import { bearerToken, secretsMatch, type CalendarCron } from './cron';

export interface CalendarCronRoutesOptions {
  /** Holds the secret: never log or serialise it. */
  secret: string;
  cron: CalendarCron;
}

/** Strict and empty: no user id and no other client data is ever accepted. */
const cronBody = noNulCharacters(z.strictObject({}));

const cronView = z.object({
  due: z.number().int(),
  synced: z.number().int(),
  cached: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

/** Per IP, on top of the global limit inside the service. */
export const CRON_ROUTE_MAX_PER_MINUTE = 6;

const unauthorized = () => new HttpError(401, 'unauthorized', 'Authentication is required.');

/**
 * `POST /internal/calendar/sync-due` for the Cloudflare cron worker. Registered only when
 * FEATURE_CALENDAR_CRON is on and CALENDAR_CRON_SECRET is set (otherwise 404). No user token: a
 * shared secret in the Authorization header, checked first (before the body) in constant time.
 * Hidden from the OpenAPI document: it is not part of the web app's API.
 */
export const calendarCronRoutes: FastifyPluginAsyncZod<CalendarCronRoutesOptions> = async (
  app,
  { secret, cron },
) => {
  // Per IP, checked first, so wrong guesses are limited too. In memory: one API process.
  const perIp = new Map<string, { windowStart: number; count: number }>();
  app.addHook('onRequest', async (request) => {
    const now = Date.now();
    if (perIp.size > 1000) {
      for (const [ip, entry] of perIp) if (now - entry.windowStart >= 60_000) perIp.delete(ip);
    }
    const entry = perIp.get(request.ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      perIp.set(request.ip, { windowStart: now, count: 1 });
    } else if (++entry.count > CRON_ROUTE_MAX_PER_MINUTE) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.', undefined, {
        'retry-after': '60',
      });
    }
    const provided = bearerToken(request.headers.authorization);
    // Same generic answer for missing, malformed, short and wrong secrets.
    if (provided === null || !secretsMatch(provided, secret)) throw unauthorized();
  });

  app.post(
    '/internal/calendar/sync-due',
    {
      schema: {
        hide: true,
        body: cronBody.nullish(),
        response: {
          200: cronView,
          401: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!cron.allowRun()) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many requests. Please slow down.',
          undefined,
          { 'retry-after': '60' },
        );
      }
      return reply.send(await cron.run());
    },
  );
};
