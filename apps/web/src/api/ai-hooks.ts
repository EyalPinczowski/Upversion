import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap } from './client';
import { useApi } from './context';
import type { paths } from './schema';

const USAGE = '/api/v1/ai/usage' as const;

export type AiUsage = paths[typeof USAGE]['get']['responses'][200]['content']['application/json'];

/** Today's AI usage (the user's own caps and the environment's providers). Counts only, no money. */
export function useAiUsage(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['ai-usage'],
    queryFn: ({ signal }) => unwrap(api.raw.GET(USAGE, { signal })),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

const TAILOR = '/api/v1/me/cv/tailor' as const;

export type CvTailorBody = NonNullable<
  paths[typeof TAILOR]['post']['requestBody']
>['content']['application/json'];
export type CvTailorResult =
  paths[typeof TAILOR]['post']['responses'][200]['content']['application/json'];

/** True when the server has the CV tailoring feature on (the flag only, not provider availability). */
export function useCvTailorEnabled() {
  const usage = useAiUsage();
  return usage.data?.features.cvTailor === true;
}

/**
 * The one call that sends CV text to a model (ADR 016). The caller shows the preview first and
 * calls this only from the "Send to AI" button. No retry, no cache: the answer is returned once.
 */
export function useCvTailor() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    retry: false,
    gcTime: 0,
    mutationFn: (body: CvTailorBody) => unwrap(api.raw.POST(TAILOR, { body })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['ai-usage'] }),
  });
}
