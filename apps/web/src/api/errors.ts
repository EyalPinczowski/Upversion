import { z } from 'zod';

/** The API's single error shape (apps/api/src/errors.ts). */
const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    sessionId: z.string().optional(),
    fallbacks: z.array(z.string()).optional(),
    dependents: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  }),
});

export type ApiErrorKind = 'http' | 'network' | 'timeout';

/** Reads a `Retry-After` header in seconds (the form the API sends) as milliseconds, or null. */
export function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

/** Every failure of an API call: an error response, no connection, or no answer in time. */
export class ApiError extends Error {
  /** How long the server asked to wait before trying again (`Retry-After`), when it said so. */
  retryAfterMs: number | null = null;

  constructor(
    public readonly kind: ApiErrorKind,
    /** HTTP status, or 0 when there was no response. */
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    /** The running practice session, on 409 `practice_session_active`. */
    public readonly sessionId?: string,
    /** What still works when the AI cannot answer (429 `ai_user_cap`, 503 `ai_unavailable`). */
    public readonly fallbacks?: readonly string[],
    /** The tasks that depend on the one being deleted, on 409 `has_dependents`. */
    public readonly dependents?: readonly { id: string; title: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static fromBody(status: number, body: unknown): ApiError {
    const parsed = errorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message, requestId, sessionId, fallbacks, dependents } = parsed.data.error;
      return new ApiError(
        'http',
        status,
        code,
        message,
        requestId,
        sessionId,
        fallbacks,
        dependents,
      );
    }
    return new ApiError('http', status, 'unknown', `The server answered with status ${status}.`);
  }

  static network(): ApiError {
    return new ApiError('network', 0, 'network', 'Can’t reach the server.');
  }

  static timeout(): ApiError {
    return new ApiError('timeout', 0, 'timeout', 'The server took too long to answer.');
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** The AI cannot answer now: its daily cap is used or no provider is available. Practice goes on without it. */
export const isAiUnavailable = (error: unknown): boolean =>
  isApiError(error) &&
  error.kind === 'http' &&
  ((error.status === 503 && error.code === 'ai_unavailable') ||
    (error.status === 429 && error.code === 'ai_user_cap'));
