/**
 * What an area shows of its one headline metric (the owner, 2026-11-24: one
 * metric per area; a second becomes a sub-area): its label, its latest
 * reading, how that stands against the target, the target written short, and
 * the trend's geometry. The list and the chart both draw from this.
 */

import { shortTarget } from "./shortTarget";
import { targetNumber, targetState, type Reading, type TargetState } from "./readings";
import { trendGeometry, type TrendGeometry } from "./Trend";
import type { Seat } from "./seat";

export interface Headline {
  readonly label: string;
  /** The target as the narrow column writes it, `< 800 ms`; "" when none is set. */
  readonly target: string;
  /** The latest reading as written, `d` for days; null before the first reading. */
  readonly value: string | null;
  readonly date: string;
  readonly state: TargetState;
  readonly trend: TrendGeometry | null;
}

/** Null when the area names no metric. */
export function headlineOf(seat: Seat, reading: Reading | undefined): Headline | null {
  const metric = seat.metrics[0];
  if (metric === undefined) return null;
  return {
    label: metric.name,
    target: metric.target === null ? "" : shortTarget(metric.target),
    value: reading === undefined ? null : reading.value.replace(/ days?$/, " d"),
    date: reading?.date ?? "",
    state: metric.target === null ? "unknown" : targetState(reading, metric.target),
    trend: reading === undefined ? null : trendGeometry(reading.series, targetNumber(reading, metric.target)),
  };
}
