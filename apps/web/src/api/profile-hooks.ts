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

/** Takes the profile the server returned when it did, otherwise asks for it again. */
function settle(queryClient: QueryClient, result: unknown) {
  if (result && typeof result === 'object' && 'setupStatus' in result) {
    queryClient.setQueryData(profileKey, result as ProfileView);
  } else {
    void queryClient.invalidateQueries({ queryKey: profileKey });
  }
}

/** Saves the answer(s) of one screen (partial merge on the server, safe to repeat). */
export function useSaveAnswers() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (answers: Record<string, unknown>) => api.putProfileAnswers(answers),
    onSuccess: (result) => settle(queryClient, result),
  });
}

/** Sends the confirmed CV items. The body is built by `toImportPayload` and nothing else. */
export function useImportProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: ProfileImportBody) => api.putProfileImport(body),
    onSuccess: (result) => settle(queryClient, result),
  });
}

/** Moves the setup status and the saved step. */
export function useSetSetup() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (body: SetupStatusBody) => api.patchProfileSetup(body),
    onSuccess: (result) => settle(queryClient, result),
  });
}

/** "Clear my profile": the server keeps the row with the status `dismissed`. */
export function useClearProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: () => api.deleteProfile(),
    onSuccess: (result) => settle(queryClient, result),
  });
}
