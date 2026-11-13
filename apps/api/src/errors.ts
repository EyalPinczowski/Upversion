import { PiiLeakError } from '@upversion/shared';
import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NO_NUL_MESSAGE } from './validation';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    fallbacks: z.array(z.string()).optional(),
    /** The running practice session, on 409 `practice_session_active`. */
    sessionId: z.string().optional(),
    /** The tasks that depend on the one being deleted, on 409 `has_dependents`. */
    dependents: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    /** The reasons a plan request was refused, on 422 from the plan builder: codes and ids only. */
    issues: z.array(z.object({ code: z.string(), id: z.string().optional() })).optional(),
  }),
});

/** An error whose code and message are safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    /** Extra fields safe to show to the client, merged into the error body. */
    public readonly extra?: Record<string, unknown>,
    /** Response headers, for example `retry-after`. */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const clientErrors: Record<number, { code: string; message: string }> = {
  400: { code: 'bad_request', message: 'The request could not be understood.' },
  401: { code: 'unauthorized', message: 'Authentication is required.' },
  403: { code: 'forbidden', message: 'You do not have access to this resource.' },
  404: { code: 'not_found', message: 'Resource not found.' },
  409: { code: 'conflict', message: 'The request conflicts with the current state.' },
  413: { code: 'payload_too_large', message: 'The request body is too large.' },
  415: { code: 'unsupported_media_type', message: 'Unsupported content type.' },
  422: { code: 'unprocessable', message: 'The request could not be processed.' },
  429: { code: 'rate_limited', message: 'Too many requests. Please slow down.' },
};

const otherClientError = { code: 'client_error', message: 'The request was rejected.' };

const body = (requestId: string, code: string, message: string) => ({
  error: { code, message, requestId },
});

/** Every error leaves the API in the same shape; 5xx never exposes messages or stacks. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(body(request.id, 'not_found', clientErrors[404]!.message)),
  );

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      // Text PostgreSQL cannot store is not a malformed request but an unprocessable one.
      if (error.validation.some((issue) => issue.message === NO_NUL_MESSAGE)) {
        return reply.status(422).send(body(request.id, 'unprocessable', NO_NUL_MESSAGE));
      }
      return reply
        .status(400)
        .send(
          body(request.id, 'validation_error', 'The request did not match the expected shape.'),
        );
    }
    if (error instanceof PiiLeakError) {
      // Fails closed: no model call was made. The kinds stay out of the answer.
      return reply
        .status(422)
        .send(
          body(
            request.id,
            'pii_blocked',
            'Personal details were found in the text. Remove names and contact details and try again.',
          ),
        );
    }
    if (error instanceof HttpError) {
      const b = body(request.id, error.code, error.message);
      if (error.headers) reply.headers(error.headers);
      return reply
        .status(error.statusCode)
        .send(error.extra ? { error: { ...b.error, ...error.extra } } : b);
    }
    const status = (error as { statusCode?: unknown }).statusCode;
    if (
      !isResponseSerializationError(error) &&
      typeof status === 'number' &&
      status >= 400 &&
      status < 500
    ) {
      const known = clientErrors[status] ?? otherClientError;
      return reply.status(status).send(body(request.id, known.code, known.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send(body(request.id, 'internal_error', 'Something went wrong on our side.'));
  });
}
