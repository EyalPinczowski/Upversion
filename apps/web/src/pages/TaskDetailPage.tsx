import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Task, TaskPatch } from '../api/client';
import { usePatchTask, useSchedule, useTaskAction, useTasks } from '../api/hooks';
import { DeleteTask } from '../components/DeleteTask';
import { QueryView } from '../components/QueryView';
import { TaskStatusLabel, TaskTypeChip } from '../components/TaskChips';
import { Button, ErrorText, linkClass, TextAreaField, TextField } from '../components/ui';
import { formatHours } from '../lib/format';
import { safeWebUrl } from '../lib/links';
import { describeError } from '../lib/messages';
import { anchorText, dependencyText } from '../lib/task-text';
import { useReadOnlyPlan } from '../plan/context';
import { PlanGate } from '../plan/PlanGate';
import { LogTimeForm } from './today/LogTimeForm';
import { TaskActions } from './today/TaskActions';

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children} <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function EditForm({ planId, task }: { planId: string; task: Task }) {
  const patch = usePatchTask(planId);
  const [title, setTitle] = useState(task.title);
  const [hours, setHours] = useState(String(task.estHours));
  const [notes, setNotes] = useState(task.notes ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const body: TaskPatch = {};
    if (title.trim() !== task.title) body.title = title.trim();
    const est = Number(hours);
    if (hours.trim() === '' || !Number.isFinite(est) || est <= 0 || est > 500) {
      setFieldError('Enter the estimate as a number above 0 and up to 500 hours.');
      return;
    }
    setFieldError(null);
    if (est !== task.estHours) body.estHours = est;
    const trimmedNotes = notes.trim();
    if (trimmedNotes !== (task.notes ?? '')) body.notes = trimmedNotes === '' ? null : trimmedNotes;
    if (Object.keys(body).length === 0) {
      setFieldError('Nothing has changed yet.');
      return;
    }
    patch.mutate({ taskId: task.id, patch: body }, { onSuccess: () => setSaved(true) });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3" aria-labelledby="edit-heading">
      <h2 id="edit-heading">Edit task</h2>
      <TextField
        label="Title"
        value={title}
        maxLength={300}
        onChange={(event) => setTitle(event.target.value)}
      />
      <TextField
        label="Estimated hours"
        type="number"
        inputMode="decimal"
        step="0.25"
        min="0"
        max="500"
        value={hours}
        onChange={(event) => setHours(event.target.value)}
        error={fieldError}
        className="max-w-40"
      />
      <TextAreaField
        label="Notes"
        rows={4}
        maxLength={10000}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
      {patch.isError ? (
        <ErrorText>{describeError(patch.error, 'The changes could not be saved.')}</ErrorText>
      ) : null}
      <div aria-live="polite">{saved ? <p className="font-bold text-ok">Saved.</p> : null}</div>
      <Button type="submit" variant="primary" disabled={patch.isPending}>
        {patch.isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  );
}

/**
 * The explicit actions on this task, by status. Always available while the task is open, so
 * finishing or skipping it never depends on a prompt or on a block today.
 */
function TaskPageActions({ planId, task }: { planId: string; task: Task }) {
  const schedule = useSchedule(planId);
  const complete = useTaskAction(planId, 'complete');
  const skip = useTaskAction(planId, 'skip');
  const reopen = useTaskAction(planId, 'reopen');
  const [logging, setLogging] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // The pressed button is replaced after the action, so focus moves to the result message.
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const busy = complete.isPending || skip.isPending || reopen.isPending;
  const today = schedule.data?.today;
  const remaining = task.estHours - task.doneHours;

  function act(mutation: typeof complete, success: string, failure: string) {
    if (busy) return;
    setNotice(null);
    mutation.mutate(task.id, {
      onSuccess: () => setNotice({ tone: 'ok', text: success }),
      onError: (error) => setNotice({ tone: 'error', text: describeError(error, failure) }),
    });
  }

  return (
    <div className="space-y-3">
      <TaskActions
        task={task}
        busy={busy}
        // Logging needs today's date from the schedule; marking done or skipping does not.
        logging={logging || !today}
        onLog={() => setLogging(true)}
        onDone={() =>
          act(complete, `Marked ${task.title} as done.`, 'Could not mark the task as done.')
        }
        onSkip={() => act(skip, `Skipped ${task.title}.`, 'Could not skip the task.')}
        onReopen={() => act(reopen, `Reopened ${task.title}.`, 'Could not reopen the task.')}
      />
      <div ref={noticeRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {notice?.tone === 'ok' ? <p className="font-bold text-ok">{notice.text}</p> : null}
        {notice?.tone === 'error' ? <ErrorText>{notice.text}</ErrorText> : null}
      </div>
      {logging && today ? (
        <LogTimeForm
          planId={planId}
          task={task}
          date={today}
          defaultHours={remaining > 0 ? remaining : 1}
          onLogged={(result) => {
            setLogging(false);
            setNotice({
              tone: 'ok',
              text: `Logged ${formatHours(result.log.hours)} on ${task.title}. ${formatHours(result.task.doneHours)} of ${formatHours(result.task.estHours)} done.`,
            });
          }}
          onCancel={() => setLogging(false)}
        />
      ) : null}
    </div>
  );
}

function Detail({
  planId,
  task,
  titleOf,
}: {
  planId: string;
  task: Task;
  titleOf: (id: string) => string;
}) {
  const navigate = useNavigate();
  const readOnly = useReadOnlyPlan();
  // The delete can finish after the person has left this page: then they stay where they went.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const link = safeWebUrl(task.url);
  const deps = dependencyText(task, titleOf);
  const anchor = anchorText(task);
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1>{task.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TaskTypeChip type={task.type} />
          <TaskStatusLabel status={task.status} />
          <span className="text-muted tabular-nums">
            {formatHours(task.doneHours)} of {formatHours(task.estHours)}
          </span>
        </div>
        {task.provider ? <p className="text-muted">{task.provider}</p> : null}
        {anchor ? <p className="font-bold">{anchor}</p> : null}
        {deps ? <p className="text-muted">{deps}</p> : null}
        {task.isCertificate ? (
          <p>Earns a certificate{task.certificateName ? `: ${task.certificateName}` : ''}.</p>
        ) : null}
        {link ? (
          <p>
            <ExternalLink href={link}>Open the course page</ExternalLink>
          </p>
        ) : null}
      </div>

      <TaskPageActions planId={planId} task={task} />

      {task.howToSteps.length ? (
        <section aria-labelledby="steps-heading" className="space-y-2">
          <h2 id="steps-heading">How to do it</h2>
          <ol className="list-decimal space-y-1 pl-6">
            {task.howToSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {task.lessons.length ? (
        <section aria-labelledby="lessons-heading" className="space-y-2">
          <h2 id="lessons-heading">Lessons</h2>
          <ul className="space-y-2">
            {task.lessons.map((lesson, index) => {
              const href = safeWebUrl(lesson.url);
              return (
                <li key={index} className="space-y-0.5">
                  {href ? (
                    <ExternalLink href={href}>{lesson.title}</ExternalLink>
                  ) : (
                    <span className="font-bold">{lesson.title}</span>
                  )}
                  {lesson.estMinutes ? (
                    <span className="text-muted"> · {lesson.estMinutes} min</span>
                  ) : null}
                  {lesson.needsCheck ? (
                    <span className="block text-muted">
                      Needs check: confirm this link on the provider’s own site.
                    </span>
                  ) : null}
                  {lesson.summary ? (
                    <span className="block text-muted">{lesson.summary}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {task.notes ? (
        <section aria-labelledby="notes-heading" className="space-y-2">
          <h2 id="notes-heading">Notes</h2>
          <p className="whitespace-pre-wrap">{task.notes}</p>
        </section>
      ) : null}

      {readOnly ? null : <EditForm planId={planId} task={task} />}

      <section
        aria-labelledby="delete-heading"
        hidden={readOnly}
        className="space-y-2 border-t border-border pt-6"
      >
        <h2 id="delete-heading">Delete this task</h2>
        <p className="text-muted">Removes it from the plan and recalculates the schedule.</p>
        <DeleteTask
          planId={planId}
          task={task}
          onDeleted={() => {
            if (mounted.current) void navigate('/plan', { state: { taskDeleted: true } });
          }}
        />
      </section>
    </div>
  );
}

/** One task: how to do it, its links, notes and lessons, and the fields the person may edit. */
export function TaskDetailPage() {
  const { taskId } = useParams();
  return (
    <div className="space-y-6">
      <p>
        <Link to="/plan" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to the plan
        </Link>
      </p>
      <PlanGate empty={<p className="text-muted">No plan yet.</p>}>
        {(plan) => <Loaded planId={plan.id} taskId={taskId ?? ''} />}
      </PlanGate>
    </div>
  );
}

function Loaded({ planId, taskId }: { planId: string; taskId: string }) {
  const tasks = useTasks(planId);
  return (
    <QueryView query={tasks} label="Loading the task…">
      {({ tasks: list }) => {
        const task = list.find((t) => t.id === taskId);
        if (!task) return <p role="alert">This task is not in the plan.</p>;
        const titleOf = (id: string) => list.find((t) => t.id === id)?.title ?? id;
        return <Detail planId={planId} task={task} titleOf={titleOf} />;
      }}
    </QueryView>
  );
}
