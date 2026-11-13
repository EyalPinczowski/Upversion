import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BuildPlanBody, BuildRequestBody, RestoreBody } from './client';
import { useApi } from './context';
import { useAiUsage } from './ai-hooks';
import { plansKey } from './hooks';

/** True when the server has the plan builder on (`features.planBuilder`). False while unknown. */
export function usePlanBuilderEnabled(): boolean {
  const usage = useAiUsage();
  return usage.data?.features.planBuilder === true;
}

/** The value, but only after it has stayed the same for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export const PREVIEW_DEBOUNCE_MS = 500;

/**
 * The draft for a request. It saves nothing on the server. The request is the query key, so a new
 * request cancels the one in flight (the signal is passed on) and an old answer can never replace
 * a newer one. The previous draft stays on screen (`isPlaceholderData`) until the new one arrives.
 */
export function useBuildPreview(request: BuildRequestBody | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['plan-build-preview', request],
    queryFn: ({ signal }) => api.previewBuild(request!, signal),
    enabled: request !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    networkMode: 'always',
  });
}

/**
 * Creates the plan (and archives the active ones named in `replacesPlanIds`). The caller keeps the
 * `id` in `body`, so a retry after a lost answer is safe (the server answers 200 with the stored plan).
 */
export function useBuildPlan() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: (body: BuildPlanBody) => api.buildPlan(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansKey }),
  });
}

/** Makes an archived plan the active one again (the active plans are archived in the same step). */
export function useRestorePlan() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: ({ planId, body }: { planId: string; body: RestoreBody }) =>
      api.restorePlan(planId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansKey }),
  });
}
