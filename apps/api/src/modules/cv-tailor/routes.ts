import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AIUsageStore } from '../../ai/budget';
import type { AIGateway } from '../../ai/gateway';
import type { AIRegistry } from '../../ai/registry';
import type { Database } from '../../db/database';
import { errorResponseSchema } from '../../errors';
import { installAccountGuard } from '../accounts/guard';
import { createAccountService } from '../accounts/service';
import type { TokenVerifier } from '../accounts/token-verifier';
import { createUserLimiter } from '../practice/routes';
import { tailorBody, tailorResult } from './schemas';
import { createCvTailorService } from './service';

export interface CvTailorRoutesOptions {
  verifier: TokenVerifier;
  /** Null when no database is configured: the route then answers 503 (the account guard). */
  db: Database | null;
  gateway: AIGateway;
  registry: AIRegistry;
  usage: AIUsageStore;
  userCap: number;
  dailyTotal: number;
}

/** Runs per user per minute (in memory, per API instance). */
export const CV_TAILOR_PER_MINUTE = 3;

const errors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  422: errorResponseSchema,
  429: errorResponseSchema,
  503: errorResponseSchema,
};

/**
 * Tailor my CV to a job (ADR 016). Registered only with FEATURE_CV_TAILOR on, so with the flag off
 * this path does not exist (404). The user id comes from the verified token only. Neither text,
 * the prompt nor the answer is logged, stored or echoed in an error.
 */
export const cvTailorRoutes: FastifyPluginAsyncZod<CvTailorRoutesOptions> = async (
  app,
  { verifier, db, gateway, registry, usage, userCap, dailyTotal },
) => {
  installAccountGuard(app, verifier, db ? createAccountService(db) : null);
  const service = db
    ? createCvTailorService({ db, gateway, registry, usage, userCap, dailyTotal })
    : null;
  const limit = createUserLimiter(CV_TAILOR_PER_MINUTE, 60_000);
  const user = (request: FastifyRequest) => request.accountId!;

  app.post(
    '/me/cv/tailor',
    {
      schema: {
        tags: ['cv-tailor'],
        summary: 'Rewrite the CV text for one job post with a free-tier AI model',
        description:
          'The texts must already be clean: the server checks them as received and answers 422 `pii_blocked` instead of repairing them (nothing is sent to a model then and nothing is counted). Names and street addresses are NOT detected. Only Cloudflare Workers AI, then Groq as a backup, may receive the text; `providers` lists every one that did. 429 `rate_limited` (3 per minute), `ai_user_cap` (3 per day), `ai_feature_cap` (20 per day for everyone). 503 `ai_unavailable` carries no provider information. Nothing is stored or logged: the answer is returned once.',
        security: [{ bearerAuth: [] }],
        body: tailorBody,
        response: { 200: tailorResult, ...errors },
      },
    },
    async (request) => {
      limit(user(request));
      return service!.tailor(user(request), request.body);
    },
  );
};
