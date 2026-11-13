import type { ReactNode } from 'react';
import type { PlanSummary } from '../api/client';
import { QueryView } from '../components/QueryView';
import { LockIcon } from '../components/icons';
import { useActivePlan } from './context';
import { RestorePlan } from './RestorePlan';

/**
 * The note above every page of an archived plan: it can be read, not changed (ADR 017 section
 * 4.1). The words carry the meaning; the lock icon is only a companion.
 */
export function ArchivedBanner({ plan }: { plan: PlanSummary }) {
  if (plan.status !== 'archived') return null;
  return (
    <section
      aria-label="Archived plan"
      className="space-y-3 rounded-md border-2 border-border bg-surface-2 p-4"
    >
      <p className="flex items-start gap-2 font-bold">
        <LockIcon />
        <span>This plan is archived (read-only). You can look at it, but not change it.</span>
      </p>
      <RestorePlan key={plan.id} plan={plan} />
    </section>
  );
}

/** Waits for the plan list, then renders `children` for the open plan or `empty` when there is none. */
export function PlanGate({
  empty,
  children,
  banner = true,
}: {
  empty: ReactNode;
  children: (plan: PlanSummary) => ReactNode;
  /** Show the archived-plan note above `children` (default). Parts of a page that sit under one pass false. */
  banner?: boolean;
}) {
  const { query, plan } = useActivePlan();
  return (
    <QueryView query={query} label="Loading your plan…">
      {() =>
        plan ? (
          <>
            {banner ? <ArchivedBanner plan={plan} /> : null}
            {children(plan)}
          </>
        ) : (
          empty
        )
      }
    </QueryView>
  );
}

/** A plain select, shown only when there is more than one plan. */
export function PlanSwitcher() {
  const { plans, plan, select } = useActivePlan();
  if (plans.length < 2 || !plan) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="plan-switcher" className="font-bold">
        Plan
      </label>
      <select
        id="plan-switcher"
        value={plan.id}
        onChange={(event) => select(event.target.value)}
        className="min-h-11 min-w-0 max-w-full rounded-sm border border-border bg-surface px-3 py-2 text-text"
      >
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.status === 'archived' ? `${p.name} (Archived)` : p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
