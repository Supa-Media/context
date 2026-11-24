/**
 * A seat's metric readings, from the area's own `metrics.csv`: one row per
 * reading, `date, metric, value, source, by` (the owner, 2026-11-23: metric
 * readings are rows in the area's own `metrics.csv`; each source only says
 * who writes the rows).
 *
 * Read with the sheets module's own parser (`apps/mcp/src/sheets/csv.js`), so
 * the app and the agents that append rows agree on what a row is. A value is
 * kept as written ("$512", "2.4 days", "7/10"): the sheet, not this file,
 * decides how a number is shown. The series is the leading number of each
 * value, in date order, for the box's sparkline.
 */

import { parseSheet } from "../../../../../../mcp/src/sheets/csv.js";
import type { Metric } from "./seat";

export const METRICS_SHEET = "metrics.csv";

export interface Reading {
  /** The latest value, as written. */
  readonly value: string;
  /** Its date, `YYYY-MM-DD`, or "" when the row named none. */
  readonly date: string;
  /** Every reading's leading number, oldest first; the ones with none are left out. */
  readonly series: readonly number[];
}

/** Readings by metric name, lower-cased. */
export type Readings = ReadonlyMap<string, Reading>;

type Row = Readonly<Record<string, string>>;

function column(columns: readonly { name: string }[], name: string): string | null {
  return columns.find((c) => c.name.trim().toLowerCase() === name)?.name ?? null;
}

/** The leading number of a value as written: `$1,200` → 1200, `2.4 days` → 2.4, `7/10` → 7. */
export function leadingNumber(value: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(value.replace(/^[^\d.-]+/, ""));
  if (match === null) return null;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function readingsOf(text: string): Readings {
  const sheet = parseSheet(text) as unknown as { columns: { name: string }[]; rows: Row[] };
  const metric = column(sheet.columns, "metric");
  const value = column(sheet.columns, "value");
  const date = column(sheet.columns, "date");
  const out = new Map<string, Reading>();
  if (metric === null || value === null) return out;
  const byMetric = new Map<string, { date: string; value: string; at: number }[]>();
  sheet.rows.forEach((row, at) => {
    const name = (row[metric] ?? "").trim().toLowerCase();
    const written = (row[value] ?? "").trim();
    if (name === "" || written === "") return;
    const list = byMetric.get(name) ?? [];
    list.push({ date: date === null ? "" : (row[date] ?? "").trim(), value: written, at });
    byMetric.set(name, list);
  });
  for (const [name, list] of byMetric) {
    // Date order, and the sheet's own order among rows of one date: the later row is the newer reading.
    const ordered = [...list].sort((a, b) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1));
    const last = ordered[ordered.length - 1]!;
    const series = ordered.map((r) => leadingNumber(r.value)).filter((n): n is number => n !== null);
    out.set(name, { value: last.value, date: last.date, series });
  }
  return out;
}

export function readingFor(readings: Readings | undefined, metric: Metric): Reading | undefined {
  return readings?.get(metric.name.trim().toLowerCase());
}

/** Milliseconds in one of a time unit, by the words a value is written with. */
const TIME_UNITS: ReadonlyArray<[RegExp, number]> = [
  [/^(ms|msec|millisecond)s?\b/, 1],
  [/^(s|sec|secs|second|seconds)\b/, 1_000],
  [/^(m|min|mins|minute|minutes)\b/, 60_000],
  [/^(h|hr|hrs|hour|hours)\b/, 3_600_000],
  [/^(d|day|days)\b/, 86_400_000],
  [/^(w|wk|wks|week|weeks)\b/, 604_800_000],
];

/** A value's number in milliseconds when it is written with a time unit (`1436 ms`, `2 s`, `2.4 days`), else null. */
export function timeOf(value: string): number | null {
  const n = leadingNumber(value);
  if (n === null) return null;
  const rest = value.replace(/^[^\d.-]*-?\d[\d,]*(?:\.\d+)?|^[^\d.-]*-?\.\d+/, "").trim().toLowerCase();
  for (const [unit, ms] of TIME_UNITS) if (unit.test(rest)) return n * ms;
  return null;
}

/**
 * Whether a reading meets its target, where the target says which way is
 * good: `under $600`, `below 2 days`, `over 100`, `at least 7`. Times compare
 * across units, so `1436 ms` misses `under 800 ms` and meets `under 2 s`.
 * Null when the target says neither or either side has no number.
 */
export function meetsTarget(reading: Reading, target: string | null): boolean | null {
  if (target === null) return null;
  const want = /^\s*(under|below|less than|at most|<=?|over|above|more than|at least|>=?)\s*(.*)$/i.exec(target);
  if (want === null) return null;
  const limitTime = timeOf(want[2]!);
  const haveTime = timeOf(reading.value);
  const both = limitTime !== null && haveTime !== null;
  const limit = both ? limitTime : leadingNumber(want[2]!);
  const have = both ? haveTime : leadingNumber(reading.value);
  if (limit === null || have === null) return null;
  const word = want[1]!.toLowerCase();
  if (word === "under" || word === "below" || word === "less than" || word === "<") return have < limit;
  if (word === "at most" || word === "<=") return have <= limit;
  if (word === "at least" || word === ">=") return have >= limit;
  return have > limit;
}

/** How a seat's first metric stands: on target, off it, or nothing to say (no reading, no target, or one that says no direction). */
export type TargetState = "met" | "missed" | "unknown";
export function targetState(reading: Reading | undefined, target: string | null): TargetState {
  if (reading === undefined) return "unknown";
  const met = meetsTarget(reading, target);
  return met === null ? "unknown" : met ? "met" : "missed";
}
