/**
 * The arithmetic behind the Growth tab's two headline cards and the nudge
 * list beside the funnel.
 *
 * Split out of `./report` rather than added to it: that file is the page's
 * formatting vocabulary and was already at the size where the next addition
 * should be a module of its own. Same rules as there — pure functions, no
 * React, every figure testable without mounting anything.
 */

import type { Point } from "./report";

// -- the curve ------------------------------------------------------------

/**
 * The top of a growth chart's y-axis: the smallest round, **even** ceiling a
 * little above the data.
 *
 * Even so that the midline the chart draws is a whole number too — a
 * cumulative count of people is an integer, and a gridline labelled "7.5"
 * says otherwise. The 5% headroom keeps the current-day dot off the top rule,
 * where it would read as clipped. 14 → 16, 19 → 20, 3 → 4, 130 → 160.
 *
 * Zero or less returns 4, so an empty deployment still draws a scale with a
 * midline rather than dividing by nothing.
 */
const ROUND_STEPS = [2, 4, 6, 8, 10, 12, 16, 20, 30, 40, 50, 60, 80] as const;

export function niceTop(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 4;
  const floor = max * 1.05;
  for (let magnitude = 1; magnitude < 1e15; magnitude *= 10) {
    for (const step of ROUND_STEPS) {
      if (step * magnitude >= floor) return step * magnitude;
    }
  }
  return floor;
}

/** The viewBox every growth chart is drawn in; the SVG stretches it to fit. */
export const CURVE_BOX = { width: 1000, height: 100 } as const;

export interface CurveGeometry {
  /** The stroke. */
  line: string;
  /** The stroke closed down to the baseline, for the fill under it. */
  area: string;
  /** Each day's position, as percentages of the box — for the dots. */
  points: { left: number; top: number }[];
}

/**
 * A cumulative series as an SVG path.
 *
 * Each day-to-day segment is a cubic whose control points share the segment's
 * midpoint x, so the curve eases from one total to the next and **never
 * overshoots either** — a smoothing that bulged above today's count would
 * draw a number of accounts nobody has. A flat stretch stays exactly flat.
 */
export function curveGeometry(values: readonly number[], top: number): CurveGeometry {
  const { width, height } = CURVE_BOX;
  if (values.length === 0) return { line: "", area: "", points: [] };
  const x = (index: number) =>
    values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
  const y = (value: number) => height - (Math.max(0, value) / top) * height;
  const r = (n: number) => Math.round(n * 100) / 100;

  let line = `M ${r(x(0))} ${r(y(values[0]))}`;
  for (let index = 1; index < values.length; index += 1) {
    const x0 = x(index - 1);
    const x1 = x(index);
    const mid = r((x0 + x1) / 2);
    line += ` C ${mid} ${r(y(values[index - 1]))} ${mid} ${r(y(values[index]))} ${r(x1)} ${r(y(values[index]))}`;
  }
  const last = values.length === 1 ? width / 2 : width;
  const first = values.length === 1 ? width / 2 : 0;
  const area = `${line} L ${r(last)} ${height} L ${r(first)} ${height} Z`;
  const points = values.map((value, index) => ({
    left: (x(index) / width) * 100,
    top: (y(value) / height) * 100,
  }));
  return { line, area, points };
}

// -- the facts under the curve --------------------------------------------

/** How many days in the window somebody arrived on. */
export function arrivalDays(added: readonly Point[]): number {
  return added.filter((point) => point.count > 0).length;
}

/**
 * When the last arrival was, counted back from the window's final day.
 *
 * `null` when nobody arrived in the window — the card prints a dash, not
 * "never", because the window is not all of time.
 */
export function daysSinceLastArrival(added: readonly Point[]): number | null {
  for (let index = added.length - 1; index >= 0; index -= 1) {
    if (added[index].count > 0) return added.length - 1 - index;
  }
  return null;
}

/** `0` → "today", `1` → "yesterday", `n` → "n days ago", `null` → "—". */
export function formatDaysAgo(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// -- who needs a nudge ----------------------------------------------------

/** The roster row, as `censusReport` returns it. Control-plane metadata only. */
export interface RosterRow {
  joinedAt: number;
  email?: string;
  contexts: number;
  owned: number;
  connectedStorage: number;
  clients: number;
  plan: string;
  lastSeenAt: number | null;
}

export interface NudgeCounts {
  noStorage: number;
  noClient: number;
  neverSeen: number;
  pastDue: number;
}

/**
 * The four ways somebody on the roster is stuck, counted.
 *
 * Over the roster the server sent — the newest accounts, not every account —
 * and the card says so. These are the questions the funnel raises and cannot
 * answer, because the funnel's steps are thresholds over everybody: this is
 * the same data read person by person.
 */
export function nudgeCounts(roster: readonly RosterRow[]): NudgeCounts {
  return {
    noStorage: roster.filter((row) => row.connectedStorage === 0).length,
    noClient: roster.filter((row) => row.clients === 0).length,
    neverSeen: roster.filter((row) => row.lastSeenAt === null).length,
    pastDue: roster.filter((row) => row.plan === "past_due").length,
  };
}

/**
 * A roster cell's storage state.
 *
 * `pending` is the one the old page drew dashed: the account owns a context
 * but no bucket under it has verified — "not yet", which must not read as a
 * failure. `none` is an account with nothing to attach a bucket to.
 */
export function storageState(row: RosterRow): "connected" | "pending" | "none" {
  if (row.connectedStorage > 0) return "connected";
  if (row.owned > 0) return "pending";
  return "none";
}
