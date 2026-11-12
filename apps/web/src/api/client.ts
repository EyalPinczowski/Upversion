import createClient from 'openapi-fetch';
import { combineSignals, REQUEST_TIMEOUT_MS } from '../lib/abort';
import { ApiError, retryAfterMs } from './errors';
import type { paths } from './schema';

export type Me = paths['/api/v1/me']['get']['responses'][200]['content']['application/json'];
export type DataExport =
  paths['/api/v1/me/export']['get']['responses'][200]['content']['application/json'];
export type LegalDocument =
  paths['/api/v1/me/legal-acceptances']['post']['requestBody']['content']['application/json']['document'];

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<Op> = Op extends { responses: infer R }
  ? R extends { 200: infer A }
    ? Json<A>
    : R extends { 201: infer C }
      ? Json<C>
      : never
  : never;
type Body<Op> = Op extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : never;

export type PlanSummary = Ok<paths['/api/v1/plans']['get']>['plans'][number];
export type PlanDetail = Ok<paths['/api/v1/plans/{id}']['get']>;
export type WeekPattern = NonNullable<PlanDetail['weekPattern']>;
export type DayOverride = PlanDetail['overrides'][number];
export type Schedule = Ok<paths['/api/v1/plans/{id}/schedule']['get']>;
export type Block = Schedule['blocks'][number];
export type SchedulePreview = Ok<paths['/api/v1/plans/{id}/schedule/preview']['post']>;
export type PreviewRequest = Body<paths['/api/v1/plans/{id}/schedule/preview']['post']>;
export type Task = Ok<paths['/api/v1/plans/{planId}/tasks']['get']>['tasks'][number];
export type TaskType = Task['type'];
export type OpenTasks = Ok<paths['/api/v1/plans/{id}/open-tasks']['get']>;
export type OpenTask = OpenTasks['tasks'][number];
export type DayState = Ok<paths['/api/v1/plans/{planId}/days/{date}']['get']>;
export type Progress = Ok<paths['/api/v1/plans/{planId}/progress']['get']>;
export type LogRequest = Body<paths['/api/v1/plans/{planId}/tasks/{taskId}/logs']['post']>;
export type LogResult = Ok<paths['/api/v1/plans/{planId}/tasks/{taskId}/logs']['post']>;
export type TaskPatch = Body<paths['/api/v1/plans/{planId}/tasks/{taskId}']['patch']>;
export type ImportBody = Body<paths['/api/v1/plans/import']['post']>;

export type ProfileView = Ok<paths['/api/v1/me/profile']['get']>;
export type ProfileImportBody = Body<paths['/api/v1/me/profile/import']['put']>;
export type SetupStatusBody = Body<paths['/api/v1/me/profile/setup']['patch']>;

export interface ApiClientOptions {
  /** Base URL of the API, without a trailing slash. */
  baseUrl: string;
  /** The current Supabase access token (refreshed by the library), or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Replaceable for tests. Looked up on every call so a stubbed global fetch is honoured. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Turns an openapi-fetch result into the data, or throws the one ApiError shape. */
export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await pending;
  if (!response.ok) {
    const failure = ApiError.fromBody(response.status, error);
    failure.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
    throw failure;
  }
  return data as T;
}

/**
 * The only place that talks to the API: adds the Bearer token, a request timeout and one error
 * type. Hooks in `hooks.ts` are the only callers (spec 12.3: all data access through one layer).
 */
export function createApiClient({
  baseUrl,
  getAccessToken,
  fetch: fetchOverride,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: ApiClientOptions) {
  const guardedFetch = async (request: Request): Promise<Response> => {
    const callerSignal = request.signal;
    // A timer plus AbortController rather than AbortSignal.timeout, so tests can fake the clock.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Request timed out')), timeoutMs);
    try {
      const token = await getAccessToken();
      const headers = new Headers(request.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const outgoing = new Request(request, {
        headers,
        signal: combineSignals(callerSignal, timeout),
      });
      return await (fetchOverride ?? globalThis.fetch)(outgoing);
    } catch (error) {
      // The caller cancelled (for example the query was dropped): not a failure to report.
      if (callerSignal.aborted) throw error;
      throw timeout.signal.aborted ? ApiError.timeout() : ApiError.network();
    } finally {
      clearTimeout(timer);
    }
  };

  const raw = createClient<paths>({ baseUrl, fetch: guardedFetch });

  return {
    /** For hooks of later features: `unwrap(api.raw.GET('/api/v1/plans'))`. */
    raw,
    getMe: (signal?: AbortSignal) => unwrap(raw.GET('/api/v1/me', { signal })),
    updateDisplayName: (displayName: string | null) =>
      unwrap(raw.PATCH('/api/v1/me', { body: { displayName } })),
    acceptLegal: (document: LegalDocument, version: string) =>
      unwrap(raw.POST('/api/v1/me/legal-acceptances', { body: { document, version } })),
    listPlans: (signal?: AbortSignal) => unwrap(raw.GET('/api/v1/plans', { signal })),
    getPlan: (id: string, signal?: AbortSignal) =>
      unwrap(raw.GET('/api/v1/plans/{id}', { params: { path: { id } }, signal })),
    deletePlan: (id: string) =>
      unwrap(raw.DELETE('/api/v1/plans/{id}', { params: { path: { id } } })),
    importPlan: (body: ImportBody) => unwrap(raw.POST('/api/v1/plans/import', { body })),
    getSchedule: (id: string, signal?: AbortSignal) =>
      unwrap(raw.GET('/api/v1/plans/{id}/schedule', { params: { path: { id } }, signal })),
    previewSchedule: (id: string, body: PreviewRequest) =>
      unwrap(raw.POST('/api/v1/plans/{id}/schedule/preview', { params: { path: { id } }, body })),
    putWeekPattern: (id: string, body: WeekPattern) =>
      unwrap(raw.PUT('/api/v1/plans/{id}/week-pattern', { params: { path: { id } }, body })),
    putStartDate: (id: string, startDate: string) =>
      unwrap(
        raw.PUT('/api/v1/plans/{id}/start-date', { params: { path: { id } }, body: { startDate } }),
      ),
    putDayOverride: (id: string, date: string, body: Omit<DayOverride, 'date'>) =>
      unwrap(
        raw.PUT('/api/v1/plans/{id}/day-overrides/{date}', {
          params: { path: { id, date } },
          body,
        }),
      ),
    deleteDayOverride: (id: string, date: string) =>
      unwrap(
        raw.DELETE('/api/v1/plans/{id}/day-overrides/{date}', { params: { path: { id, date } } }),
      ),
    listTasks: (planId: string, signal?: AbortSignal) =>
      unwrap(raw.GET('/api/v1/plans/{planId}/tasks', { params: { path: { planId } }, signal })),
    patchTask: (planId: string, taskId: string, body: TaskPatch) =>
      unwrap(
        raw.PATCH('/api/v1/plans/{planId}/tasks/{taskId}', {
          params: { path: { planId, taskId } },
          body,
        }),
      ),
    deleteTask: (planId: string, taskId: string, removeDependencies: boolean) =>
      unwrap(
        raw.DELETE('/api/v1/plans/{planId}/tasks/{taskId}', {
          params: {
            path: { planId, taskId },
            ...(removeDependencies ? { query: { removeDependencies: 'true' as const } } : {}),
          },
        }),
      ),
    addLog: (planId: string, taskId: string, body: LogRequest) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/tasks/{taskId}/logs', {
          params: { path: { planId, taskId } },
          body,
        }),
      ),
    completeTask: (planId: string, taskId: string) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/tasks/{taskId}/complete', {
          params: { path: { planId, taskId } },
        }),
      ),
    skipTask: (planId: string, taskId: string) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/tasks/{taskId}/skip', {
          params: { path: { planId, taskId } },
        }),
      ),
    reopenTask: (planId: string, taskId: string) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/tasks/{taskId}/reopen', {
          params: { path: { planId, taskId } },
        }),
      ),
    getProgress: (planId: string, signal?: AbortSignal) =>
      unwrap(raw.GET('/api/v1/plans/{planId}/progress', { params: { path: { planId } }, signal })),
    listLogs: (planId: string, from: string, to: string, signal?: AbortSignal) =>
      unwrap(
        raw.GET('/api/v1/plans/{planId}/logs', {
          params: { path: { planId }, query: { from, to } },
          signal,
        }),
      ),
    getOpenTasks: (id: string, signal?: AbortSignal) =>
      unwrap(raw.GET('/api/v1/plans/{id}/open-tasks', { params: { path: { id } }, signal })),
    getDay: (planId: string, date: string, signal?: AbortSignal) =>
      unwrap(
        raw.GET('/api/v1/plans/{planId}/days/{date}', {
          params: { path: { planId, date } },
          signal,
        }),
      ),
    startDay: (planId: string, date: string) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/days/{date}/start', {
          params: { path: { planId, date } },
        }),
      ),
    endDay: (planId: string, date: string) =>
      unwrap(
        raw.POST('/api/v1/plans/{planId}/days/{date}/end', {
          params: { path: { planId, date } },
        }),
      ),
    getProfile: (signal?: AbortSignal) => unwrap(raw.GET('/api/v1/me/profile', { signal })),
    putProfileAnswers: (answers: Record<string, unknown>) =>
      unwrap(raw.PUT('/api/v1/me/profile/answers', { body: { answers } })),
    putProfileImport: (body: ProfileImportBody) =>
      unwrap(raw.PUT('/api/v1/me/profile/import', { body })),
    patchProfileSetup: (body: SetupStatusBody) =>
      unwrap(raw.PATCH('/api/v1/me/profile/setup', { body })),
    deleteProfile: () => unwrap(raw.DELETE('/api/v1/me/profile', { body: {} })),
    exportData: () => unwrap(raw.GET('/api/v1/me/export')),
    deleteAccount: (confirmation: string) =>
      unwrap(raw.DELETE('/api/v1/me', { body: { confirmation } })),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
