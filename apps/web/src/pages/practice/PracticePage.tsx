import { MAX_LOG_HOURS } from '@upversion/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { Task } from '../../api/client';
import { isAiUnavailable, isApiError } from '../../api/errors';
import { useQueryClient } from '@tanstack/react-query';
import { useAiUsage } from '../../api/ai-hooks';
import { useTasks } from '../../api/hooks';
import {
  useAbandonSession,
  useFinishSession,
  usePasteFeedback,
  usePracticePrompt,
  usePracticeSession,
  useStartSession,
  type FinishedSession,
  type PracticeChannel,
  type SessionDetail,
} from '../../api/practice-hooks';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { QueryView } from '../../components/QueryView';
import { TaskTypeChip } from '../../components/TaskChips';
import { Button, ErrorText, linkClass } from '../../components/ui';
import { describeError, newId } from '../../lib/messages';
import { useReadOnlyPlan } from '../../plan/context';
import { PlanGate } from '../../plan/PlanGate';
import { isSessionId, readStoredSession, writeStoredSession } from './session-store';
import { formatMinutes } from '../briefing/day-utils';
import { aiDownReason, type AiDown } from './ai-state';
import { AiUnavailableNotice, ChatPanel, RATE_LIMITED_TEXT } from './ChatPanel';
import { FinishDialog, type FinishChoice, type FinishDecision } from './FinishDialog';
import { FinishedSummary } from './FinishedSummary';
import { JobDescriptionField } from './JobDescriptionField';
import { PasteFeedback } from './PasteFeedback';
import { PromptPanel } from './PromptPanel';
import { rubricSteps } from './practice-utils';
import { RubricPanel } from './RubricPanel';
import { Timer } from './Timer';

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-border bg-surface p-4">{children}</div>;
}

const IN_APP_CHANNEL = {
  value: 'in_app',
  label: 'Chat with the in-app assistant',
  hint: 'Practise here in a chat. Uses a daily allowance of AI calls; AI answers can be wrong.',
} as const;

const CHANNELS: { value: PracticeChannel; label: string; hint: string }[] = [
  {
    value: 'external',
    label: 'Use Claude or another assistant',
    hint: 'Copy a ready-made prompt, practise there, then paste the feedback back.',
  },
  {
    value: 'self',
    label: 'Practise on my own',
    hint: 'No assistant. Score yourself with a checklist when you are done.',
  },
];

function StartPanel({
  planId,
  task,
  notice,
  onStarted,
}: {
  planId: string;
  task: Task;
  notice: string | null;
  onStarted: (sessionId: string) => void;
}) {
  const readOnly = useReadOnlyPlan();
  const start = useStartSession(planId, task.id);
  const queryClient = useQueryClient();
  const usage = useAiUsage();
  const options = usage.data?.configured ? [IN_APP_CHANNEL, ...CHANNELS] : CHANNELS;
  const [chosen, setChannel] = useState<PracticeChannel>('external');
  const channel = options.some((o) => o.value === chosen) ? chosen : 'external';
  // One id per attempt: repeating a start that got no answer is safe and creates one session.
  const attempt = useRef<{ id: string; channel: PracticeChannel } | null>(null);

  function begin() {
    if (!attempt.current || attempt.current.channel !== channel) {
      attempt.current = { id: newId(), channel };
    }
    start.mutate(attempt.current, {
      onSuccess: (detail) => {
        attempt.current = null;
        onStarted(detail.session.id);
      },
      onError: (error) => {
        if (isAiUnavailable(error)) {
          // Back to a way that needs no AI, and look at the allowance again.
          setChannel('external');
          attempt.current = null;
          void queryClient.invalidateQueries({ queryKey: ['ai-usage'] });
        }
        // The task already has a running session: the API names it, so carry on with that one.
        // Without a usable id the error stays on screen: the button is never a dead end.
        if (
          isApiError(error) &&
          error.code === 'practice_session_active' &&
          isSessionId(error.sessionId)
        ) {
          onStarted(error.sessionId);
        }
      },
    });
  }

  const planned = Math.round(task.estHours * 60);
  if (readOnly) {
    return (
      <Panel>
        <p className="font-bold">
          This plan is archived (read-only), so a new practice can’t be started. Restore the plan to
          practise.
        </p>
      </Panel>
    );
  }
  return (
    <div className="space-y-4">
      {notice ? <p className="text-muted">{notice}</p> : null}
      <Panel>
        <div className="space-y-3">
          <h2>Start practice</h2>
          <p className="text-muted">
            Planned time: {formatMinutes(planned)}. The timer starts now.
          </p>
          <fieldset className="space-y-1">
            <legend className="font-bold">How do you want to practise?</legend>
            {options.map((option) => (
              <label key={option.value} className="flex min-h-11 items-start gap-3 py-1">
                <input
                  type="radio"
                  name="channel"
                  checked={channel === option.value}
                  onChange={() => setChannel(option.value)}
                  className="mt-0.5 size-6"
                />
                <span>
                  <span className="block font-bold">{option.label}</span>
                  <span className="block text-muted">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button variant="primary" disabled={start.isPending} onClick={begin}>
            {start.isPending ? 'Starting…' : 'Start practice'}
          </Button>
          {start.isError && isAiUnavailable(start.error) ? (
            <AiUnavailableNotice
              reason={aiDownReason(start.error) ?? 'unavailable'}
              where="start"
            />
          ) : start.isError ? (
            <ErrorText>
              {describeError(start.error, 'The practice could not be started.')}
            </ErrorText>
          ) : null}
        </div>
      </Panel>
      {channel === 'external' ? (
        <Panel>
          <div className="space-y-3">
            <h2>About the role</h2>
            <JobDescriptionField planId={planId} />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/** Hours spent so far, rounded to a quarter hour, as a starting value for the log field. */
function suggestedHours(startedAt: string): number | null {
  const minutes = (Date.now() - Date.parse(startedAt)) / 60000;
  const quarters = Math.round(minutes / 15);
  // Under about 7 minutes rounds to nothing: leave the field empty rather than log time not spent.
  if (!Number.isFinite(quarters) || quarters <= 0) return null;
  return Math.min(MAX_LOG_HOURS, quarters / 4);
}

function ActiveSession({
  planId,
  task,
  detail,
  onFinished,
  onAbandoned,
}: {
  planId: string;
  task: Task;
  detail: SessionDetail;
  onFinished: (result: FinishedSession) => void;
  onAbandoned: () => void;
}) {
  const readOnly = useReadOnlyPlan();
  const { session } = detail;
  const external = session.channel === 'external';
  const inApp = session.channel === 'in_app';
  const [aiDown, setAiDown] = useState<AiDown | null>(null);
  // Without the AI the copy-prompt and paste flow is offered on any channel, beside the self-check.
  const showPrompt = external || aiDown !== null;
  const prompt = usePracticePrompt(planId, task.id, showPrompt);
  const finish = useFinishSession(planId, session.id);
  const paste = usePasteFeedback(planId, session.id);
  const abandon = useAbandonSession(planId, session.id);
  const [choice, setChoice] = useState<FinishChoice | null>(null);
  const [defaultHours, setDefaultHours] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const steps = rubricSteps(task.howToSteps);

  function open(next: FinishChoice) {
    finish.reset();
    paste.reset();
    setDefaultHours(suggestedHours(session.startedAt));
    setChoice(next);
  }

  function submit(decision: FinishDecision) {
    if (!choice) return;
    const common = { markDone: decision.markDone, logHours: decision.logHours };
    const options = {
      onSuccess: onFinished,
      onError: (error: unknown) => {
        // The AI could not write the feedback: close the dialog and offer the other ways to finish.
        const reason = choice.kind === 'ai' ? aiDownReason(error) : null;
        if (reason) {
          setChoice(null);
          setAiDown(reason);
        }
      },
    };
    if (choice.kind === 'paste') {
      paste.mutate({ text: choice.text, ...common }, options);
    } else {
      finish.mutate(
        {
          ...common,
          ...(choice.kind === 'ai' ? { aiFeedback: true } : {}),
          ...(choice.kind === 'rubric' ? { rubric: { checkedSteps: choice.checkedSteps } } : {}),
          ...(choice.kind === 'score'
            ? { enteredScore: { score: choice.score, max: choice.max } }
            : {}),
        },
        options,
      );
    }
  }

  const failure = finish.error ?? paste.error;
  const busy = finish.isPending || paste.isPending;

  return (
    <div className="space-y-4">
      <Panel>
        <Timer startedAt={session.startedAt} plannedMinutes={session.plannedMinutes} />
      </Panel>

      {task.howToSteps.length > 0 ? (
        <Panel>
          <section aria-labelledby="steps-heading" className="space-y-2">
            <h2 id="steps-heading">What to do</h2>
            <ol className="list-decimal space-y-1 pl-6">
              {task.howToSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
        </Panel>
      ) : null}

      {inApp ? (
        <Panel>
          <ChatPanel
            planId={planId}
            session={session}
            messages={detail.messages}
            aiDown={aiDown}
            onAiDown={setAiDown}
            onRetryAi={() => setAiDown(null)}
            onAskFeedback={() => open({ kind: 'ai' })}
          />
        </Panel>
      ) : null}

      {showPrompt ? (
        <>
          <Panel>
            <QueryView query={prompt} label="Preparing the prompt…">
              {(data) => <PromptPanel prompt={data} />}
            </QueryView>
          </Panel>
          {readOnly ? null : (
            <Panel>
              <details>
                <summary className="min-h-11 cursor-pointer py-2 font-bold">
                  About the role (job description)
                </summary>
                <div className="pt-3">
                  <JobDescriptionField planId={planId} />
                </div>
              </details>
            </Panel>
          )}
          <Panel>
            <PasteFeedback onFinish={open} />
          </Panel>
        </>
      ) : null}

      <Panel>
        <RubricPanel steps={steps} onFinish={open} />
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => open({ kind: 'none' })}>Finish without feedback</Button>
        <Button variant="danger" onClick={() => setConfirmStop(true)}>
          Stop without saving
        </Button>
      </div>
      {abandon.isError ? (
        <ErrorText>{describeError(abandon.error, 'The practice could not be stopped.')}</ErrorText>
      ) : null}

      {choice ? (
        <FinishDialog
          choice={choice}
          defaultHours={defaultHours}
          busy={busy}
          error={
            failure
              ? isApiError(failure) && failure.code === 'rate_limited'
                ? RATE_LIMITED_TEXT
                : describeError(failure, 'The practice could not be finished.')
              : null
          }
          onSubmit={submit}
          onCancel={() => setChoice(null)}
        />
      ) : null}

      {confirmStop ? (
        <ConfirmDialog
          title="Stop this practice?"
          confirmLabel="Stop practice"
          cancelLabel="Keep practising"
          busy={abandon.isPending}
          onCancel={() => setConfirmStop(false)}
          onConfirm={() =>
            abandon.mutate(undefined, {
              onSuccess: () => {
                setConfirmStop(false);
                onAbandoned();
              },
              onError: () => setConfirmStop(false),
            })
          }
        >
          <p>Nothing is logged and the task stays as it is.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function TaskPractice({ planId, task }: { planId: string; task: Task }) {
  const [sessionId, setSessionId] = useState<string | null>(() =>
    readStoredSession(planId, task.id),
  );
  const [result, setResult] = useState<FinishedSession | null>(null);
  const [stopped, setStopped] = useState(false);
  const detail = usePracticeSession(planId, sessionId);

  function setId(id: string | null) {
    writeStoredSession(planId, task.id, id);
    setSessionId(id);
  }

  function again() {
    setResult(null);
    setStopped(false);
    setId(null);
  }

  // A remembered id that leads nowhere (gone, not running any more, or unreadable) is forgotten, and
  // the start panel takes over: the person is never stuck on a dead session.
  const unusable =
    sessionId !== null &&
    !result &&
    (detail.isError ||
      detail.data === null ||
      (!!detail.data && detail.data.session.status !== 'active'));
  useEffect(() => {
    if (unusable) writeStoredSession(planId, task.id, null);
  }, [unusable, planId, task.id]);

  let body: ReactNode;
  if (result) {
    body = (
      <FinishedSummary
        feedback={result.feedback}
        extras={{
          loggedHours: result.loggedHours,
          taskStatus: result.task.status,
          replayed: result.replayed,
          parsed: result.parsed,
        }}
        onAgain={again}
      />
    );
  } else if (sessionId && detail.isPending) {
    body = (
      <QueryView query={detail} label="Loading your practice…">
        {() => null}
      </QueryView>
    );
  } else if (!unusable && detail.data && detail.data.session.status === 'active') {
    body = (
      <ActiveSession
        planId={planId}
        task={task}
        detail={detail.data}
        onFinished={(r) => {
          writeStoredSession(planId, task.id, null);
          setResult(r);
        }}
        onAbandoned={() => {
          setStopped(true);
          setId(null);
        }}
      />
    );
  } else {
    body = (
      <StartPanel
        planId={planId}
        task={task}
        notice={stopped ? 'The practice was stopped. Nothing was logged.' : null}
        onStarted={setId}
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <TaskTypeChip type={task.type} />
        {task.practiceKind ? <span className="text-muted">{task.practiceKind}</span> : null}
      </div>
      {body}
    </>
  );
}

function PracticeContent({ planId, taskId }: { planId: string; taskId: string }) {
  const tasks = useTasks(planId);
  return (
    <QueryView query={tasks} label="Loading the task…">
      {({ tasks: all }) => {
        const task = all.find((t) => t.id === taskId);
        if (!task) return <p>This task is not in your plan.</p>;
        return (
          <>
            <h2 className="text-h2">{task.title}</h2>
            {task.type !== 'practice' ? (
              <p>This task is not a practice, so it has no practice screen.</p>
            ) : (
              <TaskPractice key={task.id} planId={planId} task={task} />
            )}
          </>
        );
      }}
    </QueryView>
  );
}

/** /practice/:taskId: run one practice with the timer, a prompt, and a way to save the result. */
export function PracticePage() {
  const { taskId } = useParams();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Today
        </Link>
        <h1>Practice</h1>
      </div>
      <PlanGate empty={<p className="text-muted">There is no plan yet. Import one on Today.</p>}>
        {(plan) =>
          taskId ? (
            <PracticeContent planId={plan.id} taskId={taskId} />
          ) : (
            <p>This task is not in your plan.</p>
          )
        }
      </PlanGate>
    </div>
  );
}
