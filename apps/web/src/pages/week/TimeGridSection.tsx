import { Link } from 'react-router';
import type { PlanSummary, Schedule, Task } from '../../api/client';
import { useCalendarBusy, useCalendarStatus } from '../../api/calendar-hooks';
import { usePlan } from '../../api/hooks';
import { ErrorText, linkClass } from '../../components/ui';
import { TimeGrid } from './TimeGrid';

/** Used only until the plan's own study window has loaded, or when the plan has none. */
const FALLBACK_WINDOW = { start: '09:00', end: '17:00' };

/**
 * The Week page's time grid with its data: the plan's blocks always, the owner's busy time only
 * when Google Calendar is connected. Without a connection (or with the feature off on the server)
 * the grid still works and one line says how to connect.
 */
export function TimeGridSection({
  plan,
  schedule,
  tasks,
  weekStart,
  weekEnd,
}: {
  plan: PlanSummary;
  schedule: Schedule;
  tasks: Task[];
  weekStart: string;
  weekEnd: string;
}) {
  const status = useCalendarStatus();
  const detail = usePlan(plan.id);
  const connected = status.data?.status === 'connected';
  const busy = useCalendarBusy(weekStart, weekEnd, connected);
  const pattern = detail.data?.weekPattern;
  const notConnected = status.isSuccess && !connected;

  return (
    <section aria-labelledby="grid-heading" className="min-w-0 space-y-3">
      <h2 id="grid-heading">Time grid</h2>
      {notConnected ? (
        <p className="text-muted">
          <Link to="/settings" className={linkClass}>
            Connect Google Calendar in Settings
          </Link>{' '}
          to see your busy time
        </p>
      ) : null}
      {busy.isError ? <ErrorText>Could not load your busy time.</ErrorText> : null}
      <TimeGrid
        weekStart={weekStart}
        today={schedule.today}
        blocks={schedule.blocks}
        tasks={tasks}
        busy={connected ? (busy.data ?? []) : []}
        window={pattern ? { start: pattern.windowStart, end: pattern.windowEnd } : FALLBACK_WINDOW}
      />
    </section>
  );
}
