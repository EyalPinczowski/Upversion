import { useRef, useState } from 'react';
import type { PlanSummary } from '../api/client';
import { isApiError } from '../api/errors';
import { useRestorePlan, usePlanBuilderEnabled } from '../api/plan-builder-hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, ErrorText } from '../components/ui';
import { useActivePlan } from './context';
import { describeRestoreError } from './restore-error';

/**
 * "Restore this plan" for an archived plan: a confirm dialog that names the plan(s) that will be
 * archived (the plans that are active now), then `POST /plans/{id}/restore` with exactly those ids.
 * Shown only while the server has the plan builder on (the restore route is behind the same flag).
 */
export function RestorePlan({ plan }: { plan: PlanSummary }) {
  const enabled = usePlanBuilderEnabled();
  const { plans, select, query } = useActivePlan();
  const restore = useRestorePlan();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const active = plans.filter((p) => p.status === 'active');
  const { refetch } = query;

  if (!enabled || plan.status !== 'archived') return null;

  function onConfirm() {
    restore.mutate(
      { planId: plan.id, body: { replacesPlanIds: active.map((p) => p.id) } },
      {
        onSuccess: () => {
          setConfirming(false);
          setProblem(null);
          select(plan.id);
        },
        onError: (error) => {
          setProblem(describeRestoreError(error));
          // Re-read the plans: the dialog then names the right ones (or closes when nothing is left to do).
          void refetch();
          if (isApiError(error) && error.code !== 'active_plan_changed') setConfirming(false);
        },
      },
    );
  }

  return (
    <div className="space-y-2">
      <Button
        ref={opener}
        variant="primary"
        onClick={() => {
          setProblem(null);
          restore.reset();
          setConfirming(true);
        }}
      >
        Restore this plan
      </Button>
      {problem && !confirming ? <ErrorText>{problem}</ErrorText> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Restore “${plan.name}”?`}
          confirmLabel={restore.isPending ? 'Restoring…' : 'Restore it'}
          cancelLabel="Cancel"
          busy={restore.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirm}
        >
          {active.length > 0 ? (
            <p>
              {active.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? (i === active.length - 1 ? ' and ' : ', ') : ''}
                  <strong>{p.name}</strong>
                </span>
              ))}{' '}
              will be archived and <strong>{plan.name}</strong> becomes your plan again. Tasks are
              rescheduled from today.
            </p>
          ) : (
            <p>
              <strong>{plan.name}</strong> becomes your plan again. Tasks are rescheduled from
              today.
            </p>
          )}
          {problem ? <ErrorText>{problem}</ErrorText> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
