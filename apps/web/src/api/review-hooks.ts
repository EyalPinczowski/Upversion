import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from './client';
import { useApi } from './context';
import { isApiError } from './errors';
import { planKey, plansKey, progressKey, scheduleKey, tasksKey } from './hooks';
import type { paths } from './schema';

/**
 * Data hooks of the end-of-day review, the adjustment suggestions and the review history (spec 3.4).
 * Nothing here applies a plan change on its own: preview computes, accept and reject are explicit.
 */
type JsonOf<T> = T extends { responses: { 200: { content: { 'application/json': infer B } } } }
  ? B
  : never;
type BodyOf<T> = T extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : never;

const REVIEW = '/api/v1/plans/{planId}/days/{date}/review' as const;
export type StoredReview = JsonOf<paths[typeof REVIEW]['get']>;
export type ReviewInput = BodyOf<paths[typeof REVIEW]['put']>;
export type TaskOutcome = NonNullable<ReviewInput['outcomes']>[number];
export type ReviewResult = JsonOf<paths[typeof REVIEW]['put']>;
export type ReviewPoint = JsonOf<paths['/api/v1/plans/{planId}/reviews']['get']>['reviews'][number];
export type SuggestionList = JsonOf<paths['/api/v1/plans/{planId}/suggestions']['get']>;
export type Suggestion = SuggestionList['suggestions'][number];
export type ProposedChange = Suggestion['proposedChange'];
export type SuggestionPreview = JsonOf<
  paths['/api/v1/plans/{planId}/suggestions/{id}/preview']['post']
>;
export type Decision = JsonOf<paths['/api/v1/plans/{planId}/suggestions/{id}/accept']['post']>;

export const reviewKey = (planId: string, date: string) => ['review', planId, date] as const;
export const reviewHistoryKey = (planId: string) => ['review-history', planId] as const;
export const suggestionsKey = (planId: string) => ['suggestions', planId] as const;

const mutationDefaults = { networkMode: 'always' } as const;

/** The stored review of a day, or null when there is none yet (the API answers 404). */
export function useReview(planId: string | undefined, date: string) {
  const api = useApi();
  return useQuery({
    queryKey: reviewKey(planId ?? '', date),
    queryFn: async ({ signal }): Promise<StoredReview | null> => {
      try {
        return await unwrap(
          api.raw.GET(REVIEW, { params: { path: { planId: planId!, date } }, signal }),
        );
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    enabled: !!planId,
  });
}

/** Saves the review. It never logs hours and never marks a task done; the response says what is left. */
export function useSubmitReview(planId: string, date: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: ReviewInput) =>
      unwrap(api.raw.PUT(REVIEW, { params: { path: { planId, date } }, body })),
    onSuccess: (result) => {
      queryClient.setQueryData(reviewKey(planId, date), result.review);
      void queryClient.invalidateQueries({ queryKey: reviewHistoryKey(planId) });
      void queryClient.invalidateQueries({ queryKey: suggestionsKey(planId) });
    },
  });
}

/** Ratings per day for the trend chart, oldest first. */
export function useReviewHistory(planId: string | undefined, from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...reviewHistoryKey(planId ?? ''), from, to],
    queryFn: ({ signal }) =>
      unwrap(
        api.raw.GET('/api/v1/plans/{planId}/reviews', {
          params: { path: { planId: planId! }, query: { from, to } },
          signal,
        }),
      ),
    enabled: !!planId,
  });
}

export function useSuggestions(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: suggestionsKey(planId ?? ''),
    queryFn: ({ signal }) =>
      unwrap(
        api.raw.GET('/api/v1/plans/{planId}/suggestions', {
          params: { path: { planId: planId! } },
          signal,
        }),
      ),
    enabled: !!planId,
  });
}

/** A 409 means the evidence changed since the list was loaded: reload the list. */
function useRefetchWhenStale(planId: string) {
  const queryClient = useQueryClient();
  return (error: unknown) => {
    if (isApiError(error) && error.status === 409) {
      void queryClient.invalidateQueries({ queryKey: suggestionsKey(planId) });
    }
  };
}

/** Computes what one option would do. Saves nothing. */
export function usePreviewSuggestion(planId: string) {
  const api = useApi();
  const onStale = useRefetchWhenStale(planId);
  return useMutation({
    ...mutationDefaults,
    mutationFn: ({ id, option }: { id: string; option: number }) =>
      unwrap(
        api.raw.POST('/api/v1/plans/{planId}/suggestions/{id}/preview', {
          params: { path: { planId, id }, query: { option } },
        }),
      ),
    onError: onStale,
  });
}

/** Applies a suggestion. The body carries only the chosen option; the change is computed on the server. */
export function useAcceptSuggestion(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const onStale = useRefetchWhenStale(planId);
  return useMutation({
    ...mutationDefaults,
    mutationFn: ({ id, option }: { id: string; option: number }) =>
      unwrap(
        api.raw.POST('/api/v1/plans/{planId}/suggestions/{id}/accept', {
          params: { path: { planId, id } },
          body: { option },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: suggestionsKey(planId) });
      void queryClient.invalidateQueries({ queryKey: scheduleKey(planId) });
      void queryClient.invalidateQueries({ queryKey: tasksKey(planId) });
      void queryClient.invalidateQueries({ queryKey: progressKey(planId) });
      void queryClient.invalidateQueries({ queryKey: planKey(planId) });
      void queryClient.invalidateQueries({ queryKey: plansKey });
      void queryClient.invalidateQueries({ queryKey: ['briefing', planId] });
    },
    onError: onStale,
  });
}

export function useRejectSuggestion(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const onStale = useRefetchWhenStale(planId);
  return useMutation({
    ...mutationDefaults,
    mutationFn: ({ id }: { id: string }) =>
      unwrap(
        api.raw.POST('/api/v1/plans/{planId}/suggestions/{id}/reject', {
          params: { path: { planId, id } },
          body: {},
        }),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: suggestionsKey(planId) }),
    onError: onStale,
  });
}
