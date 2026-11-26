/**
 * An area's one metric, read from the workspace's metrics when it names one
 * (the data sources boards, 05 and 06; `docs/decisions/data-and-metrics.md`).
 *
 * An area's seat names its metric by name, `metrics: [Revenue per AI dollar ·
 * target over $5]` (`seat.ts`). When that name, lower-cased, is a metric
 * note's `metric:` in the data folder's `metrics/`, the area's reading is that
 * metric worked out as it is read, over the sheets the reader can read
 * (`data/workOut.ts`): a sheet they cannot read and one that is not there are
 * one answer, drawn "Hidden", and never named. When it is no metric note's
 * name, the reading comes from the area's own `metrics.csv` exactly as before
 * (`readings.ts`), so an area set up that way keeps working.
 *
 * Pure. The picker's rows, its target words and the seat edit Save writes are
 * here too, so each is tested without drawing anything.
 */

import type { MetricNote, Use } from "../../data/metrics";
import { usedByWords } from "../../data/metrics";
import { sourceBySlug, type DataSource } from "../../data/sources";
import { metricView } from "../../data/views";
import { ago, lastRowAt, periodTag } from "../../data/words";
import { HIDDEN, inputsOf, stateOf, targetOnScale, trendOf, type Sheet, type Worked } from "../../data/workOut";
import { directedTarget, leadingNumber, readingFor, targetNumber, targetState, type Reading, type Readings, type TargetState } from "./readings";
import { metricKey, type Metric, type Seat, type SeatEdit } from "./seat";

/** What the Areas page knows of the workspace's metrics, all at the reader's own clearance. */
export interface WorkspaceMetrics {
  readonly metrics: readonly MetricNote[];
  readonly worked: ReadonlyMap<string, Worked>;
  readonly sources: readonly DataSource[];
  readonly sheets: ReadonlyMap<string, Sheet | null>;
  readonly uses: ReadonlyMap<string, readonly Use[]>;
  /** The listings, notes and sheets have all come once. */
  readonly settled: boolean;
  /** The data folder's notes have come, so "no metrics" is an answer and not a wait. */
  readonly known: boolean;
  readonly now: number;
}

const keyOf = metricKey;

/**
 * The workspace metric an area's metric name names, by name lower-cased; null
 * for none. Two notes of one name: the first in the metrics folder's order,
 * the one the Data page lists first, so a reading never flips between them.
 */
export function workspaceMetricFor(name: string, metrics: readonly MetricNote[]): MetricNote | null {
  const key = keyOf(name);
  if (key === "") return null;
  return metrics.find((metric) => keyOf(metric.name) === key) ?? null;
}

export type ReadingStatus = "ok" | "hidden" | "none" | "loading";

/** A reading as the list, the chart and the panel draw it, from a workspace metric or `metrics.csv`. */
export interface AreaReading extends Reading {
  readonly from: "workspace" | "sheet";
  readonly status: ReadingStatus;
  /** The metric note it is worked out from; null for `metrics.csv`. */
  readonly metricPath: string | null;
  /** "Stripe + Cloudflare": the sources its formula reads, as stage B names them; "" for `metrics.csv`. */
  readonly inputs: string;
  /** "last row 1h ago", from the newest dated row it reads; "" when nothing says when. */
  readonly when: string;
  /** "7d", "MTD", "today": the time range the number covers, from the note's `every`; "" for `metrics.csv`. */
  readonly period: string;
  readonly state: TargetState;
  /** The target on the trend's own scale, for its dashed line. */
  readonly limit: number | null;
}

/** The newest dated row across the sheets a metric reads, the Context source's counted ones aside: they are counted now. */
function newestRow(metric: MetricNote, ws: WorkspaceMetrics): number | null {
  if (!metric.parsed.ok) return null;
  const bySlug = sourceBySlug(ws.sources);
  let latest: number | null = null;
  for (const input of inputsOf(metric.parsed.ast)) {
    const dataset = bySlug(input.source)?.datasets.find((each) => each.name.toLowerCase() === input.dataset.toLowerCase());
    if (dataset === undefined || dataset.computed) continue;
    const at = lastRowAt(ws.sheets.get(dataset.path) ?? null);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * The oldest period with a value, as the shown value's scale reads it, for a
 * goal's pace line: a worked value of 0.16 shown as "16%" starts the line at 16.
 */
function startOf(worked: Worked): { value: number; at: number } | null {
  const first = worked.periods.find((p) => p.status === "ok" && p.value !== null);
  if (first === undefined || first.value === null) return null;
  const at = Date.parse(first.from);
  if (Number.isNaN(at)) return null;
  const shown = leadingNumber(worked.shown);
  const raw = worked.latest.value;
  const scale = shown === null || raw === null || raw === 0 ? 1 : shown / raw;
  return { value: first.value * scale, at };
}

/** What one workspace metric reads as for an area with `target`. */
export function workspaceReading(metric: MetricNote, ws: WorkspaceMetrics, target: string | null): AreaReading {
  const worked = ws.worked.get(metric.path);
  const view = metricView(metric, worked, ws.uses, ws.sources, ws.settled);
  const newest = newestRow(metric, ws);
  const base = {
    from: "workspace" as const,
    metricPath: metric.path,
    inputs: view.inputs,
    when: newest === null ? "" : `last row ${ago(newest, ws.now)}`,
    period: periodTag(metric.every, worked?.now === true),
    date: "",
  };
  const status = worked?.latest.status;
  if (worked === undefined || (!ws.settled && status !== "ok")) {
    return { ...base, status: "loading", value: "…", series: [], state: "unknown", limit: null };
  }
  if (status === "hidden") return { ...base, status: "hidden", value: HIDDEN, series: [], state: "unknown", limit: null };
  if (status !== "ok") return { ...base, status: "none", value: "", series: [], state: "unknown", limit: null };
  return { ...base, status: "ok", value: worked.shown, series: trendOf(worked), start: startOf(worked), state: stateOf(worked, target), limit: targetOnScale(worked, target) };
}

/**
 * An area's reading of `metric`: the workspace metric of its name when the
 * reader can read one, else its own `metrics.csv`'s, else nothing.
 */
export function areaReading(metric: Metric | undefined, ws: WorkspaceMetrics | null, csv: Readings | undefined): AreaReading | undefined {
  if (metric === undefined) return undefined;
  const found = ws === null ? null : workspaceMetricFor(metric.name, ws.metrics);
  if (found !== null && ws !== null) return workspaceReading(found, ws, metric.target);
  const reading = readingFor(csv, metric);
  if (reading === undefined) return undefined;
  return {
    ...reading,
    from: "sheet",
    status: "ok",
    metricPath: null,
    inputs: "",
    when: "",
    period: "",
    state: targetState(reading, metric.target),
    limit: targetNumber(reading, metric.target),
  };
}

/* ------------------------------- picker ------------------------------- */

export interface MetricOption {
  readonly path: string;
  readonly name: string;
  /** "Stripe + Cloudflare · used by Finance". */
  readonly line: string;
  readonly series: readonly number[];
  /** "$9.40", "Hidden", "—", or "…" while it is worked out. */
  readonly shown: string;
  /** Another note before it has this name, so naming it would pick that one: it cannot be picked. */
  readonly duplicate: boolean;
}

/** The picker's rows: every metric note the reader can read, in the metrics folder's order. */
export function metricOptions(ws: WorkspaceMetrics): MetricOption[] {
  const seen = new Set<string>();
  return ws.metrics.map((metric) => {
    const view = metricView(metric, ws.worked.get(metric.path), ws.uses, ws.sources, ws.settled);
    const key = keyOf(metric.name);
    const duplicate = seen.has(key);
    seen.add(key);
    const used = usedByWords(ws.uses.get(key));
    const line = duplicate
      ? "Has the name of the metric above; rename it to pick it"
      : [view.inputs, used === null ? "" : `used by ${used}`].filter((part) => part !== "").join(" · ");
    return { path: metric.path, name: metric.name, line, series: view.series, shown: view.shown, duplicate };
  });
}

/** Whether `query` finds an option: its name or its line, any case. */
export function optionMatches(option: MetricOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || option.name.toLowerCase().includes(q) || option.line.toLowerCase().includes(q);
}

export type TargetMode = "over" | "under";

const UNDER = /^\s*(under|below|less than|at most|<=?|≤)\s*/i;
const OVER = /^\s*(over|above|more than|at least|>=?|≥)\s*/i;

/** A target as written, `under 30 min`, as the picker's two halves; a target in no direction reads as Over. */
export function splitTarget(target: string | null): { mode: TargetMode; value: string } {
  const said = directedTarget(target?.trim() ?? "");
  if (UNDER.test(said)) return { mode: "under", value: said.replace(UNDER, "").trim() };
  return { mode: "over", value: said.replace(OVER, "").trim() };
}

/** What Save writes after `target`: `over $5`, or null with no value. */
export function targetWords(mode: TargetMode, value: string): string | null {
  const v = value.trim().replace(OVER, "").replace(UNDER, "").trim();
  return v === "" ? null : `${mode} ${v}`;
}

/** The line under the target, as the board writes it. */
export function targetHint(mode: TargetMode, value: string): string {
  const words = targetWords(mode, value);
  return words === null ? "With no target, the value is drawn without a colour." : `Green when the latest value is ${words}.`;
}

/** The seat edit Save writes: the picked metric first, by its note's name, with its target; the rest of the seat as it was. */
export function pickedEdit(seat: Seat, name: string, mode: TargetMode, value: string): SeatEdit {
  return {
    owner: seat.ownOwner,
    delegate: seat.delegate,
    modes: seat.modes,
    metrics: [{ name: name.trim(), target: targetWords(mode, value) }, ...seat.metrics.slice(1)],
    approvals: seat.approvals,
  };
}

/** Where an area's reading comes from, said plainly for its panel. */
export function readingSource(metric: Metric | undefined, reading: AreaReading | undefined): string {
  if (metric === undefined) return "";
  if (reading?.from === "workspace") {
    const over = reading.inputs === "" ? "" : ` over ${reading.inputs}`;
    const hidden = reading.status === "hidden" ? " Hidden: a sheet it reads is missing or not shared with you." : "";
    return `Worked out as you read it from the workspace metric ${metric.name}${over}.${hidden}`;
  }
  return "Readings come from this area's metrics.csv: no workspace metric you can read has this name.";
}
