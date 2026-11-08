import type { ComponentType } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { OpenTask, OpenTasks, PlanSummary, Progress, Schedule, Task } from '../api/client';
import {
  useDay,
  useOpenTasks,
  useProgress,
  useSchedule,
  useTaskAction,
  useTasks,
} from '../api/hooks';
import { QueryView } from '../components/QueryView';
import { TaskStatusLabel, TaskTypeChip } from '../components/TaskChips';
import { ArrowUpIcon, AlertIcon, CheckIcon, ClockIcon, ReturnIcon } from '../components/icons';
import { ErrorText, linkClass } from '../components/ui';
import { weekDays, weekTotals } from '../lib/day-hours';
import { carriedOverText, formatDate, formatHours, monthDay, weekdayShort } from '../lib/format';
import { describeError } from '../lib/messages';
import { TASK_TYPE_META } from '../lib/task-types';
import { computeTrend, trendLabel, type TrendStatus } from '../lib/trend';
import { PlanGate, PlanSwitcher } from '../plan/PlanGate';
import { LastPracticeScores } from './practice-trends/LastPracticeScores';
import { TaskActions } from './today/TaskActions';
import { TimeGridSection } from './week/TimeGridSection';
import { WeekChart } from './week/WeekChart';

const TREND_STYLE: Record<TrendStatus, { Icon: ComponentType; className: string }> = {
  ahead: { Icon: ArrowUpIcon, className: 'text-ok' },
  on_track: { Icon: CheckIcon, className: 'text-ok' },
  behind: { Icon: AlertIcon, className: 'text-warn' },
  unknown: { Icon: ClockIcon, className: 'text-muted' },
};

type WeekViewMode = 'list' | 'grid';
const VIEW_STORAGE_KEY = 'upversion.week-view';

const parseView = (value: string | null): WeekViewMode | null =>
  value === 'list' || value === 'grid' ? value : null;

// Browser storage is only a per-device convenience; it can be blocked or empty.
function readStoredView(): WeekViewMode | null {
  try {
    return parseView(window.localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The chosen view: the address (`?view=grid`) wins, then this device's last choice, then the list. */
function useWeekViewMode(): [WeekViewMode, (view: WeekViewMode) => void] {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get('view')) ?? readStoredView() ?? 'list';
  const choose = (next: WeekViewMode) => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Not remembering the choice is fine; the address still carries it.
    }
    setParams(
      (previous) => {
        const copy = new URLSearchParams(previous);
        copy.set('view', next);
        return copy;
      },
      { replace: true },
    );
  };
  return [view, choose];
}

function ViewToggle({
  view,
  onChoose,
}: {
  view: WeekViewMode;
  onChoose: (view: WeekViewMode) => void;
}) {
  const option = (value: WeekViewMode, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChoose(value)}
      className={`min-h-11 px-4 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${view === value ? 'bg-accent text-on-accent' : 'bg-surface text-text'}`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Week view"
      className="inline-flex divide-x divide-border overflow-hidden rounded-md border border-border"
    >
      {option('list', 'List')}
      {option('grid', 'Time grid')}
    </div>
  );
}

function TrendSection({ plan, schedule }: { plan: PlanSummary; schedule: Schedule }) {
  const trend = computeTrend(schedule.finishDate, plan.endDate);
  const { Icon, className } = TREND_STYLE[trend.status];
  return (
    <section aria-labelledby="trend-heading" className="space-y-1">
      <h2 id="trend-heading">Trend</h2>
      <p className={`flex items-center gap-2 text-lg font-bold ${className}`}>
        <Icon />
        {trendLabel(trend)}
      </p>
      <p className="text-muted">
        {schedule.finishDate
          ? `Projected finish ${formatDate(schedule.finishDate)}`
          : 'There is no projected finish date yet.'}
        {plan.endDate ? ` · Plan end ${formatDate(plan.endDate, 'short')}` : ''}
      </p>
    </section>
  );
}

function OpenTaskRow({
  planId,
  task,
  weekStart,
}: {
  planId: string;
  task: OpenTask;
  weekStart: string;
}) {
  const reopen = useTaskAction(planId, 'reopen');
  const skipped = task.status === 'skipped';
  const meta = task.type in TASK_TYPE_META ? TASK_TYPE_META[task.type as Task['type']] : null;
  return (
    <li
      className={`space-y-2 rounded-md border border-l-4 border-border bg-surface p-4 ${meta?.strip ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {meta ? <TaskTypeChip type={task.type as Task['type']} /> : null}
        {skipped ? <TaskStatusLabel status="skipped" /> : null}
        <span className="ml-auto text-muted tabular-nums">
          {formatHours(task.remainingHours)} left
        </span>
      </div>
      <h3 className="text-lg font-bold">
        <Link
          to={`/plan/${encodeURIComponent(task.taskId)}`}
          className={`${linkClass} inline-block min-h-11 py-2`}
        >
          {task.title}
        </Link>
      </h3>
      {task.carriedOverFrom.length > 0 ? (
        <p className="inline-flex items-center gap-2 rounded-sm bg-warn-soft px-2 py-1 font-bold text-warn">
          <ReturnIcon />
          {carriedOverText(task.carriedOverFrom, weekStart)}
        </p>
      ) : null}
      {task.plannedDates.length > 0 ? (
        <p className="text-muted">
          Planned{' '}
          {task.plannedDates.map((d) => (d < weekStart ? monthDay(d) : weekdayShort(d))).join(', ')}
        </p>
      ) : null}
      {skipped ? (
        <>
          {/* Nothing reopens on its own: the person decides (spec 9). */}
          <TaskActions
            task={task}
            busy={reopen.isPending}
            logging
            onLog={() => undefined}
            onDone={() => undefined}
            onSkip={() => undefined}
            onReopen={() => reopen.mutate(task.taskId)}
          />
          {reopen.isError ? (
            <ErrorText>{describeError(reopen.error, 'Could not reopen the task.')}</ErrorText>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function WeekView({
  plan,
  schedule,
  tasks,
  progress,
  open,
}: {
  plan: PlanSummary;
  schedule: Schedule;
  tasks: Task[];
  progress: Progress;
  open: OpenTasks;
}) {
  const [view, chooseView] = useWeekViewMode();
  const day = useDay(plan.id, schedule.today);
  const todayFrozen = Boolean(day.data?.frozen);
  const days = weekDays(schedule.blocks, progress.byDay, open.weekStart, open.today, todayFrozen);
  const totals = weekTotals(
    days,
    schedule.blocks,
    new Map(tasks.map((t) => [t.id, t.status])),
    open.weekStart,
    open.weekEnd,
  );
  // Tasks that were carried over come first: they have already waited.
  const sorted = [...open.tasks].sort(
    (a, b) => Number(b.carriedOverFrom.length > 0) - Number(a.carriedOverFrom.length > 0),
  );
  return (
    <>
      <p className="text-muted">
        {formatDate(open.weekStart, 'short')} to {formatDate(open.weekEnd, 'short')} · {plan.name}
      </p>

      <ViewToggle view={view} onChoose={chooseView} />

      {view === 'grid' ? (
        <TimeGridSection
          plan={plan}
          schedule={schedule}
          tasks={tasks}
          weekStart={open.weekStart}
          weekEnd={open.weekEnd}
        />
      ) : (
        /* Two columns from desktop width: trend and progress on the left, open tasks on the right. */
        <div className="space-y-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8 lg:space-y-0">
          <div className="min-w-0 space-y-6">
            <TrendSection plan={plan} schedule={schedule} />

            <LastPracticeScores planId={plan.id} />

            <section aria-labelledby="week-progress-heading" className="space-y-3">
              <h2 id="week-progress-heading">Week progress</h2>
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-muted">Tasks completed</dt>
                  <dd className="text-h2 font-bold tabular-nums">
                    {totals.tasksDone} of {totals.tasksPlanned}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Hours, actual of planned</dt>
                  <dd className="text-h2 font-bold tabular-nums">
                    {formatHours(totals.actualHours)} of {formatHours(totals.plannedHours)}
                  </dd>
                </div>
              </dl>
              <WeekChart days={days} />
            </section>
          </div>

          <section aria-labelledby="open-heading" className="min-w-0 space-y-3">
            <h2 id="open-heading">Open tasks</h2>
            {sorted.length === 0 ? (
              <p className="text-muted">Nothing is open this week.</p>
            ) : (
              <ul className="space-y-3">
                {sorted.map((task) => (
                  <OpenTaskRow
                    key={task.taskId}
                    planId={plan.id}
                    task={task}
                    weekStart={open.weekStart}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function WeekLoader({ plan }: { plan: PlanSummary }) {
  const schedule = useSchedule(plan.id);
  const tasks = useTasks(plan.id);
  const progress = useProgress(plan.id);
  const open = useOpenTasks(plan.id);
  return (
    <QueryView query={schedule} label="Loading your schedule…">
      {(sched) => (
        <QueryView query={tasks} label="Loading your tasks…">
          {({ tasks: list }) => (
            <QueryView query={progress} label="Loading your progress…">
              {(prog) => (
                <QueryView query={open} label="Loading this week…">
                  {(openTasks) => (
                    <WeekView
                      plan={plan}
                      schedule={sched}
                      tasks={list}
                      progress={prog}
                      open={openTasks}
                    />
                  )}
                </QueryView>
              )}
            </QueryView>
          )}
        </QueryView>
      )}
    </QueryView>
  );
}

/** The week: progress, planned against actual hours per day, open tasks and the trend. */
export function WeekPage() {
  return (
    <div className="space-y-6">
      <h1>Week</h1>
      <PlanSwitcher />
      <PlanGate
        empty={
          <p className="max-w-3xl text-muted">
            No plan yet. Import one from{' '}
            <Link to="/" className={linkClass}>
              Today
            </Link>
            .
          </p>
        }
      >
        {(plan) => <WeekLoader plan={plan} />}
      </PlanGate>
    </div>
  );
}
