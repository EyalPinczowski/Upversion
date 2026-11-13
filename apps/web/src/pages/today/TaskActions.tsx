import type { Task } from '../../api/client';
import { Button } from '../../components/ui';
import { useReadOnlyPlan } from '../../plan/context';

/**
 * The explicit actions the person may choose on a task, by its status: log time, mark done or
 * skip while it is open; reopen once it is done or skipped. Nothing here runs on its own.
 */
export function TaskActions({
  task,
  busy,
  logging,
  onLog,
  onDone,
  onSkip,
  onReopen,
}: {
  task: Pick<Task, 'title' | 'status'>;
  /** True while a mark-done, skip or reopen for this task is running. */
  busy: boolean;
  /** True while the log form is open. */
  logging: boolean;
  onLog: () => void;
  onDone: () => void;
  onSkip: () => void;
  onReopen: () => void;
}) {
  // An archived plan is read-only: no log, done, skip or reopen (the banner says why).
  const readOnly = useReadOnlyPlan();
  if (readOnly) return null;
  // A finished or skipped task can only be reopened, never logged against.
  const closed = task.status === 'done' || task.status === 'skipped';
  return (
    <div className="flex flex-wrap gap-3">
      {closed ? (
        <Button onClick={onReopen} disabled={busy}>
          Reopen<span className="sr-only">: {task.title}</span>
        </Button>
      ) : (
        <>
          <Button variant="primary" onClick={onLog} disabled={logging || busy}>
            Log time<span className="sr-only">: {task.title}</span>
          </Button>
          <Button onClick={onDone} disabled={busy}>
            Mark done<span className="sr-only">: {task.title}</span>
          </Button>
          <Button onClick={onSkip} disabled={busy}>
            Skip<span className="sr-only">: {task.title}</span>
          </Button>
        </>
      )}
    </div>
  );
}
