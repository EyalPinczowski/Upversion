import { describe, expect, it } from 'vitest';
import {
  ALL_DAY_CHIP_REM,
  allDayLayout,
  dayOfMonth,
  gridRange,
  hourMarks,
  layoutOverlaps,
  verticalPosition,
} from './time-grid';

const s = (name: string, startMinute: number, endMinute: number) => ({
  name,
  startMinute,
  endMinute,
});
const lanes = (items: ReturnType<typeof s>[]) =>
  Object.fromEntries(layoutOverlaps(items).map((p) => [p.item.name, [p.lane, p.lanes]]));

describe('layoutOverlaps', () => {
  it('gives one lane to items that do not overlap', () => {
    expect(lanes([s('a', 540, 600), s('b', 660, 720)])).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('does not treat items that only touch as overlapping', () => {
    expect(lanes([s('a', 540, 600), s('b', 600, 660)])).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('puts two overlapping items side by side', () => {
    expect(lanes([s('a', 540, 660), s('b', 600, 720)])).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('is independent of the input order', () => {
    expect(lanes([s('b', 600, 720), s('a', 540, 660)])).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('shares the lane count inside a chain and reuses a free lane', () => {
    // a overlaps b, b overlaps c, but c starts after a ended: c goes back to lane 0, and the
    // whole chain still has two lanes so all three have the same width.
    expect(lanes([s('a', 540, 600), s('b', 570, 660), s('c', 610, 700)])).toEqual({
      a: [0, 2],
      b: [1, 2],
      c: [0, 2],
    });
  });

  it('needs three lanes for three items at the same time', () => {
    expect(lanes([s('a', 540, 600), s('b', 540, 600), s('c', 540, 600)])).toEqual({
      a: [0, 3],
      b: [1, 3],
      c: [2, 3],
    });
  });

  it('keeps separate clusters independent', () => {
    expect(lanes([s('a', 540, 600), s('b', 560, 620), s('c', 700, 760), s('d', 800, 860)])).toEqual(
      { a: [0, 2], b: [1, 2], c: [0, 1], d: [0, 1] },
    );
  });

  it('returns nothing for nothing', () => {
    expect(layoutOverlaps([])).toEqual([]);
  });
});

describe('gridRange', () => {
  it('is the study window plus one hour on each side', () => {
    expect(gridRange({ startMinute: 540, endMinute: 1050 })).toEqual({ start: 480, end: 1140 });
  });

  it('rounds outwards to whole hours', () => {
    expect(gridRange({ startMinute: 570, endMinute: 1050 })).toEqual({ start: 480, end: 1140 });
  });

  it('stays inside the day', () => {
    expect(gridRange({ startMinute: 30, endMinute: 1430 })).toEqual({ start: 0, end: 1440 });
  });

  it('widens to show an item outside the window', () => {
    expect(gridRange({ startMinute: 540, endMinute: 1050 }, [s('x', 300, 330)])).toEqual({
      start: 300,
      end: 1140,
    });
    expect(gridRange({ startMinute: 540, endMinute: 1050 }, [s('x', 1200, 1230)])).toEqual({
      start: 480,
      end: 1260,
    });
  });
});

describe('verticalPosition and hourMarks', () => {
  const range = { start: 480, end: 1080 };
  it('gives percentages of the range', () => {
    expect(verticalPosition(s('a', 540, 600), range)).toEqual({ top: 10, height: 10 });
  });
  it('clips to the range', () => {
    expect(verticalPosition(s('a', 420, 540), range)).toEqual({ top: 0, height: 10 });
  });
  it('lists every hour from the start up to before the end', () => {
    expect(hourMarks({ start: 480, end: 720 })).toEqual([480, 540, 600, 660]);
  });
});

describe('allDayLayout', () => {
  it('has no height when no day has an all-day event', () => {
    expect(allDayLayout([0, 0, 0, 0, 0, 0, 0])).toEqual({
      lines: 0,
      heightRem: 0,
      perDay: Array.from({ length: 7 }, () => ({ shown: 0, hidden: 0 })),
    });
  });

  it('gives every day the same row height, set by the busiest day', () => {
    const l = allDayLayout([0, 1, 2, 0, 0, 0, 0]);
    expect(l.lines).toBe(2);
    expect(l.heightRem).toBe(2 * ALL_DAY_CHIP_REM + 0.25);
    expect(l.perDay.map((d) => d.shown)).toEqual([0, 1, 2, 0, 0, 0, 0]);
  });

  it('caps the row and folds the rest into one "+N more" line', () => {
    const l = allDayLayout([5, 1, 3], 3);
    expect(l.lines).toBe(3);
    expect(l.heightRem).toBe(3 * ALL_DAY_CHIP_REM + 0.25);
    // 5 events: 2 chips + "+3 more" fill exactly the 3 lines.
    expect(l.perDay).toEqual([
      { shown: 2, hidden: 3 },
      { shown: 1, hidden: 0 },
      { shown: 3, hidden: 0 },
    ]);
  });

  it('never needs more lines than the row has', () => {
    for (const counts of [[0], [1], [4, 9], [2, 2, 2]]) {
      const l = allDayLayout(counts);
      for (const d of l.perDay)
        expect(d.shown + (d.hidden > 0 ? 1 : 0)).toBeLessThanOrEqual(l.lines);
    }
  });
});

describe('dayOfMonth', () => {
  it('has no leading zero', () => {
    expect(dayOfMonth('2026-11-08')).toBe('8');
    expect(dayOfMonth('2026-11-10')).toBe('10');
    expect(dayOfMonth('2026-12-01')).toBe('1');
  });
});
