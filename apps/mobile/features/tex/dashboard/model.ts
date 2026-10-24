/**
 * The Tex dashboard's words and arithmetic (tex.lc/admin, `./TexDashboard.web`),
 * over `texReport` (`apps/convex/functions/lib/adminFns/texReport.ts`).
 *
 * Pure: labels for the codes, the filters, the measures, the pivot the
 * Explore section draws, and the shapes of the page's charts. Every scored conversation arrives as a row of numbers
 * and codes that names nobody, so slicing happens here, on the page, by any
 * field (the owner, 2026-10-24: "slice by different metrics and see what tasks
 * people get frustrated with").
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { formatCount } from "../../admin/report";

export type TexReport = FunctionReturnType<typeof api.functions.admin.texReport>;
export type TexReview = TexReport["reviews"][number];

export const TEX_WINDOWS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
] as const;
export type TexWindow = (typeof TEX_WINDOWS)[number]["key"];

export const TASK_LABELS: Record<string, string> = {
  email: "Email",
  calendar: "Calendar",
  web_errand: "Web errands",
  notes: "Notes",
  research: "Research",
  reminders: "Reminders",
  messaging: "Messaging",
  purchase: "Buying and booking",
  setup: "Setup and sign-ins",
  chat: "Small talk",
  other: "Other",
};

export const SIGNAL_LABELS: Record<string, string> = {
  repeated: "Repeated themselves",
  try_again: "Said try again",
  cant_first: "Tex said can't first",
  gave_up: "Gave up",
  swore: "Swore or angry",
  corrected: "Corrected Tex",
  fix_this: "Said fix this",
};

export const KIND_LABELS: Record<string, string> = {
  one: "1:1 texts",
  group: "Group chats",
  job: "Background jobs",
  routine: "Routines",
  app: "In the app",
  older: "Before kinds were kept",
};

export const SCORE_LABELS = [
  { key: "goal", label: "Got them what they wanted" },
  { key: "independence", label: "Did it without handing back" },
  { key: "turns", label: "Few back-and-forths" },
  { key: "friendly", label: "Sounded like a friend" },
  { key: "calm", label: "They stayed calm" },
] as const;

// -- dimensions ------------------------------------------------------------

export const DIMENSIONS = [
  { key: "task", label: "Task" },
  { key: "chat", label: "Chat" },
  { key: "who", label: "Who" },
  { key: "model", label: "Model" },
  { key: "signal", label: "Frustration" },
  { key: "reason", label: "Review ran because" },
] as const;
export type Dimension = (typeof DIMENSIONS)[number]["key"];

const NONE = "—";

/** The values one row takes on a dimension: one, except frustration, where a row counts once per signal. */
export function valuesOf(row: TexReview, dimension: Dimension): string[] {
  switch (dimension) {
    case "task":
      return [row.task ?? NONE];
    case "chat":
      return [row.kind];
    case "who":
      return [row.who ?? NONE];
    case "model":
      return [row.thought === null ? NONE : row.thought ? "thought" : "main"];
    case "signal":
      return row.signals.length > 0 ? row.signals : ["none"];
    case "reason":
      return [row.reason];
  }
}

export function valueLabel(dimension: Dimension, value: string): string {
  if (value === NONE) return "Not tagged";
  switch (dimension) {
    case "task":
      return TASK_LABELS[value] ?? value;
    case "chat":
      return value === "group" ? "Group chat" : "1:1";
    case "who":
      return value === "staff" ? "Team" : value === "new" ? "New this week" : "Everyone else";
    case "model":
      return value === "thought" ? "Opus thought" : "Answered without thinking";
    case "signal":
      return value === "none" ? "No frustration" : (SIGNAL_LABELS[value] ?? value);
    case "reason":
      return value === "fix_this" ? "Said fix this" : value === "frustrated" ? "Frustrated" : "Ended";
  }
}

/** Every value a dimension takes in these rows, most common first. */
export function optionsOf(rows: readonly TexReview[], dimension: Dimension): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const value of valuesOf(row, dimension)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: valueLabel(dimension, value), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// -- filters ---------------------------------------------------------------

/** Per dimension, the values kept; a dimension absent or empty keeps everything. */
export type TexFilters = Partial<Record<Dimension, readonly string[]>>;

export function applyFilters(rows: readonly TexReview[], filters: TexFilters): TexReview[] {
  const active = (Object.entries(filters) as [Dimension, readonly string[]][]).filter(([, values]) => values.length > 0);
  return rows.filter((row) => active.every(([dimension, values]) => valuesOf(row, dimension).some((value) => values.includes(value))));
}

export function toggleFilter(filters: TexFilters, dimension: Dimension, value: string): TexFilters {
  const was = filters[dimension] ?? [];
  const next = was.includes(value) ? was.filter((v) => v !== value) : [...was, value];
  return { ...filters, [dimension]: next };
}

/** What a dropdown's button says: its name, the one value picked, or how many. */
export function filterButtonLabel(dimension: Dimension, picked: readonly string[]): string {
  const name = DIMENSIONS.find((d) => d.key === dimension)?.label ?? dimension;
  if (picked.length === 0) return `${name}: all`;
  if (picked.length === 1) return `${name}: ${valueLabel(dimension, picked[0])}`;
  return `${name}: ${picked.length} picked`;
}

// -- measures --------------------------------------------------------------

export const MEASURES = [
  { key: "frustrated", label: "Frustrated", worse: "higher" },
  { key: "count", label: "Conversations", worse: "none" },
  { key: "calm", label: "Calm score", worse: "lower" },
  { key: "goal", label: "Got what they wanted", worse: "lower" },
  { key: "independence", label: "No hand-backs", worse: "lower" },
  { key: "texts", label: "Texts to finish", worse: "higher" },
  { key: "cost", label: "Cost per conversation", worse: "higher" },
] as const;
export type Measure = (typeof MEASURES)[number]["key"];

/** A conversation counts as frustrating when any signal showed, or calm scored 4 or under. */
export function isFrustrated(row: TexReview): boolean {
  return row.signals.length > 0 || row.calm <= 4;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The measure over these rows, or null when none of them carries it. */
export function measureOf(rows: readonly TexReview[], measure: Measure): number | null {
  switch (measure) {
    case "count":
      return rows.length;
    case "frustrated":
      return rows.length === 0 ? null : rows.filter(isFrustrated).length / rows.length;
    case "calm":
    case "goal":
    case "independence":
      return mean(rows.map((row) => row[measure]));
    case "texts":
      return mean(rows.flatMap((row) => (row.texts === null ? [] : [row.texts])));
    case "cost":
      return mean(rows.flatMap((row) => (row.costMicroUsd === null ? [] : [row.costMicroUsd])));
  }
}

export function formatMeasure(measure: Measure, value: number | null): string {
  if (value === null) return "—";
  switch (measure) {
    case "count":
      return formatCount(value);
    case "frustrated":
      return `${Math.round(value * 100)}%`;
    case "texts":
    case "calm":
    case "goal":
    case "independence":
      return value.toFixed(1);
    case "cost":
      return formatMicroUsd(value);
  }
}

/** Millionths of a dollar, as a person reads money: cents under a dollar, a tenth of a cent under that. */
export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0";
  if (usd >= 100) return `$${Math.round(usd).toLocaleString("en-US")}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/** A model name as staff say it: the part after the provider. */
export function modelLabel(model: string): string {
  const name = model.slice(model.lastIndexOf("/") + 1);
  const short = name.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

// -- the pivot -------------------------------------------------------------

export interface PivotCell {
  n: number;
  value: number | null;
}

export interface Pivot {
  rows: { value: string; label: string }[];
  /** One column, "All", when there is no column dimension. */
  cols: { value: string; label: string }[];
  cells: PivotCell[][];
  /** Each row over every column. */
  totals: PivotCell[];
}

/**
 * Rows by columns, each cell the measure over the rows that take both values.
 * Rows sort worst first by their total, so the top of the table is where to
 * look; the columns keep their most-common-first order.
 */
export function pivot(rows: readonly TexReview[], rowDim: Dimension, colDim: Dimension | null, measure: Measure): Pivot {
  const rowValues = optionsOf(rows, rowDim);
  const colValues = colDim === null ? [{ value: "*", label: "All", count: rows.length }] : optionsOf(rows, colDim);
  const inRow = (value: string) => rows.filter((row) => valuesOf(row, rowDim).includes(value));
  const totals = rowValues.map(({ value }) => {
    const subset = inRow(value);
    return { n: subset.length, value: measureOf(subset, measure) };
  });
  const cells = rowValues.map(({ value }) => {
    const subset = inRow(value);
    return colValues.map((col) => {
      const inCell = colDim === null ? subset : subset.filter((row) => valuesOf(row, colDim).includes(col.value));
      return { n: inCell.length, value: measureOf(inCell, measure) };
    });
  });
  const worse = MEASURES.find((m) => m.key === measure)?.worse ?? "none";
  const order = rowValues.map((_, index) => index);
  if (worse !== "none") {
    const sign = worse === "higher" ? -1 : 1;
    order.sort((a, b) => sign * ((totals[a].value ?? (sign < 0 ? -Infinity : Infinity)) - (totals[b].value ?? (sign < 0 ? -Infinity : Infinity))));
  }
  return {
    rows: order.map((index) => ({ value: rowValues[index].value, label: rowValues[index].label })),
    cols: colValues.map(({ value, label }) => ({ value, label })),
    cells: order.map((index) => cells[index]),
    totals: order.map((index) => totals[index]),
  };
}

/**
 * How bad a cell is, 0 (best) to 1 (worst), against the other cells, for the
 * heat colour; null where there is nothing to compare or the measure has no
 * bad direction.
 */
export function heatOf(measure: Measure, value: number | null, all: readonly (number | null)[]): number | null {
  const worse = MEASURES.find((m) => m.key === measure)?.worse ?? "none";
  if (value === null || worse === "none") return null;
  const known = all.filter((v): v is number => v !== null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  if (max === min) return 0;
  const t = (value - min) / (max - min);
  return worse === "higher" ? t : 1 - t;
}

// -- the overview ----------------------------------------------------------

/** The texts people sent Tex: their own texts and group chats, not jobs or routines. */
export function textsHandled(report: TexReport): number {
  return report.turns.byKind.one + report.turns.byKind.group;
}

export function scoreAverages(rows: readonly TexReview[]): { key: string; label: string; value: number | null }[] {
  return SCORE_LABELS.map(({ key, label }) => ({ key, label, value: mean(rows.map((row) => row[key])) }));
}

/** Tasks ranked by how often they frustrate, with how many there were. */
export function frustrationByTask(rows: readonly TexReview[]): { task: string; label: string; n: number; share: number }[] {
  return optionsOf(rows, "task")
    .map(({ value, label, count }) => {
      const subset = rows.filter((row) => (row.task ?? NONE) === value);
      return { task: value, label, n: count, share: subset.filter(isFrustrated).length / count };
    })
    .sort((a, b) => b.share - a.share || b.n - a.n);
}

// -- the page's charts -----------------------------------------------------

/** A sparkline's line and the area under it, in a `w` by `h` box; flat at the bottom when everything is zero. */
export function sparkPaths(values: readonly number[], w = 120, h = 32): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const points = values.map((value, i) => [i * step, max > 0 ? h - (value / max) * (h - 2) - 1 : h - 1] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}

/** Per day of the window, oldest first: the share of that day's scored conversations that frustrated, or null with none. */
export function frustrationByDay(rows: readonly TexReview[], days: readonly string[]): (number | null)[] {
  return days.map((day) => {
    const those = rows.filter((row) => new Date(row.at).toISOString().slice(0, 10) === day);
    return those.length === 0 ? null : those.filter(isFrustrated).length / those.length;
  });
}

/** How often each frustration signal showed, most first. */
export function signalCounts(rows: readonly TexReview[]): { code: string; label: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const code of row.signals) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()].map(([code, n]) => ({ code, label: SIGNAL_LABELS[code] ?? code, n })).sort((a, b) => b.n - a.n);
}

export const TEXT_BUCKETS = ["1", "2", "3", "4", "5", "6+"] as const;

/** How many texts conversations took: the share in each bucket, the typical (median) and the average. */
export function textsToFinish(rows: readonly TexReview[]): { buckets: { label: string; share: number }[]; median: number | null; mean: number | null; n: number } {
  const texts = rows.flatMap((row) => (row.texts === null ? [] : [row.texts])).sort((a, b) => a - b);
  const counts = TEXT_BUCKETS.map(() => 0);
  for (const n of texts) counts[Math.min(n, 6) - 1] += 1;
  return {
    buckets: TEXT_BUCKETS.map((label, i) => ({ label, share: texts.length === 0 ? 0 : counts[i] / texts.length })),
    median: texts.length === 0 ? null : texts[Math.floor((texts.length - 1) / 2)],
    mean: mean(texts),
    n: texts.length,
  };
}

/** Average texts per conversation, by task, most first. */
export function textsByTask(rows: readonly TexReview[]): { label: string; n: number; texts: number }[] {
  return optionsOf(rows, "task")
    .map(({ value, label }) => {
      const subset = rows.filter((row) => (row.task ?? NONE) === value);
      return { label, n: subset.length, texts: measureOf(subset, "texts") };
    })
    .flatMap((row) => (row.texts === null ? [] : [{ label: row.label, n: row.n, texts: row.texts }]))
    .sort((a, b) => b.texts - a.texts);
}

export interface Attention {
  tone: "crit" | "warn";
  text: string;
}

/** What deserves a look, worst first: a frustrating task, a failing model or tool, a slow answer. */
export function needsALook(report: TexReport): Attention[] {
  const out: Attention[] = [];
  for (const row of frustrationByTask(report.reviews)) {
    if (row.n >= 3 && row.share >= 0.5) out.push({ tone: "crit", text: `${row.label}: ${Math.round(row.share * 100)}% of ${row.n} conversations frustrated people` });
  }
  for (const model of report.performance.models) {
    if (model.rounds >= 10 && model.failed / model.rounds >= 0.05) out.push({ tone: "crit", text: `${modelLabel(model.model)} failed ${Math.round((model.failed / model.rounds) * 100)}% of its rounds` });
    if (model.rounds >= 10 && model.cut / model.rounds >= 0.05) out.push({ tone: "warn", text: `${modelLabel(model.model)} ran out of room in ${Math.round((model.cut / model.rounds) * 100)}% of its rounds` });
  }
  for (const tool of report.turns.tools) {
    if (tool.calls >= 10 && tool.failed / tool.calls >= 0.2) out.push({ tone: "warn", text: `${tool.tool} failed ${Math.round((tool.failed / tool.calls) * 100)}% of ${tool.calls} calls` });
  }
  const stuck = report.turns.exhausted + report.turns.failed;
  if (report.turns.total >= 20 && stuck / report.turns.total >= 0.05) out.push({ tone: "warn", text: `${Math.round((stuck / report.turns.total) * 100)}% of turns got stuck or failed` });
  if (report.performance.time.p95 >= 60_000) out.push({ tone: "warn", text: `The slowest 1 in 20 answers took ${formatSeconds(report.performance.time.p95)} or more` });
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "crit" ? -1 : 1));
}

export function formatSeconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
