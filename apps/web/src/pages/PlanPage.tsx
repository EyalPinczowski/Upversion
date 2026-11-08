import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useDeletePlan } from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, ErrorText, linkClass } from '../components/ui';
import { isConnectionProblem } from '../lib/messages';
import { Curriculum } from '../plan/Curriculum';
import { ImportPlan } from '../plan/ImportPlan';
import { PlanTabs } from '../plan/PlanTabs';
import { SubjectsList } from '../plan/SubjectsList';
import { PracticeSettings } from './settings/PracticeSettings';
import { TimeSettings } from './settings/TimeSettings';
import { useActivePlan } from '../plan/context';
import { PlanGate, PlanSwitcher } from '../plan/PlanGate';

/** The plan: its curriculum, and the settings that belong to it. */
export function PlanPage() {
  // Confirming a delete resets the notice and the hook callback sets it after the delete, so each
  // delete announces and focuses again.
  const [deleted, setDeleted] = useState(false);
  // How many tasks were deleted: the task page sends the person here with `taskDeleted` in the
  // router state. Counted, so a second delete focuses the heading again.
  const location = useLocation();
  const navigate = useNavigate();
  const arrivedAfterDelete = (location.state as { taskDeleted?: boolean } | null)?.taskDeleted;
  const [tasksDeleted, setTasksDeleted] = useState(arrivedAfterDelete ? 1 : 0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'settings' ? 'settings' : 'curriculum';
  // Curriculum is the default and keeps a clean URL; the other tab is `?tab=settings`.
  const changeTab = (id: string) =>
    setParams(id === 'settings' ? { tab: 'settings' } : {}, { replace: true });
  // Old links such as `/settings#time-heading` arrive with a hash. The sections render after the
  // plan loads, so wait for the target heading, then scroll to it and move focus there.
  const { hash } = location;
  useEffect(() => {
    if (tab !== 'settings' || hash.length < 2) return;
    const id = decodeURIComponent(hash.slice(1));
    const reveal = () => {
      const target = document.getElementById(id);
      if (!target) return false;
      target.tabIndex = -1;
      target.scrollIntoView();
      target.focus({ preventScroll: true });
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [tab, hash]);
  // The deleted plan's or task's button is gone: focus moves to the page heading, which stays.
  useEffect(() => {
    // After the shell's own focus move to the page content on a route change (same commit).
    if (deleted || tasksDeleted > 0) queueMicrotask(() => heading.current?.focus());
  }, [deleted, tasksDeleted]);
  // The notice is shown once: a reload must not bring it back.
  useEffect(() => {
    if (arrivedAfterDelete) void navigate(location.pathname, { replace: true, state: null });
  }, [arrivedAfterDelete, location.pathname, navigate]);
  // The mutation lives here, not in the part that disappears with the deleted plan.
  const remove = useDeletePlan(() => setDeleted(true));
  // An old delete error must not come back when the person returns to that plan.
  const { plan: active } = useActivePlan();
  const { reset } = remove;
  const activeId = active?.id;
  useEffect(() => {
    reset();
  }, [activeId, reset]);
  return (
    <div className="space-y-6">
      <h1 ref={heading} tabIndex={-1}>
        Plan
      </h1>
      <div role="status" className="font-bold text-ok empty:hidden">
        {deleted ? 'Plan deleted.' : tasksDeleted > 0 ? 'Task deleted.' : null}
      </div>
      <PlanSwitcher />
      <PlanGate
        empty={
          <p className="text-muted">
            No plan yet. Import one from{' '}
            <Link to="/" className={linkClass}>
              Today
            </Link>
            .
          </p>
        }
      >
        {(plan) => (
          <>
            <h2>{plan.name}</h2>
            <PlanTabs
              tabs={[
                { id: 'curriculum', label: 'Curriculum', tour: 'plan-curriculum' },
                { id: 'settings', label: 'Plan settings', tour: 'plan-settings' },
              ]}
              active={tab}
              onChange={changeTab}
            >
              {(id) =>
                id === 'curriculum' ? (
                  <Curriculum
                    planId={plan.id}
                    onTaskDeleted={() => {
                      setDeleted(false);
                      setTasksDeleted((n) => n + 1);
                    }}
                  />
                ) : (
                  <>
                    <TimeSettings />
                    <PracticeSettings />
                    <SubjectsList planId={plan.id} />
                    <ManagePlans
                      key={plan.id}
                      planId={plan.id}
                      name={plan.name}
                      remove={remove}
                      onDeleteStart={() => setDeleted(false)}
                    />
                  </>
                )
              }
            </PlanTabs>
          </>
        )}
      </PlanGate>
    </div>
  );
}

function ManagePlans({
  planId,
  name,
  remove,
  onDeleteStart,
}: {
  planId: string;
  name: string;
  remove: ReturnType<typeof useDeletePlan>;
  onDeleteStart: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section aria-labelledby="manage-heading" className="space-y-4 border-t border-border pt-6">
      <h3 id="manage-heading">Manage plans</h3>
      <div className="space-y-2">
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete this plan
        </Button>
        {remove.error && remove.variables === planId ? (
          <ErrorText>
            {isConnectionProblem(remove.error)
              ? 'Can’t reach the server. The plan may or may not have been deleted. Check your plan list or try again.'
              : 'The plan could not be deleted. Nothing was changed. Try again in a moment.'}
          </ErrorText>
        ) : null}
      </div>
      <details className="rounded-sm border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 font-bold">
          Import another plan
        </summary>
        <div className="px-3 pb-3 pt-2">
          <ImportPlan />
        </div>
      </details>
      {confirming ? (
        <ConfirmDialog
          title={`Delete “${name}”?`}
          confirmLabel={remove.isPending ? 'Deleting…' : 'Delete plan'}
          cancelLabel="Keep this plan"
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            onDeleteStart();
            remove.mutate(planId, { onSettled: () => setConfirming(false) });
          }}
        >
          <p>
            Your progress and the calendar events Upversion created for this plan are removed. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
