import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AIUsageStore } from '../../ai/budget';
import type { AIGateway } from '../../ai/gateway';
import type { AIPurpose } from '../../ai/provider';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';

export interface AIRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the routes then answer 503. */
  db: Database | null;
  gateway: AIGateway;
  usage: AIUsageStore;
  /** The per-user daily caps (from config). */
  userCaps: Readonly<Record<AIPurpose, number>>;
  /** Feature flags the web reads here instead of probing a route. */
  features: { cvTailor: boolean; planBuilder: boolean };
}

const meter = z.object({ used: z.number().int(), cap: z.number().int() });

const usageSchema = z.object({
  day: z.string(),
  resetsAt: z.string(),
  /** True when at least one provider is configured. False means AI is off and nothing errors. */
  configured: z.boolean(),
  user: z.object({
    practiceMessages: meter,
    practiceFeedback: meter,
    dayOverview: meter,
    cvTailor: meter,
  }),
  /** The flags only: `cvTailor` says nothing about whether a provider is available. */
  features: z.object({ cvTailor: z.boolean(), planBuilder: z.boolean() }),
  avoidedToday: z.number().int(),
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      configured: z.boolean(),
      available: z.boolean(),
      cooldownUntil: z.string().nullable(),
      usedToday: z.number().int(),
      budget: z.number().int().nullable(),
    }),
  ),
});

const errors = {
  401: errorResponseSchema,
  403: errorResponseSchema,
  429: errorResponseSchema,
  503: errorResponseSchema,
};

export const aiRoutes: FastifyPluginAsyncZod<AIRoutesOptions> = async (
  app,
  { verifier, db, gateway, usage, userCaps, features },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const user = (request: FastifyRequest) => request.accountId!;

  app.get(
    '/ai/usage',
    {
      schema: {
        tags: ['ai'],
        summary: 'Today’s AI usage for the signed-in user and for this environment',
        description:
          'Shows this environment’s own budget per provider (calls reserved today, UTC), not a quota claimed by the provider. With no provider configured, `configured` is false and the lists are empty. `avoidedToday` counts calls that were not needed (cache, template, rubric).',
        security: [{ bearerAuth: [] }],
        response: { 200: usageSchema, ...errors },
      },
    },
    async (request) => {
      const snap = await usage.snapshot(user(request));
      const providers = gateway.providers().map((p) => {
        const usedToday = snap.providers[p.id] ?? 0;
        return {
          id: p.id,
          label: p.label,
          configured: p.configured,
          available:
            p.configured && p.cooldownUntil === null && p.budget !== null && usedToday < p.budget,
          cooldownUntil: p.cooldownUntil ? p.cooldownUntil.toISOString() : null,
          usedToday,
          budget: p.budget,
        };
      });
      const entry = (purpose: AIPurpose) => ({
        used: snap.user[purpose].used,
        cap: userCaps[purpose],
      });
      return {
        day: snap.day,
        resetsAt: snap.resetsAt.toISOString(),
        configured: providers.some((p) => p.configured),
        user: {
          practiceMessages: entry('practice_message'),
          practiceFeedback: entry('practice_feedback'),
          dayOverview: entry('day_overview'),
          cvTailor: entry('cv_tailor'),
        },
        features: { cvTailor: features.cvTailor, planBuilder: features.planBuilder },
        avoidedToday: Object.values(snap.user).reduce((n, u) => n + u.avoided, 0),
        providers,
      };
    },
  );
};
