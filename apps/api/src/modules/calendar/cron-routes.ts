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

/** Failed attempts per IP per minute. Valid calls are limited inside the service. */
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
  // The secret is checked first, in constant time. Only FAILED attempts are counted per IP (in
  // memory, one API process), so a flood of wrong guesses from a shared proxy address can never
  // make a valid call answer 429. Valid calls are limited by `cron.allowRun()` instead. This does NOT
  // throttle guessing: a correct secret is accepted even from a rate-limited IP. The secret's length
  // (at least 32 characters, enforced at start-up) is the protection; a 429 here only means
  // "wrong and rate-limited".
  const failures = new Map<string, { windowStart: number; count: number }>();
  app.addHook('onRequest', async (request) => {
    const provided = bearerToken(request.headers.authorization);
    if (provided !== null && secretsMatch(provided, secret)) return;
    const now = Date.now();
    if (failures.size > 1000) {
      for (const [ip, entry] of failures)
        if (now - entry.windowStart >= 60_000) failures.delete(ip);
    }
    const entry = failures.get(request.ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      failures.set(request.ip, { windowStart: now, count: 1 });
    } else if (++entry.count > CRON_ROUTE_MAX_PER_MINUTE) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Please slow down.', undefined, {
        'retry-after': '60',
      });
    }
    // Same generic answer for missing, malformed, short and wrong secrets.
    throw unauthorized();
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
