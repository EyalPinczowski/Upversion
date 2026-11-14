import type { ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useBriefing, type Briefing, type BriefingTask } from '../../api/briefing-hooks';
import type { DayState } from '../../api/client';
import { useDay, useStartDay } from '../../api/hooks';
import { useReadOnlyPlan } from '../../plan/context';
import { TaskTypeChip } from '../../components/TaskChips';
import { AlertIcon, CheckIcon } from '../../components/icons';
import { Button, ErrorText, linkClass } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { safeWebUrl } from '../../lib/links';
import { describeError } from '../../lib/messages';
import { TASK_TYPE_META } from '../../lib/task-types';
import { PlanGate } from '../../plan/PlanGate';
import { CopyPrompt } from './CopyPrompt';
import { formatMinutes, validDate } from './day-utils';
import { DayQueryView } from './DayQueryView';

/** The overview ends with a warning sentence when a fixed date is at risk; show it on its own. */
function splitOverview(overview: string): { text: string; warning: string | null } {
  const at = overview.indexOf('Warning:');
  if (at === -1) return { text: overview, warning: null };
  return {
    text: overview.slice(0, at).trim(),
    warning: overview.slice(at + 'Warning:'.length).trim(),
  };
}

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} {...EXTERNAL} className={`${linkClass} inline-flex min-h-11 items-center`}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function TaskCard({ task }: { task: BriefingTask }) {
  const headingId = `task-${task.taskId}`;
  const link = safeWebUrl(task.url);
  const multipleBlocks = task.blocks.length > 1;
  return (
    <li
      className={`space-y-4 rounded-md border border-l-4 border-border bg-surface p-4 ${TASK_TYPE_META[task.type].strip}`}
    >
      <article aria-labelledby={headingId} className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <TaskTypeChip type={task.type} />
          {task.carriedOver ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted">
              Carried over from earlier days
            </span>
          ) : null}
        </div>
        <div className="space-y-1">
          <h3 id={headingId} className="text-lg font-bold">
            {task.title}
          </h3>
          <p className="text-muted tabular-nums">
            <time>
              {task.start}–{task.end}
            </time>
            {' · '}
            {formatMinutes(task.plannedMinutes)}
            {task.provider ? ` · ${task.provider}` : ''}
          </p>
          {multipleBlocks ? (
            <p className="text-muted tabular-nums">
              In {task.blocks.length} parts:{' '}
              {task.blocks.map((b) => `${b.start}–${b.end}`).join(', ')}
            </p>
          ) : null}
        </div>

        <p>{task.what}</p>
        {link ? (
          <p>
            <ExternalLink href={link}>
              Open {task.provider ? `on ${task.provider}` : 'the task link'}
              <span className="sr-only">: {task.title}</span>
            </ExternalLink>
          </p>
        ) : null}

        {task.lessons.length > 0 ? (
          <div className="space-y-2">
            <h4 className="font-bold">Lessons</h4>
            <ul className="space-y-3">
              {task.lessons.map((lesson, index) => {
                const lessonLink = safeWebUrl(lesson.url);
                return (
                  <li key={`${lesson.title}-${index}`} className="space-y-1">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {lessonLink ? (
                        <ExternalLink href={lessonLink}>{lesson.title}</ExternalLink>
                      ) : (
                        <span className="font-bold">{lesson.title}</span>
                      )}
                      {lesson.estMinutes !== undefined ? (
                        <span className="text-muted">{formatMinutes(lesson.estMinutes)}</span>
                      ) : null}
                      {lesson.needsCheck ? (
                        <span className="inline-flex items-center gap-1 rounded-sm bg-warn-soft px-2 py-0.5 text-sm font-bold text-warn">
                          <AlertIcon />
                          Needs check
                        </span>
                      ) : null}
                    </p>
                    {lesson.summary ? <p className="text-muted">{lesson.summary}</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {task.howToSteps.length > 0 ? (
          <div className="space-y-2">
            <h4 className="font-bold">How to</h4>
            <ol className="list-decimal space-y-1 pl-6">
              {task.howToSteps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>
        ) : null}

        {task.promptTemplate ? (
          <div className="space-y-2">
            <h4 className="font-bold">Prompt</h4>
            <CopyPrompt text={task.promptTemplate} label={`Prompt for ${task.title}`} />
          </div>
        ) : null}

        {task.type === 'practice' ? (
          <p>
            <Link
              to={`/practice/${encodeURIComponent(task.taskId)}`}
              className={`${linkClass} inline-flex min-h-11 items-center`}
            >
              Run here
              <span className="sr-only">: {task.title}</span>
            </Link>
          </p>
        ) : null}

        {task.successCriteria ? (
          <div className="space-y-1">
            <h4 className="font-bold">What success looks like</h4>
            <p>{task.successCriteria}</p>
          </div>
        ) : null}
      </article>
    </li>
  );
}

type Podcast = NonNullable<Briefing['podcast']>;

/** One podcast about the ideas around the plan's skills. Not a task: no time, no checkbox. */
function IdeaOfTheDay({ podcast }: { podcast: Podcast }) {
  const link = safeWebUrl(podcast.spotifyUrl);
  return (
    <section aria-labelledby="idea-heading" className="space-y-1">
      <h2 id="idea-heading">Idea of the day</h2>
      {/* The publisher is not shown: the research data annotates it ("page footer"). */}
      <p>
        <strong>{podcast.title}</strong>
      </p>
      {podcast.oneLine ? <p>{podcast.oneLine}</p> : null}
      <p className="text-muted">{podcast.skillLink}</p>
      <p className="text-muted">
        A podcast about ideas around your skills, not a lesson. It is not part of your plan or your
        study time.
      </p>
      {link ? (
        <p>
          <ExternalLink href={link}>
            Find the show on Spotify
            <span className="sr-only">: {podcast.title}</span>
          </ExternalLink>
        </p>
      ) : null}
    </section>
  );
}

function StartDay({
  planId,
  date,
  state,
}: {
  planId: string;
  date: string;
  state: DayState | undefined;
}) {
  const navigate = useNavigate();
  const start = useStartDay(planId);
  const readOnly = useReadOnlyPlan();
  if (!state) return null;
  if (state.frozen || state.status === 'ended') {
    return (
      <p className="flex items-center gap-2 text-muted">
        <CheckIcon />
        This day is over. The briefing shows it as it was planned, and it can’t be changed.
      </p>
    );
  }
  const started = state.status === 'started';
  // An archived plan is read-only: no start of the day (the banner says why).
  if (readOnly && !started) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {started ? (
          <>
            <p className="flex items-center gap-2 font-bold text-ok">
              <CheckIcon />
              Study day started
            </p>
            <Link to="/" className={linkClass}>
              Back to Today
            </Link>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={start.isPending}
            onClick={() => start.mutate(date, { onSuccess: () => void navigate('/') })}
          >
            {start.isPending ? 'Starting…' : 'Start study day'}
          </Button>
        )}
      </div>
      {start.isError ? (
        <ErrorText>{describeError(start.error, 'The study day could not be started.')}</ErrorText>
      ) : null}
    </div>
  );
}

function BriefingBody({
  planId,
  briefing,
  dayState,
}: {
  planId: string;
  briefing: Briefing;
  dayState: DayState | undefined;
}) {
  const { text, warning } = splitOverview(briefing.overview);
  const titleOf = (id: string) => briefing.tasks.find((t) => t.taskId === id)?.title ?? id;
  return (
    <>
      <section aria-labelledby="overview-heading" className="space-y-3">
        <h2 id="overview-heading">Overview</h2>
        <p>{text}</p>
        {warning ? (
          <div
            role="group"
            aria-label="Fixed date at risk"
            className="flex items-start gap-3 rounded-md border border-warn bg-warn-soft p-3"
          >
            <span className="text-warn">
              <AlertIcon />
            </span>
            <p>
              <strong className="text-warn">Fixed date at risk:</strong> {warning}
            </p>
          </div>
        ) : null}
        <StartDay planId={planId} date={briefing.date} state={dayState} />
      </section>

      {briefing.podcast ? <IdeaOfTheDay podcast={briefing.podcast} /> : null}

      {briefing.suggestedOrder.length > 0 ? (
        <section aria-labelledby="order-heading" className="space-y-2">
          <h2 id="order-heading">Suggested order</h2>
          <ol className="list-decimal space-y-1 pl-6 tabular-nums">
            {briefing.suggestedOrder.map((slot, index) => (
              <li key={`${slot.taskId}-${slot.start}-${index}`}>
                <time>
                  {slot.start}–{slot.end}
                </time>{' '}
                {titleOf(slot.taskId)}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="tasks-heading" className="space-y-3">
        <h2 id="tasks-heading">Tasks</h2>
        {briefing.tasks.length === 0 ? (
          <p className="text-muted">Nothing is planned for this day.</p>
        ) : (
          <ul className="space-y-3">
            {briefing.tasks.map((task) => (
              <TaskCard key={task.taskId} task={task} />
            ))}
          </ul>
        )}
      </section>

      <p>
        <Link to={`/review/${briefing.date}`} className={linkClass}>
          Review this day
        </Link>
      </p>
    </>
  );
}

function BriefingContent({ planId, date }: { planId: string; date: string }) {
  const briefing = useBriefing(planId, date);
  // The start button needs the day state, but the briefing itself must not wait for it.
  const dayState = useDay(planId, date);
  return (
    <DayQueryView query={briefing} label="Loading the briefing…" what="briefing">
      {(data) => <BriefingBody planId={planId} briefing={data} dayState={dayState.data} />}
    </DayQueryView>
  );
}

/** /briefing/:date: what the day is about, task by task, and the button that starts it. */
export function BriefingPage() {
  const { date: param } = useParams();
  const date = validDate(param);
  if (!date) return <Navigate to="/" replace />;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to="/" className={`${linkClass} inline-flex min-h-11 items-center`}>
          Back to Today
        </Link>
        <h1>Day briefing</h1>
        <p className="text-h2 font-bold">{formatDate(date)}</p>
      </div>
      <PlanGate empty={<p className="text-muted">There is no plan yet. Import one on Today.</p>}>
        {(plan) => <BriefingContent planId={plan.id} date={date} />}
      </PlanGate>
    </div>
  );
}
