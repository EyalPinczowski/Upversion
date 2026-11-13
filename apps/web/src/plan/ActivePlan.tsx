import { useCallback, useMemo, useState } from 'react';
import { Outlet } from 'react-router';
import type { PlanSummary } from '../api/client';
import { usePlans } from '../api/hooks';
import { ActivePlanContext } from './context';

// Intentional leftover: this key keeps the old product name (Skillstack) so existing devices keep
// their selected plan. Do not rename without a migration.
const STORAGE_KEY = 'skillstack.plan';

// Browser storage is only a per-device convenience; it can be blocked or empty.
function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(planId: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, planId);
  } catch {
    // Not remembering the choice is fine.
  }
}

/** The newest plan (by creation time; the first in the list on a tie), optionally of one status. */
function newest(plans: PlanSummary[], status?: PlanSummary['status']): PlanSummary | undefined {
  let best: PlanSummary | undefined;
  for (const p of plans) {
    if (status && p.status !== status) continue;
    if (!best || p.createdAt > best.createdAt) best = p;
  }
  return best;
}

/** Loads the person's plans once and tells every page which one is open (v0.1: no more than a select). */
export function ActivePlanProvider() {
  const query = usePlans();
  const [chosen, setChosen] = useState<string | null>(readStored);
  const plans = useMemo(() => query.data?.plans ?? [], [query.data]);
  // The stored choice wins; without one the newest ACTIVE plan, then the newest plan of any status.
  const plan = plans.find((p) => p.id === chosen) ?? newest(plans, 'active') ?? newest(plans);

  const select = useCallback((planId: string) => {
    setChosen(planId);
    writeStored(planId);
  }, []);

  const value = useMemo(() => ({ query, plans, plan, select }), [query, plans, plan, select]);
  return (
    <ActivePlanContext value={value}>
      <Outlet />
    </ActivePlanContext>
  );
}
