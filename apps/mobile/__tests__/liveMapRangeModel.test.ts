/**
 * THE CUSTOM RANGE PICKER'S MODEL. A stretch of time is picked by day: the
 * activity strip has one bar per day from the first day of history to today,
 * and the two handles sit on the boundaries between days. The end handle at
 * the last boundary means "now". Everything here is pure, so the picker's
 * arithmetic (snapping, minimum length, shortcut pills, the count under the
 * selection) is checked without drawing anything. Local time throughout.
 */
import { describe, expect, test } from "@jest/globals";
import {
  SHORTCUTS,
  changesText,
  countIn,
  dragEnd,
  dragStart,
  fitSelection,
  litShortcuts,
  nudge,
  selectionStretch,
  shortcutSelection,
  startFieldText,
  stretchSelection,
  stripFor,
  type Selection,
} from "../features/console/map/live/ui/rangeModel";

const day = (month: number, date: number, h = 0, m = 0) => new Date(2026, month, date, h, m).getTime();
const NOW = day(9, 13, 15, 30);
/** Aug 10 to Oct 13 inclusive: 65 days, the last one today. */
const first = day(7, 10);
const strip = stripFor([{ at: day(7, 10, 9), count: 3 }, { at: day(7, 12, 17), count: 5 }, { at: day(7, 12, 18), count: 1 }], first, NOW);

describe("the activity strip", () => {
  test("one bar per day from the first day of history to today, empty days counted as zero", () => {
    expect(strip.starts[0]).toBe(day(7, 10));
    expect(strip.starts[strip.starts.length - 1]).toBe(day(9, 13));
    expect(strip.starts.length).toBe(65);
    expect(strip.counts.slice(0, 4)).toEqual([3, 0, 6, 0]);
    expect(strip.counts.reduce((a, b) => a + b, 0)).toBe(9);
  });

  test("starts at the earliest day of history, even when the first count is not the first day", () => {
    const later = stripFor([{ at: day(8, 1, 10), count: 2 }], null, NOW);
    expect(later.starts[0]).toBe(day(8, 1));
    expect(later.counts[0]).toBe(2);
  });

  test("with no history at all, it is just today", () => {
    expect(stripFor([], null, NOW)).toEqual({ starts: [day(9, 13)], counts: [0] });
  });
});

describe("the selection, in days", () => {
  const n = strip.starts.length;

  test("a selection is a day range: the start day, and the boundary after the end day", () => {
    const sel: Selection = { s: n - 3, b: n };
    expect(selectionStretch(sel, strip.starts, NOW)).toEqual({ from: day(9, 11), to: NOW, open: true });
    expect(selectionStretch({ s: 0, b: 2 }, strip.starts, NOW)).toEqual({ from: day(7, 10), to: day(7, 12), open: false });
  });

  test("a stretch maps back to the days it covers, and a stretch from the middle of a day snaps to its start", () => {
    expect(stretchSelection({ from: day(9, 11), to: NOW, open: true }, strip.starts)).toEqual({ s: n - 3, b: n });
    expect(stretchSelection({ from: day(7, 11, 9, 5), to: day(7, 12), open: false }, strip.starts)).toEqual({ s: 1, b: 2 });
    expect(stretchSelection({ from: day(7, 10), to: day(7, 10, 2), open: false }, strip.starts)).toEqual({ s: 0, b: 1 });
  });

  test("the start handle cannot pass the end, and the end handle cannot pass the start: a day is the least", () => {
    const sel = { s: 4, b: 9 };
    expect(dragStart(sel, 20, n)).toEqual({ s: 8, b: 9 });
    expect(dragStart(sel, -3, n)).toEqual({ s: 0, b: 9 });
    expect(dragEnd(sel, 2, n)).toEqual({ s: 4, b: 5 });
    expect(dragEnd(sel, 500, n)).toEqual({ s: 4, b: n });
  });

  test("a selection from a longer history is brought into a shorter one, and never empty", () => {
    expect(fitSelection({ s: 60, b: 65 }, 10)).toEqual({ s: 9, b: 10 });
    expect(fitSelection({ s: 2, b: 90 }, 10)).toEqual({ s: 2, b: 10 });
    expect(fitSelection({ s: 4, b: 4 }, 10)).toEqual({ s: 4, b: 5 });
  });

  test("the keyboard moves a handle a day, or a week with Shift, and keeps the same limits", () => {
    expect(nudge({ s: 4, b: 9 }, "start", -1, n)).toEqual({ s: 3, b: 9 });
    expect(nudge({ s: 4, b: 9 }, "end", 7, n)).toEqual({ s: 4, b: 16 });
    expect(nudge({ s: 4, b: 60 }, "end", 7, n)).toEqual({ s: 4, b: n });
    expect(nudge({ s: 4, b: 5 }, "start", 7, n)).toEqual({ s: 4, b: 5 });
  });
});

describe("the shortcut pills", () => {
  const n = strip.starts.length;

  test("three days, two weeks, thirty days, and everything, each ending now", () => {
    expect(SHORTCUTS.map((s) => s.label)).toEqual(["Past 3 days", "Past 2 weeks", "Past 30 days", "Everything"]);
    expect(shortcutSelection("3d", n)).toEqual({ s: n - 3, b: n });
    expect(shortcutSelection("2w", n)).toEqual({ s: n - 14, b: n });
    expect(shortcutSelection("all", n)).toEqual({ s: 0, b: n });
  });

  test("a pill is lit only while the selection is exactly its range; dragging clears it", () => {
    expect(litShortcuts({ s: n - 3, b: n }, n)).toEqual(["3d"]);
    expect(litShortcuts({ s: n - 3, b: n - 1 }, n)).toEqual([]);
    expect(litShortcuts({ s: 0, b: n }, n)).toEqual(["all"]);
  });

  test("a history shorter than a pill's span makes that pill the same range as everything", () => {
    expect(litShortcuts(shortcutSelection("30d", 2), 2)).toEqual(["3d", "2w", "30d", "all"]);
  });
});

describe("what the picker reads out", () => {
  test("the count is the sum of the selected days, and the words follow the number", () => {
    expect(countIn([3, 0, 6, 0, 4], { s: 1, b: 4 })).toBe(6);
    expect(countIn([3, 0, 6, 0, 4], { s: 0, b: 5 })).toBe(13);
    expect(changesText(1612)).toBe("1,612 changes");
    expect(changesText(1)).toBe("1 change");
    expect(changesText(0)).toBe("0 changes");
  });

  test("the start field is the day it starts on", () => {
    expect(startFieldText(day(8, 25, 0, 0))).toBe("Fri 25 Sep");
    expect(startFieldText(day(9, 7, 0, 0))).toBe("Wed 7 Oct");
  });
});
