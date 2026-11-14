import type { UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { PlanSummary } from '../api/client';

export interface ActivePlanValue {
  /** The plan list request: pages show loading and error states from it. */
  query: UseQueryResult<{ plans: PlanSummary[] }>;
  plans: PlanSummary[];
  /** The chosen plan, or else the newest active plan, or the newest plan; undefined while loading or when there is none. */
  plan: PlanSummary | undefined;
  select: (planId: string) => void;
}

export const ActivePlanContext = createContext<ActivePlanValue | null>(null);

export function useActivePlan(): ActivePlanValue {
  const value = useContext(ActivePlanContext);
  if (!value) throw new Error('useActivePlan must be used inside <ActivePlanProvider>');
  return value;
}

/**
 * True when the open plan is archived: it can be read but not changed (ADR 017 section 4.1).
 * Outside an `ActivePlanProvider` it is false, so a component can be used on its own.
 */
export function useReadOnlyPlan(): boolean {
  const value = useContext(ActivePlanContext);
  return value?.plan?.status === 'archived';
}
