import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ProfileImportBody, ProfileView, SetupStatusBody } from './client';
import { useApi } from './context';
import { isApiError } from './errors';

/**
 * Data hooks of the first-time setup and the profile it fills (ADR 015). The whole feature sits
 * behind FEATURE_PROFILE_SETUP on the server: when it is off every profile route answers 404, and
 * the profile query then yields `null`, which the UI treats as "show nothing, redirect nowhere".
 */
export const profileKey = ['profile'] as const;

const mutationDefaults = { networkMode: 'always' } as const;

/** The profile, or null when the feature is switched off on the server (404). */
export function useProfile() {
  const api = useApi();
  return useQuery({
    queryKey: profileKey,
    queryFn: async ({ signal }): Promise<ProfileView | null> => {
      try {
        return await api.getProfile(signal);
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** Every write answers 200 with the full profile: put it straight into the cache. */
function settle(queryClient: QueryClient, profile: ProfileView) {
  queryClient.setQueryData(profileKey, profile);
}

/** Saves the answer(s) of one screen (partial merge on the server, safe to repeat). */
export function useSaveAnswers() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (answers: Record<string, unknown>) => api.putProfileAnswers(answers),
    onSuccess: (profile) => settle(queryClient, profile),
  });
}

/** Sends the confirmed CV items. The body is built by `toImportPayload` and nothing else. */
export function useImportProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: ProfileImportBody) => api.putProfileImport(body),
    onSuccess: (profile) => settle(queryClient, profile),
  });
}

/** Moves the setup status and the saved step. */
export function useSetSetup() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: SetupStatusBody) => api.patchProfileSetup(body),
    onSuccess: (profile) => settle(queryClient, profile),
  });
}

/** "Clear my profile": the server keeps the row with the status `dismissed`. */
export function useClearProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: () => api.deleteProfile(),
    onSuccess: (profile) => settle(queryClient, profile),
  });
}
