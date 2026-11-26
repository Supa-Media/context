/**
 * What an area shows of its one headline metric (the owner, 2026-11-24: one
 * metric per area; a second becomes a sub-area): its label, its latest
 * reading, how that stands against the target, the target written short, and
 * the trend's geometry. The list, the chart and the panel all draw from this.
 *
 * The reading is a workspace metric's, worked out as it is read, or the
 * area's own `metrics.csv`'s (`areaMetric.ts`).
 */

import type { AreaReading, ReadingStatus } from "./areaMetric";
import { shortTarget } from "./shortTarget";
import { targetNumber, targetState, type Reading, type TargetState } from "./readings";
import { trendGeometry, type TrendGeometry } from "./Trend";
import type { TrendPoint } from "./trendPoints";
import type { Seat } from "./seat";
import { goalWords, verdictOf, type Verdict } from "./verdict";

export interface Headline {
  readonly label: string;
  /** The target as the narrow column writes it, `< 800 ms`; "" when none is set. */
  readonly target: string;
  /** The latest reading as written, `d` for days; null before the first reading. */
  readonly value: string | null;
  readonly date: string;
  readonly state: TargetState;
  readonly trend: TrendGeometry | null;
  /** What hovering each point of the trend says, in its order; empty when nothing is known. */
  readonly points: readonly TrendPoint[];
  /** "Stripe + Cloudflare · last row 1h ago" for a workspace metric; "" for `metrics.csv`. */
  readonly source: string;
  /** "7d", "MTD": the time range the value covers, tagged beside the label; "" when nothing says. */
  readonly period: string;
  /** Hidden or still being worked out: drawn muted. */
  readonly status: ReadingStatus;
  /** The target in words, `aim 100+`, `under $500`, `of 15`; "" when none is set. */
  readonly goal: string;
  /** Exceeds target, On target, On pace, Under target or Needs a look; null when nothing can be said (`verdict.ts`). */
  readonly verdict: Verdict | null;
}

/** The verdict as the two-state colour the trend and value are drawn in. */
function stateFrom(verdict: Verdict | null, fallback: TargetState): TargetState {
  if (verdict === null) return fallback;
  return verdict.good ? "met" : "missed";
}

function fromArea(reading: Reading | AreaReading | undefined): reading is AreaReading {
  return reading !== undefined && "from" in reading;
}

/** The hover words, only when there is one for every number the trend draws. */
function pointsFor(reading: Reading): readonly TrendPoint[] {
  return reading.points !== undefined && reading.points.length === reading.series.length ? reading.points : [];
}

/** Null when the area names no metric. */
export function headlineOf(seat: Seat, reading: Reading | AreaReading | undefined, now: number = Date.now()): Headline | null {
  const metric = seat.metrics[0];
  if (metric === undefined) return null;
  const target = metric.target === null ? "" : shortTarget(metric.target);
  const goal = metric.target === null ? "" : goalWords(metric.target);
  if (fromArea(reading)) {
    const verdict = reading.status === "ok" ? verdictOf(reading.value, metric.target, reading.start ?? null, now) : null;
    return {
      label: metric.name,
      target,
      value: reading.status === "none" ? null : reading.value.replace(/ days?$/, " d"),
      date: reading.date,
      state: metric.target === null ? "unknown" : stateFrom(verdict, reading.state),
      trend: reading.status === "ok" ? trendGeometry(reading.series, reading.limit) : null,
      points: reading.status === "ok" ? pointsFor(reading) : [],
      source: [reading.inputs, reading.when].filter((part) => part !== "").join(" · "),
      period: reading.period,
      status: reading.status,
      goal,
      verdict,
    };
  }
  const verdict = reading === undefined ? null : verdictOf(reading.value, metric.target, reading.start ?? null, now);
  return {
    label: metric.name,
    target,
    value: reading === undefined ? null : reading.value.replace(/ days?$/, " d"),
    date: reading?.date ?? "",
    state: metric.target === null ? "unknown" : stateFrom(verdict, targetState(reading, metric.target)),
    trend: reading === undefined ? null : trendGeometry(reading.series, targetNumber(reading, metric.target)),
    points: reading === undefined ? [] : pointsFor(reading),
    source: "",
    period: "",
    status: reading === undefined ? "none" : "ok",
    goal,
    verdict,
  };
}
