import { useState } from 'react';
import { isApiError } from '../api/errors';
import type { Task } from '../api/client';
import { useDeleteTask } from '../api/hooks';
import { describeError } from '../lib/messages';
import { useReadOnlyPlan } from '../plan/context';
import { ConfirmDialog } from './ConfirmDialog';
import { Button, ErrorText } from './ui';

type Dependent = { id: string; title: string };

/**
 * "Delete task" with its confirmation. If other tasks depend on this one the API answers 409 and
 * the dialog lists them and offers to remove the dependency as part of the delete; nothing is
 * deleted before the person says so. `onDeleted` runs once the task is gone.
 */
export function DeleteTask({
  planId,
  task,
  onDeleted,
  className,
}: {
  planId: string;
  task: Pick<Task, 'id' | 'title'>;
  onDeleted: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dependents, setDependents] = useState<readonly Dependent[] | null>(null);
  const remove = useDeleteTask(planId, onDeleted);
  // An archived plan is read-only: a task cannot be deleted from it.
  const readOnly = useReadOnlyPlan();

  function close() {
    setOpen(false);
    setDependents(null);
    remove.reset();
  }

  function confirm() {
    remove.mutate(
      { taskId: task.id, removeDependencies: dependents !== null },
      {
        onError: (error) => {
          if (isApiError(error) && error.status === 409 && error.code === 'has_dependents') {
            setDependents(error.dependents ?? []);
          }
        },
      },
    );
  }

  if (readOnly) return null;
  const blocked = dependents !== null;
  const failure =
    remove.error && !(isApiError(remove.error) && remove.error.code === 'has_dependents')
      ? describeError(remove.error, 'The task could not be deleted. Nothing was changed.')
      : null;

  return (
    <>
      <Button
        variant="danger"
        className={className}
        aria-label={`Delete task: ${task.title}`}
        onClick={() => setOpen(true)}
      >
        Delete task
      </Button>
      {open ? (
        <ConfirmDialog
          title={`Delete “${task.title}”?`}
          confirmLabel={
            remove.isPending
              ? 'Deleting…'
              : blocked
                ? 'Delete and remove the dependency'
                : 'Delete task'
          }
          cancelLabel="Keep this task"
          busy={remove.isPending}
          onCancel={close}
          onConfirm={confirm}
        >
          {blocked ? (
            <>
              <p>These tasks come after this one:</p>
              <ul className="list-disc space-y-1 pl-6">
                {dependents.map((d) => (
                  <li key={d.id}>{d.title}</li>
                ))}
              </ul>
              <p>
                Deleting it also removes it from their “after” list, so they no longer wait for it.
              </p>
            </>
          ) : (
            <p>
              The time you logged on this task and its practice sessions are deleted too, and the
              schedule is recalculated. This cannot be undone.
            </p>
          )}
          {failure ? <ErrorText>{failure}</ErrorText> : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
