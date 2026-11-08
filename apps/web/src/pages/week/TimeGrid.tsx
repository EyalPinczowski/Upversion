import { addDays, formatTime, parseTime } from '@upversion/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Block, Task } from '../../api/client';
import type { CalendarBusyItem } from '../../api/calendar-hooks';
import { monthDay, weekdayShort } from '../../lib/format';
import { TASK_TYPE_META } from '../../lib/task-types';
import {
  gridRange,
  hourMarks,
  layoutOverlaps,
  verticalPosition,
  type GridRange,
  type Placed,
  type Span,
} from '../../lib/time-grid';

/** Height of one hour in the grid. */
const HOUR_REM = 3.5;
const HATCH_ID = 'week-grid-busy-hatch';

interface PlanItem extends Span {
  kind: 'plan';
  key: string;
  taskId: string;
  title: string;
  type: Task['type'] | null;
}
interface BusyBlock extends Span {
  kind: 'busy';
  key: string;
  title: string;
}
type Item = PlanItem | BusyBlock;

const range = (a: string, b: string) => `${a} to ${b}`;

function PlanBlock({ item, from, to }: { item: PlanItem; from: string; to: string }) {
  const meta = item.type ? TASK_TYPE_META[item.type] : null;
  const label = meta?.label ?? 'Study';
  return (
    <Link
      to={`/plan/${encodeURIComponent(item.taskId)}`}
      aria-label={`${label}: ${item.title}, ${range(from, to)}`}
      className={`block h-full min-w-0 overflow-hidden rounded-sm border border-l-4 px-1 py-0.5 text-xs leading-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${meta ? `${meta.chip} ${meta.strip}` : 'border-border bg-surface-2 text-text'}`}
    >
      <span className="block font-bold">{label}</span>
      <span className="block break-words">{item.title}</span>
    </Link>
  );
}

function BusyBlockView({ item, from, to }: { item: BusyBlock; from: string; to: string }) {
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`Busy${item.title ? `: ${item.title}` : ''}, ${range(from, to)}`}
      className="relative h-full min-w-0 overflow-hidden rounded-sm border border-dashed border-muted bg-surface-2 px-1 py-0.5 text-xs leading-tight text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full text-border">
        <rect width="100%" height="100%" fill={`url(#${HATCH_ID})`} />
      </svg>
      <span className="relative block font-bold">Busy</span>
      {item.title ? <span className="relative block break-words">{item.title}</span> : null}
    </div>
  );
}

function DayColumn({
  date,
  items,
  allDay,
  rangeOfDay,
  isToday,
  visibleOnPhone,
}: {
  date: string;
  items: Item[];
  allDay: CalendarBusyItem[];
  rangeOfDay: GridRange;
  isToday: boolean;
  visibleOnPhone: boolean;
}) {
  const placed: Placed<Item>[] = layoutOverlaps(items);
  const height = ((rangeOfDay.end - rangeOfDay.start) / 60) * HOUR_REM;
  return (
    <div
      className={`min-w-0 ${visibleOnPhone ? '' : 'hidden lg:block'}`}
      role="group"
      aria-label={`${weekdayShort(date)}, ${monthDay(date)}${isToday ? ', today' : ''}`}
    >
      <div
        className={`flex h-14 flex-col items-center justify-center border-b border-border text-center ${isToday ? 'bg-accent-soft font-bold text-accent-soft-text' : ''}`}
      >
        <span>{weekdayShort(date)}</span>
        <span className="tabular-nums">{monthDay(date)}</span>
        {isToday ? <span className="text-xs">Today</span> : null}
      </div>
      <div className="min-h-6 space-y-0.5 border-b border-border p-0.5">
        {allDay.map((a, i) => (
          <p
            key={i}
            className="min-w-0 break-words rounded-sm border border-dashed border-muted bg-surface-2 px-1 text-xs text-muted"
          >
            Busy all day{a.title ? `: ${a.title}` : ''}
          </p>
        ))}
      </div>
      <div
        className={`relative border-l border-border ${isToday ? 'bg-accent-soft/40' : ''}`}
        style={{ height: `${height}rem` }}
      >
        {hourMarks(rangeOfDay).map((m) => (
          <div
            key={m}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-border"
            style={{
              top: `${verticalPosition({ startMinute: m, endMinute: m }, rangeOfDay).top}%`,
            }}
          />
        ))}
        {placed.map(({ item, lane, lanes }) => {
          const { top, height: h } = verticalPosition(item, rangeOfDay);
          if (h <= 0) return null;
          const from = formatTime(item.startMinute);
          const to = formatTime(item.endMinute);
          return (
            <div
              key={item.key}
              className="absolute p-px"
              style={{
                top: `${top}%`,
                height: `${h}%`,
                left: `${(lane / lanes) * 100}%`,
                width: `${100 / lanes}%`,
              }}
            >
              {item.kind === 'plan' ? (
                <PlanBlock item={item} from={from} to={to} />
              ) : (
                <BusyBlockView item={item} from={from} to={to} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The week as a time grid (spec 3.8): the plan's study blocks and, when the calendar is connected,
 * the owner's busy time. Wide screens (lg and up) show the seven days as columns; on a phone a
 * single day is shown, chosen with the day buttons. Hours run over the study window plus one hour
 * on each side. Nothing here sends anything anywhere: it only draws what it is given.
 */
export function TimeGrid({
  weekStart,
  today,
  blocks,
  tasks,
  busy,
  window,
}: {
  weekStart: string;
  today: string;
  blocks: Block[];
  tasks: Task[];
  busy: CalendarBusyItem[];
  /** The plan's study window, `HH:MM` each. */
  window: { start: string; end: string };
}) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const [picked, setPicked] = useState<string | null>(null);
  const selected =
    picked && dates.includes(picked) ? picked : dates.includes(today) ? today : dates[0]!;
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const byDate = new Map<string, Item[]>();
  const allDayByDate = new Map<string, CalendarBusyItem[]>();
  const add = (date: string, item: Item) => byDate.set(date, [...(byDate.get(date) ?? []), item]);
  blocks.forEach((b, i) => {
    if (!dates.includes(b.date)) return;
    const task = taskById.get(b.taskId);
    add(b.date, {
      kind: 'plan',
      key: `plan-${i}`,
      taskId: b.taskId,
      title: task?.title ?? b.taskId,
      type: task?.type ?? null,
      startMinute: parseTime(b.start),
      endMinute: parseTime(b.end),
    });
  });
  busy.forEach((b, i) => {
    if (!dates.includes(b.date)) return;
    if (b.allDay) {
      allDayByDate.set(b.date, [...(allDayByDate.get(b.date) ?? []), b]);
      return;
    }
    add(b.date, {
      kind: 'busy',
      key: `busy-${i}`,
      title: b.title,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
    });
  });

  const everything = [...byDate.values()].flat();
  const rangeOfWeek = gridRange(
    { startMinute: parseTime(window.start), endMinute: parseTime(window.end) },
    everything,
  );

  return (
    <div className="min-w-0 space-y-3">
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <pattern id={HATCH_ID} width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
      </svg>

      <div role="group" aria-label="Day" className="grid grid-cols-7 gap-1 lg:hidden">
        {dates.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === selected}
            onClick={() => setPicked(d)}
            className={`min-h-11 rounded-md border px-0.5 text-center text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${d === selected ? 'border-accent bg-accent-soft font-bold text-accent-soft-text' : 'border-border bg-surface'}`}
          >
            <span className="block">{weekdayShort(d)}</span>
            <span className="block tabular-nums">{d.slice(8)}</span>
            {d === today ? <span className="block text-xs">Today</span> : null}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] lg:grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]">
        <div aria-hidden="true">
          <div className="h-14" />
          <div className="min-h-6 border-b border-transparent p-0.5" />
          <div
            className="relative"
            style={{ height: `${((rangeOfWeek.end - rangeOfWeek.start) / 60) * HOUR_REM}rem` }}
          >
            {hourMarks(rangeOfWeek).map((m) => (
              <span
                key={m}
                className="absolute right-1 -translate-y-1/2 text-xs tabular-nums text-muted"
                style={{
                  top: `${verticalPosition({ startMinute: m, endMinute: m }, rangeOfWeek).top}%`,
                }}
              >
                {formatTime(m).slice(0, 2)}
              </span>
            ))}
          </div>
        </div>
        {dates.map((d) => (
          <DayColumn
            key={d}
            date={d}
            items={byDate.get(d) ?? []}
            allDay={allDayByDate.get(d) ?? []}
            rangeOfDay={rangeOfWeek}
            isToday={d === today}
            visibleOnPhone={d === selected}
          />
        ))}
      </div>
    </div>
  );
}
