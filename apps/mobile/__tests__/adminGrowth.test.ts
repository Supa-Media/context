import { describe, expect, test } from "@jest/globals";
import {
  CURVE_BOX,
  arrivalDays,
  curveGeometry,
  daysSinceLastArrival,
  formatDaysAgo,
  niceTop,
  nudgeCounts,
  storageState,
  type RosterRow,
} from "../features/admin/growth";

/**
 * The Growth tab's headline cards and nudge list.
 *
 * Next to `adminReport.test.ts` rather than inside it because that file is
 * already at the size where the next block should be a file of its own. The
 * failure these guard is the same one: a figure that is quietly wrong and
 * looks fine — a gridline labelled 7.5 people, a curve that bulges above the
 * number of accounts that exist, a "last arrival" off by a day.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `niceTop` on plain 1-2-5 steps (odd ceilings, half-unit midline)   2
 *   a control point's y borrowed from the next day (overshoots)        1
 *   `daysSinceLastArrival` counting from the first day                 1
 *   `nudgeCounts.noStorage` keyed on `owned` instead                   1
 */

const day = (index: number) => `2026-09-${String(index + 1).padStart(2, "0")}`;
const points = (counts: number[]) => counts.map((count, index) => ({ day: day(index), count }));

describe("the chart's ceiling", () => {
  test("rounds up to an even number so the midline is a whole one", () => {
    expect(niceTop(14)).toBe(16);
    expect(niceTop(19)).toBe(20);
    expect(niceTop(3)).toBe(4);
    expect(niceTop(130)).toBe(160);
    for (const max of [1, 5, 7, 11, 23, 57, 99, 480, 9_999]) {
      const top = niceTop(max);
      expect(top).toBeGreaterThan(max);
      expect((top / 2) % 1).toBe(0);
    }
  });

  test("leaves headroom, so today's dot is not drawn on the top rule", () => {
    expect(niceTop(16)).toBe(20);
    expect(niceTop(20)).toBe(30);
  });

  test("an empty deployment still gets a scale", () => {
    expect(niceTop(0)).toBe(4);
    expect(niceTop(-3)).toBe(4);
    expect(niceTop(Number.NaN)).toBe(4);
  });
});

describe("the curve", () => {
  test("starts and ends on the first and last totals", () => {
    const { line, points: dots } = curveGeometry([6, 6, 7], 8);
    expect(line.startsWith("M 0 25")).toBe(true);
    expect(line.endsWith(`${CURVE_BOX.width} 12.5`)).toBe(true);
    expect(dots.map((dot) => dot.left)).toEqual([0, 50, 100]);
    expect(dots.map((dot) => dot.top)).toEqual([25, 25, 12.5]);
  });

  test("never overshoots: every control point sits at one of the two totals", () => {
    // A smoothing that bulged above today's count would draw accounts that do
    // not exist. With both control points at the segment's midpoint x and at
    // the two ends' y, a cubic is monotone between them.
    const { line } = curveGeometry([2, 5, 5, 9], 10);
    const ys = [...line.matchAll(/C [\d.]+ ([\d.]+) [\d.]+ ([\d.]+) [\d.]+ ([\d.]+)/g)].map(
      (match) => match.slice(1).map(Number),
    );
    expect(ys).toEqual([
      [80, 50, 50],
      [50, 50, 50],
      [50, 10, 10],
    ]);
  });

  test("the fill closes down to the baseline", () => {
    const { area } = curveGeometry([1, 2], 4);
    expect(area.endsWith(`L ${CURVE_BOX.width} ${CURVE_BOX.height} L 0 ${CURVE_BOX.height} Z`)).toBe(true);
  });

  test("one day is a centred dot, and no days is nothing", () => {
    expect(curveGeometry([3], 4).points).toEqual([{ left: 50, top: 25 }]);
    expect(curveGeometry([], 4)).toEqual({ line: "", area: "", points: [] });
  });
});

describe("the facts under the curve", () => {
  test("days with arrivals counts days, not people", () => {
    expect(arrivalDays(points([0, 2, 0, 1, 0]))).toBe(2);
    expect(arrivalDays(points([0, 0]))).toBe(0);
  });

  test("the last arrival is counted back from the window's final day", () => {
    expect(daysSinceLastArrival(points([1, 0, 0]))).toBe(2);
    expect(daysSinceLastArrival(points([0, 1, 0]))).toBe(1);
    expect(daysSinceLastArrival(points([0, 0, 3]))).toBe(0);
  });

  test("nobody in the window is a dash, not 'never' — the window is not all of time", () => {
    expect(daysSinceLastArrival(points([0, 0, 0]))).toBeNull();
    expect(formatDaysAgo(null)).toBe("—");
  });

  test("says it the way a person would", () => {
    expect(formatDaysAgo(0)).toBe("today");
    expect(formatDaysAgo(1)).toBe("yesterday");
    expect(formatDaysAgo(6)).toBe("6 days ago");
  });
});

describe("who needs a nudge", () => {
  const row = (over: Partial<RosterRow>): RosterRow => ({
    joinedAt: 0,
    email: "someone@example.test",
    contexts: 1,
    owned: 1,
    connectedStorage: 1,
    clients: 1,
    plan: "none",
    lastSeenAt: 1,
    ...over,
  });

  test("counts each way of being stuck separately", () => {
    const roster = [
      row({}),
      row({ connectedStorage: 0 }),
      row({ connectedStorage: 0, owned: 0, contexts: 0, clients: 0, lastSeenAt: null }),
      row({ plan: "past_due" }),
    ];
    expect(nudgeCounts(roster)).toEqual({ noStorage: 2, noClient: 1, neverSeen: 1, pastDue: 1 });
  });

  test("an empty roster is all zeroes", () => {
    expect(nudgeCounts([])).toEqual({ noStorage: 0, noClient: 0, neverSeen: 0, pastDue: 0 });
  });

  test("storage not yet verified is told apart from nothing to attach it to", () => {
    expect(storageState(row({}))).toBe("connected");
    expect(storageState(row({ connectedStorage: 0 }))).toBe("pending");
    expect(storageState(row({ connectedStorage: 0, owned: 0 }))).toBe("none");
  });
});
