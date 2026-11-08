import { addDays, formatTime, parseTime } from '@upversion/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Block, Task } from '../../api/client';
import type { CalendarBusyItem } from '../../api/calendar-hooks';
import { monthDay, weekdayShort } from '../../lib/format';
import { TASK_TYPE_META } from '../../lib/task-types';
import {
  allDayLayout,
  ALL_DAY_CHIP_REM,
  dayOfMonth,
  gridRange,
  HEADER_REM,
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
  /** Busy: solid, hatched, "Busy". Tentative: dashed outline, "Maybe busy". */
  state: 'busy' | 'tentative';
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
  const tentative = item.state === 'tentative';
  const label = tentative ? 'Maybe busy' : 'Busy';
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${label}${item.title ? `: ${item.title}` : ''}, ${range(from, to)}`}
      className={`relative h-full min-w-0 overflow-hidden rounded-sm border px-1 py-0.5 text-xs leading-tight text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tentative ? 'border-dashed border-muted bg-surface' : 'border-solid border-muted bg-surface-2'}`}
    >
      {tentative ? null : (
        <svg aria-hidden="true" className="absolute inset-0 h-full w-full">
          <rect width="100%" height="100%" fill={`url(#${HATCH_ID})`} />
        </svg>
      )}
      <span className="relative block font-bold">{label}</span>
      {item.title ? <span className="relative block break-words">{item.title}</span> : null}
    </div>
  );
}

const ALL_DAY_LABEL = { busy: 'Busy all day', tentative: 'Maybe busy all day' } as const;

function allDayText(a: CalendarBusyItem): string {
  const prefix = a.kind === 'non_blocking' ? 'All day' : ALL_DAY_LABEL[a.kind];
  return `${prefix}${a.title ? `: ${a.title}` : ''}`;
}

/** One all-day event as a fixed-height, one-line chip; the full text stays in the page and title. */
function AllDayChip({ item }: { item: CalendarBusyItem }) {
  const style =
    item.kind === 'busy'
      ? 'border border-solid border-muted bg-surface-2 text-muted'
      : item.kind === 'tentative'
        ? 'border border-dashed border-muted bg-surface text-muted'
        : 'border border-transparent text-muted';
  const text = allDayText(item);
  return (
    <p
      title={text}
      className={`truncate rounded-sm px-1 text-xs leading-5 ${style}`}
      style={{ height: `${ALL_DAY_CHIP_REM - 0.125}rem`, marginBottom: '0.125rem' }}
    >
      {text}
    </p>
  );
}

/** The shared all-day row of one day: fixed height, clipped, nothing hidden from readers. */
function AllDayCell({
  events,
  shown,
  hidden,
  heightRem,
}: {
  events: CalendarBusyItem[];
  shown: number;
  hidden: number;
  heightRem: number;
}) {
  const folded = events.slice(shown);
  return (
    <div
      className="overflow-hidden border-b border-border px-0.5 pt-0.5"
      style={{ height: `${heightRem}rem` }}
    >
      {events.slice(0, shown).map((a, i) => (
        <AllDayChip key={i} item={a} />
      ))}
      {hidden > 0 ? (
        <>
          <p
            aria-hidden="true"
            title={folded.map(allDayText).join('; ')}
            className="truncate px-1 text-xs leading-5 text-muted"
            style={{ height: `${ALL_DAY_CHIP_REM - 0.125}rem` }}
          >
            +{hidden} more
          </p>
          <ul className="sr-only">
            {folded.map((a, i) => (
              <li key={i}>{allDayText(a)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function DayColumn({
  date,
  items,
  allDay,
  allDayShape,
  allDayHeightRem,
  rangeOfDay,
  isToday,
  visibleOnPhone,
}: {
  date: string;
  items: Item[];
  allDay: CalendarBusyItem[];
  allDayShape: { shown: number; hidden: number };
  /** Height of the all-day row, the same for every column. */
  allDayHeightRem: number;
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
        className={`flex flex-col items-center justify-center overflow-hidden border-b border-border text-center leading-6 ${isToday ? 'bg-accent-soft font-bold text-accent-soft-text' : ''}`}
        style={{ height: `${HEADER_REM}rem` }}
      >
        <span>{weekdayShort(date)}</span>
        <span className="tabular-nums">{monthDay(date)}</span>
        {isToday ? <span className="text-xs leading-4">Today</span> : null}
      </div>
      <AllDayCell
        events={allDay}
        shown={allDayShape.shown}
        hidden={allDayShape.hidden}
        heightRem={allDayHeightRem}
      />
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
    if (b.allDay || b.kind === 'non_blocking') {
      allDayByDate.set(b.date, [...(allDayByDate.get(b.date) ?? []), b]);
      return;
    }
    add(b.date, {
      kind: 'busy',
      state: b.kind === 'tentative' ? 'tentative' : 'busy',
      key: `busy-${i}`,
      title: b.title,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
    });
  });

  const allDayShape = allDayLayout(dates.map((d) => allDayByDate.get(d)?.length ?? 0));
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
            <path
              d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5"
              style={{ stroke: 'var(--color-border)' }}
              strokeWidth="1"
            />
          </pattern>
        </defs>
      </svg>

      <div role="group" aria-label="Day" className="grid grid-cols-7 gap-0.5 lg:hidden">
        {dates.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={d === selected}
            onClick={() => setPicked(d)}
            className={`min-h-11 min-w-0 overflow-hidden rounded-md border px-0 text-center text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${d === selected ? 'border-accent bg-accent-soft font-bold text-accent-soft-text' : 'border-border bg-surface'}`}
          >
            <span className="block">{weekdayShort(d)}</span>
            <span className="block tabular-nums">{dayOfMonth(d)}</span>
            {d === today ? <span className="block text-xs">Today</span> : null}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] lg:grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]">
        <div aria-hidden="true">
          <div style={{ height: `${HEADER_REM}rem` }} className="border-b border-transparent" />
          <div
            style={{ height: `${allDayShape.heightRem}rem` }}
            className="border-b border-transparent"
          />
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
        {dates.map((d, i) => (
          <DayColumn
            key={d}
            date={d}
            items={byDate.get(d) ?? []}
            allDay={allDayByDate.get(d) ?? []}
            allDayShape={allDayShape.perDay[i]!}
            allDayHeightRem={allDayShape.heightRem}
            rangeOfDay={rangeOfWeek}
            isToday={d === today}
            visibleOnPhone={d === selected}
          />
        ))}
      </div>
    </div>
  );
}
