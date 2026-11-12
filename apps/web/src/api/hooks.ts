import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DayOverride,
  ImportBody,
  LegalDocument,
  LogRequest,
  Me,
  PreviewRequest,
  TaskPatch,
  WeekPattern,
} from './client';
import { CHANGES_PLANNED_BLOCKS } from '../calendar/auto-sync-state';
import { useApi } from './context';

/**
 * The one data layer (spec 12.3): components never call the client or fetch directly, they use the
 * hooks below. Later features add their hooks here, next to these.
 */
export const meKey = ['me'] as const;

// Mutations use networkMode "always": offline they fail at once with a network error the form can
// show, instead of waiting silently for a connection.
const mutationDefaults = { networkMode: 'always' } as const;

// Mutations that change planned blocks also tell the calendar auto-sync to look again soon.
const planChangeDefaults = { ...mutationDefaults, meta: CHANGES_PLANNED_BLOCKS } as const;

// The plan summary bar and the page under it read the same schedule, tasks and progress. Without
// a short freshness window the second one to mount would fetch them all again.
const SHARED_STALE_MS = 10_000;

/** The signed-in account. A 403 here means the email is not on the allowlist. */
export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: meKey, queryFn: ({ signal }) => api.getMe(signal) });
}

export function useUpdateDisplayName() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (displayName: string | null) => api.updateDisplayName(displayName),
    onSuccess: (me: Me) => queryClient.setQueryData(meKey, me),
  });
}

/** Accepts each given document at the version the API reported as current. */
export function useAcceptLegal() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: async (documents: { document: LegalDocument; version: string }[]) => {
      let me: Me | undefined;
      for (const { document, version } of documents) {
        me = await api.acceptLegal(document, version);
      }
      return me!;
    },
    onSuccess: (me: Me) => queryClient.setQueryData(meKey, me),
  });
}

export function useExportData() {
  const api = useApi();
  return useMutation({ ...mutationDefaults, mutationFn: () => api.exportData() });
}

export function useDeleteAccount() {
  const api = useApi();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (confirmation: string) => api.deleteAccount(confirmation),
  });
}

// Plans, schedule, tasks and progress (v0.1).
export const plansKey = ['plans'] as const;
export const planKey = (planId: string) => ['plan', planId] as const;
export const tasksKey = (planId: string) => ['tasks', planId] as const;
export const scheduleKey = (planId: string) => ['schedule', planId] as const;
export const progressKey = (planId: string) => ['progress', planId] as const;
export const openTasksKey = (planId: string) => ['open-tasks', planId] as const;
export const logsKey = (planId: string) => ['logs', planId] as const;
export const dayKey = (planId: string, date: string) => ['day', planId, date] as const;

export function usePlans() {
  const api = useApi();
  return useQuery({ queryKey: plansKey, queryFn: ({ signal }) => api.listPlans(signal) });
}

/** The plan with its week pattern and day overrides. */
export function usePlan(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: planKey(planId ?? ''),
    queryFn: ({ signal }) => api.getPlan(planId!, signal),
    enabled: !!planId,
  });
}

export function useTasks(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: tasksKey(planId ?? ''),
    queryFn: ({ signal }) => api.listTasks(planId!, signal),
    enabled: !!planId,
    staleTime: SHARED_STALE_MS,
  });
}

export function useSchedule(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: scheduleKey(planId ?? ''),
    queryFn: ({ signal }) => api.getSchedule(planId!, signal),
    enabled: !!planId,
    staleTime: SHARED_STALE_MS,
  });
}

export function useProgress(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: progressKey(planId ?? ''),
    queryFn: ({ signal }) => api.getProgress(planId!, signal),
    enabled: !!planId,
    staleTime: SHARED_STALE_MS,
  });
}

/** The open tasks of the week (with the days they were carried over from). */
export function useOpenTasks(planId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: openTasksKey(planId ?? ''),
    queryFn: ({ signal }) => api.getOpenTasks(planId!, signal),
    enabled: !!planId,
  });
}

/** The time logs between two local dates, inclusive. */
export function useLogs(planId: string | undefined, from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...logsKey(planId ?? ''), from, to],
    queryFn: ({ signal }) => api.listLogs(planId!, from, to, signal),
    enabled: !!planId,
  });
}

/** Session state of one day (not started, started, ended) and its frozen blocks once frozen. */
export function useDay(planId: string | undefined, date: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: dayKey(planId ?? '', date ?? ''),
    queryFn: ({ signal }) => api.getDay(planId!, date!, signal),
    enabled: !!planId && !!date,
  });
}

/** Refreshes everything that depends on task hours, task status or the time settings. */
function useInvalidatePlanData() {
  const queryClient = useQueryClient();
  return (planId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: tasksKey(planId) }),
      queryClient.invalidateQueries({ queryKey: progressKey(planId) }),
      queryClient.invalidateQueries({ queryKey: scheduleKey(planId) }),
      queryClient.invalidateQueries({ queryKey: openTasksKey(planId) }),
      queryClient.invalidateQueries({ queryKey: logsKey(planId) }),
      queryClient.invalidateQueries({ queryKey: planKey(planId) }),
      queryClient.invalidateQueries({ queryKey: plansKey }),
    ]);
}

/** Imports a plan file. The caller supplies the client-generated id, which makes a retry safe. */
export function useImportPlan() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: (body: ImportBody) => api.importPlan(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: plansKey }),
  });
}

/**
 * Deletes a plan with its progress (the API also removes the calendar events the app created for
 * it). Once the plan list is fresh the open plan falls back to the first one left, or to the
 * empty state; the deleted plan's cached data is dropped.
 */
export function useDeletePlan(onDeleted?: (planId: string) => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: (planId: string) => api.deletePlan(planId).then(() => planId),
    onSuccess: async (planId) => {
      // Gone from the cached list at once, so a failed refetch cannot leave it on screen.
      queryClient.setQueryData<{ plans: { id: string }[] }>(plansKey, (old) =>
        old ? { ...old, plans: old.plans.filter((p) => p.id !== planId) } : old,
      );
      // A hook-level callback, so it still runs when the component that started the delete has
      // already left the screen (the plan it showed is gone).
      onDeleted?.(planId);
      await queryClient.invalidateQueries({ queryKey: plansKey });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'plans' && query.queryKey[1] === planId,
      });
    },
  });
}

export function useAddLog(planId: string) {
  const api = useApi();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: ({ taskId, log }: { taskId: string; log: LogRequest }) =>
      api.addLog(planId, taskId, log),
    onSuccess: () => void invalidate(planId),
  });
}

/** An explicit user action on one task. The app never calls these on its own. */
export function useTaskAction(planId: string, action: 'complete' | 'skip' | 'reopen') {
  const api = useApi();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: (taskId: string) =>
      action === 'complete'
        ? api.completeTask(planId, taskId)
        : action === 'skip'
          ? api.skipTask(planId, taskId)
          : api.reopenTask(planId, taskId),
    // Returned, so the action stays pending until the lists show the new status. A second click
    // in between would otherwise repeat the call on a button that is about to change.
    onSuccess: () => invalidate(planId),
  });
}

export function usePatchTask(planId: string) {
  const api = useApi();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: ({ taskId, patch }: { taskId: string; patch: TaskPatch }) =>
      api.patchTask(planId, taskId, patch),
    onSuccess: () => void invalidate(planId),
  });
}

/**
 * Deletes a task (an explicit user action). `onDeleted` is a hook-level callback so it still runs
 * when the component that started the delete is already gone (its task row disappears).
 */
export function useDeleteTask(planId: string, onDeleted?: (taskId: string) => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: ({ taskId, removeDependencies }: { taskId: string; removeDependencies: boolean }) =>
      api.deleteTask(planId, taskId, removeDependencies).then(() => taskId),
    onSuccess: async (taskId) => {
      onDeleted?.(taskId);
      queryClient.setQueryData<{ tasks: { id: string }[] }>(tasksKey(planId), (old) =>
        old ? { ...old, tasks: old.tasks.filter((t) => t.id !== taskId) } : old,
      );
      await invalidate(planId);
    },
  });
}

/** Computes what a time-settings change would do. Saves nothing. */
export function usePreviewSchedule(planId: string) {
  const api = useApi();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (request: PreviewRequest) => api.previewSchedule(planId, request),
  });
}

export interface TimeSettingsChange {
  pattern?: WeekPattern;
  upsertOverrides: DayOverride[];
  removeOverrideDates: string[];
}

/** Saves an approved time-settings change with the PUT endpoints, one after the other. */
export function useSaveTimeSettings(planId: string) {
  const api = useApi();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: async (change: TimeSettingsChange) => {
      if (change.pattern) await api.putWeekPattern(planId, change.pattern);
      for (const { date, ...rest } of change.upsertOverrides) {
        await api.putDayOverride(planId, date, rest);
      }
      for (const date of change.removeOverrideDates) await api.deleteDayOverride(planId, date);
    },
    // Even a half-finished save changes the plan, so refresh on failure too.
    onSettled: () => invalidate(planId),
  });
}

/** Moves the plan's start date (an explicit user action); the schedule then starts from it. */
export function useSaveStartDate(planId: string) {
  const api = useApi();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: (startDate: string) => api.putStartDate(planId, startDate),
    onSuccess: () => invalidate(planId),
  });
}

/**
 * Starts a study day. The API call is idempotent (a repeat answers 200 with the same state), so a
 * retry after a lost answer is safe. The returned state replaces the cached day.
 */
export function useStartDay(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    ...mutationDefaults,
    mutationFn: (date: string) => api.startDay(planId, date),
    onSuccess: (day) => queryClient.setQueryData(dayKey(planId, day.date), day),
  });
}

/**
 * Ends a study day: the API freezes its blocks and unfinished work moves to the next study day,
 * so the schedule, the open tasks and the day itself are refreshed. Idempotent like start.
 */
export function useEndDay(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePlanData();
  return useMutation({
    ...planChangeDefaults,
    mutationFn: (date: string) => api.endDay(planId, date),
    onSuccess: (day) => {
      queryClient.setQueryData(dayKey(planId, day.date), day);
      void invalidate(planId);
    },
  });
}
