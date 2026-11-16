import { useEffect, useRef, useState } from 'react';
import type { BuildRequestBody } from '../../api/client';
import { isApiError } from '../../api/errors';
import { useBuildPlan } from '../../api/plan-builder-hooks';
import { Button, ErrorText } from '../../components/ui';
import { newId } from '../../lib/messages';
import type { useActivePlan } from '../../plan/context';
import { ArchiveDialog } from '../../plan/ArchiveDialog';
import { describeBuildError } from './builder-model';

/**
 * "Start this plan": creates the plan from the draft. One id per draft, the archive confirm when a
 * plan is active (ADR 017 section 4.1) and the recovery rules for lost answers. Shared by the
 * builder page and the first run (ADR 018).
 */
export function StartPlan({
  request,
  draftHash,
  canStart,
  plans,
  plansLoading,
  refetchPlans,
  refreshDraft,
  onStarted,
}: {
  request: BuildRequestBody | null;
  draftHash: string | null;
  canStart: boolean;
  plans: ReturnType<typeof useActivePlan>['plans'];
  plansLoading: boolean;
  refetchPlans: () => Promise<ReturnType<typeof useActivePlan>['plans'] | null>;
  refreshDraft: () => void;
  onStarted: (planId: string) => void;
}) {
  const build = useBuildPlan();
  const [dialog, setDialog] = useState<{ notice: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // One id per draft: repeating the request after a lost answer is safe (the server answers with
  // the stored plan). The key is the request and the draft hash only, like the server's own hash of
  // the body: the list of plans to archive is not part of it, because it can change between the two
  // tries (the lost first try may already have archived them).
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const active = plans.filter((p) => p.status === 'active');

  useEffect(() => {
    if (problem) statusRef.current?.focus();
  }, [problem]);

  function submit(replacesPlanIds: string[]) {
    if (!request || !draftHash) return;
    const key = JSON.stringify({ request, draftHash });
    if (attempt.current?.key !== key) attempt.current = { key, id: newId() };
    const id = attempt.current.id;
    setProblem(null);
    build.mutate(
      { id, request, draftHash, replacesPlanIds },
      {
        onSuccess: (plan) => {
          setDialog(null);
          attempt.current = null;
          onStarted(plan.id);
        },
        onError: (error) => void onFailed(error, id),
      },
    );
  }

  async function onFailed(error: unknown, id: string) {
    if (isApiError(error) && error.kind === 'http' && error.status === 409) {
      if (error.code === 'active_plan_changed') {
        const fresh = await refetchPlans();
        const now = (fresh ?? []).filter((p) => p.status === 'active');
        if (now.length > 0) {
          setDialog({
            notice:
              'Your active plans changed in the meantime. Check the names below and confirm again.',
          });
        } else {
          setDialog(null);
          setProblem('Your plans changed in the meantime. Press Start this plan again.');
        }
        return;
      }
      setDialog(null);
      if (error.code === 'draft_changed') {
        setProblem(
          'The catalog or your choices changed since this draft was made. The draft has been refreshed. Check it, then press Start this plan again.',
        );
        refreshDraft();
        return;
      }
      if (error.code === 'conflict') {
        setProblem(
          'A plan with this id was already started with different choices. Go back, check your choices and start again.',
        );
        attempt.current = null;
        return;
      }
    }
    setDialog(null);
    if (isApiError(error) && error.kind !== 'http') {
      // The answer may have been lost after the plan was created: look at the plan list. If the plan
      // with this id is there, it was created, and that is the end of it (no second try, no dialog
      // about archiving the plan that was just made).
      const fresh = await refetchPlans();
      if (fresh?.some((p) => p.id === id)) {
        attempt.current = null;
        setProblem(null);
        onStarted(id);
        return;
      }
    }
    setProblem(
      isApiError(error) && error.kind !== 'http'
        ? 'Can’t reach the server. If your plan was created it will show in your plan list. Press Start this plan again to retry; it will not be created twice.'
        : describeBuildError(error),
    );
  }

  const busy = build.isPending;
  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        disabled={!canStart || plansLoading || busy}
        onClick={() => (active.length > 0 ? setDialog({ notice: null }) : submit([]))}
      >
        {busy && !dialog ? 'Starting…' : 'Start this plan'}
      </Button>
      <div ref={statusRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </div>
      {dialog ? (
        <ArchiveDialog
          plans={active}
          notice={dialog.notice}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => submit(active.map((p) => p.id))}
        />
      ) : null}
    </div>
  );
}
