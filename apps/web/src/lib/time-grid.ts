/** Pure layout helpers of the Week time grid. Minutes are counted from midnight. */

export interface Span {
  startMinute: number;
  endMinute: number;
}

export interface Placed<T extends Span> {
  item: T;
  /** Zero-based column inside its group of overlapping items. */
  lane: number;
  /** How many columns the group of overlapping items needs; every item of the group shares them. */
  lanes: number;
}

/**
 * Puts items that overlap in time side by side. Items are grouped into clusters: a chain of items
 * where each one starts before the previous ones have ended. Inside a cluster every item takes the
 * first free lane, and all items of the cluster share the cluster's lane count, so widths match.
 * Items that only touch (one ends exactly when the next starts) do not overlap. The input order
 * does not matter; the result is ordered by start, then end.
 */
export function layoutOverlaps<T extends Span>(items: readonly T[]): Placed<T>[] {
  const sorted = [...items].sort(
    (a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute,
  );
  const result: Placed<T>[] = [];
  let cluster: { item: T; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    for (const c of cluster) result.push({ item: c.item, lane: c.lane, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    if (cluster.length > 0 && item.startMinute >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMinute);
    } else {
      laneEnds[lane] = item.endMinute;
    }
    cluster.push({ item, lane });
    clusterEnd = Math.max(clusterEnd, item.endMinute);
  }
  flush();
  return result;
}

export interface GridRange {
  /** First visible minute, always on the hour. */
  start: number;
  /** Last visible minute, always on the hour. */
  end: number;
}

const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * The hours the grid shows: the study window plus one hour on each side, widened (to whole hours)
 * so that no plan block or busy interval is cut off, and kept inside the day.
 */
export function gridRange(window: Span, extra: readonly Span[] = []): GridRange {
  let start = window.startMinute - HOUR;
  let end = window.endMinute + HOUR;
  for (const s of extra) {
    start = Math.min(start, s.startMinute);
    end = Math.max(end, s.endMinute);
  }
  start = Math.max(0, Math.floor(start / HOUR) * HOUR);
  end = Math.min(DAY, Math.ceil(end / HOUR) * HOUR);
  if (end - start < HOUR) end = Math.min(DAY, start + HOUR);
  if (end - start < HOUR) start = end - HOUR;
  return { start, end };
}

/** Position of a span inside the range as percentages of its height; clipped to the range. */
export function verticalPosition(span: Span, range: GridRange): { top: number; height: number } {
  const total = range.end - range.start;
  const from = Math.min(Math.max(span.startMinute, range.start), range.end);
  const to = Math.min(Math.max(span.endMinute, range.start), range.end);
  return { top: ((from - range.start) / total) * 100, height: ((to - from) / total) * 100 };
}

/** The hours (as minutes) that get a label and a line, from the range's start up to before its end. */
export function hourMarks(range: GridRange): number[] {
  const marks: number[] = [];
  for (let m = range.start; m < range.end; m += HOUR) marks.push(m);
  return marks;
}
