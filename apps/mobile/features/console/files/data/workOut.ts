/**
 * A metric worked out when it is read, and drawn: its formula as chips, its
 * latest value and recent periods, and how that value stands against the
 * target of the area that uses it (the data sources boards, 01 and 12).
 *
 * Worked out with the gateway's engine (`apps/mcp/src/data/formula`) over the
 * sheets the reader could read. A sheet the reader cannot see and one that is
 * not there read the same to the engine (`rowsOf` gives null for both), and
 * both are drawn "Hidden": a metric never tells anyone a sheet they cannot see
 * exists (`docs/decisions/data-and-metrics.md`).
 */

import { evaluate, formatValue, series as seriesOf } from "../../../../../mcp/src/data/formula/index.js";
import { leadingNumber, meetsTarget, targetNumber } from "../folderPage/areas/readings";
import type { MetricNote, FormulaTree } from "./metrics";
import type { SourceKind } from "./sources";

/** A parsed sheet, as `sheets/csv.js` reads one. */
export interface Sheet {
  readonly columns: readonly { readonly name: string; readonly type: string }[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/** A dataset's rows by `source`, `dataset`; null when it is missing or the reader cannot read it, which are one answer. */
export type RowsOf = (source: string, dataset: string) => Sheet | null;

export type ValueStatus = "ok" | "no_data" | "error" | "hidden";

export interface Value {
  readonly value: number | null;
  readonly status: ValueStatus;
  /** What went wrong, in plain words, for an error. */
  readonly note?: string;
}

export interface Period extends Value {
  readonly from: string;
  readonly to: string;
}

export interface Worked {
  readonly latest: Value;
  /** A right-now metric: its sheets have no dates, so its value is the rows as they stand, and past periods are what was kept. */
  readonly now: boolean;
  /** The last periods, oldest first, ending with the current one. */
  readonly periods: readonly Period[];
  /** The latest value as drawn: "$9.40", "Hidden", or "—". */
  readonly shown: string;
}

/** Shown for a value that has an input the reader cannot read, or that is not there. */
export const HIDDEN = "Hidden";
const NONE = "—";

function classify(result: { value: number | null; status: string; note?: string }): Value {
  // The engine says "can't read source/dataset" for a sheet that is missing and one held back alike.
  if (result.status === "error" && typeof result.note === "string" && result.note.startsWith("can't read ")) {
    return { value: null, status: "hidden" };
  }
  if (result.status === "ok" && typeof result.value === "number") return { value: result.value, status: "ok" };
  if (result.status === "no_data") return { value: null, status: "no_data" };
  return { value: null, status: "error", ...(result.note === undefined ? {} : { note: result.note }) };
}

export function shownValue(value: Value, format: string): string {
  if (value.status === "hidden") return HIDDEN;
  if (value.status !== "ok") return NONE;
  return formatValue(value.value, format === "" ? undefined : format) as string;
}

/**
 * A metric over `rowsOf`, its latest period and the `periods` before it, at `now`. `kept` is a right-now metric's
 * own sheet of hourly readings, which its past periods are drawn from.
 */
export function workOut(metric: MetricNote, rowsOf: RowsOf, now: number, periods = 7, kept: Sheet | null = null): Worked {
  if (!metric.parsed.ok) {
    const latest: Value = { value: null, status: "error", note: metric.parsed.message };
    return { latest, now: false, periods: [], shown: NONE };
  }
  const ctx = { rowsOf, every: metric.every, now, ...(kept === null ? {} : { kept }) };
  const evaluated = evaluate(metric.parsed.ast, ctx) as { value: number | null; status: string; note?: string; now?: boolean };
  const latest = classify(evaluated);
  const list = (seriesOf(metric.parsed.ast, ctx, periods) as (Period & { status: string })[]).map((each) => ({
    from: each.from,
    to: each.to,
    ...classify(each),
  }));
  return { latest, now: evaluated.now === true, periods: list, shown: shownValue(latest, metric.format) };
}

/** The numbers a trend draws: every period that has one. */
export function trendOf(worked: Worked): number[] {
  return worked.periods.filter((p) => p.status === "ok" && p.value !== null).map((p) => p.value as number);
}

export type TargetState = "met" | "missed" | "unknown";

/** How the latest value stands against an area's target (`over $5`, `under 30 min`), as the Areas page reads one. */
export function stateOf(worked: Worked, target: string | null): TargetState {
  if (worked.latest.status !== "ok" || target === null) return "unknown";
  const met = meetsTarget({ value: worked.shown, date: "", series: [] }, target);
  return met === null ? "unknown" : met ? "met" : "missed";
}

/**
 * A target on the scale the trend is drawn in: the raw values, not the shown
 * text, so `under 1%` sits at 0.01 under readings of 0.022 shown as "2.2%".
 */
export function targetOnScale(worked: Worked, target: string | null): number | null {
  if (target === null || worked.latest.status !== "ok" || worked.latest.value === null) return null;
  const shown = leadingNumber(worked.shown);
  const limit = targetNumber({ value: worked.shown, date: "", series: [] }, target);
  if (limit === null || shown === null || shown === 0) return limit;
  return limit * (worked.latest.value / shown);
}

/* ------------------------------- chips ------------------------------- */

export type Part =
  | { readonly t: "fn"; readonly text: string }
  | {
      readonly t: "chip";
      readonly kind: SourceKind;
      readonly source: string;
      readonly dataset: string | null;
      /** The column as drawn, which may leave off words just said (`removed` after `lines added`). */
      readonly column: string;
      /** The column's whole name, where the drawn one is shorter: for a screen reader and a hover. */
      readonly name?: string;
    }
  | { readonly t: "filter"; readonly text: string }
  | { readonly t: "op"; readonly text: string }
  | { readonly t: "num"; readonly text: string };

const SIGN: Readonly<Record<string, string>> = { "+": "+", "-": "−", "*": "×", "/": "÷" };
const PRECEDENCE: Readonly<Record<string, number>> = { "+": 1, "-": 1, "*": 2, "/": 2 };

function rowWords(node: FormulaTree): string {
  if (node.type === "ref") return node.column;
  if (node.type === "number") return String(node.value);
  if (node.type === "binary") return `${rowWords(node.left)} ${SIGN[node.op]} ${rowWords(node.right)}`;
  return "";
}

/**
 * A column's words without the leading words just said: `lines removed` after
 * `lines added` is "removed", `p95 ms` under `p95` is "ms". Never empty: a
 * column that is all repeated words keeps its last one.
 */
export function shortColumn(column: string, said: readonly string[]): string {
  const words = column.trim().split(/\s+/);
  let drop = 0;
  while (drop < words.length - 1 && said.some((w) => w.toLowerCase() === words[drop]!.toLowerCase())) drop += 1;
  return words.slice(drop).join(" ");
}

/** A span between two columns (`deployed − opened`): one quantity, so one chip. */
function isSpan(node: FormulaTree): boolean {
  return node.type === "binary" && node.op === "-" && node.left.type === "ref" && node.right.type === "ref";
}

/**
 * The formula as the board draws it: each aggregate's function in mono, then
 * a chip — the source's mark, the dataset (left off when the chip before
 * read the same one) and its column in bold — and the operators between. A
 * span (`deployed − opened`) is one chip; any other per-row sum is a chip per
 * column with its operators between (`lines added` + `removed`), each later
 * column without the words the one before it said. A `where` is a chip of
 * its own.
 */
export function formulaParts(ast: FormulaTree, kindOf: (source: string) => SourceKind): Part[] {
  const out: Part[] = [];
  let last: string | null = null;
  const walk = (node: FormulaTree, parent: number) => {
    if (node.type === "number") {
      out.push({ t: "num", text: String(node.value) });
      return;
    }
    if (node.type === "agg") {
      const here = `${node.source}/${node.dataset}`;
      out.push({ t: "fn", text: node.distinct === true ? `${node.fn} distinct` : node.fn });
      const kind = kindOf(node.source);
      let dataset: string | null = here === last ? null : node.dataset;
      let said: string[] = node.distinct === true ? [node.fn, "distinct"] : [node.fn];
      const chip = (column: string) => {
        const shown = shortColumn(column, said);
        out.push({ t: "chip", kind, source: node.source, dataset, column: shown, ...(shown === column ? {} : { name: column }) });
        said = column.trim().split(/\s+/);
        dataset = null;
      };
      const row = (expr: FormulaTree, parent: number) => {
        if (expr.type === "ref") chip(expr.column);
        else if (expr.type === "number") out.push({ t: "num", text: String(expr.value) });
        else if (expr.type === "binary" && isSpan(expr)) {
          out.push({ t: "chip", kind, source: node.source, dataset, column: rowWords(expr) });
          dataset = null;
        } else if (expr.type === "binary") {
          const p = PRECEDENCE[expr.op] ?? 1;
          if (p < parent) out.push({ t: "op", text: "(" });
          row(expr.left, p);
          out.push({ t: "op", text: SIGN[expr.op] ?? expr.op });
          row(expr.right, p + (expr.op === "-" || expr.op === "/" ? 1 : 0));
          if (p < parent) out.push({ t: "op", text: ")" });
        }
      };
      row(node.expr, 0);
      if (node.where.length > 0) {
        const words = node.where.map((c) => `${c.column} ${c.op === "=" ? "=" : "≠"} ${c.value}`).join(" and ");
        out.push({ t: "filter", text: `where ${words}` });
      }
      last = here;
      return;
    }
    if (node.type === "binary") {
      const p = PRECEDENCE[node.op] ?? 1;
      const wrap = p < parent;
      if (wrap) out.push({ t: "op", text: "(" });
      walk(node.left, p);
      out.push({ t: "op", text: SIGN[node.op] ?? node.op });
      walk(node.right, p + (node.op === "-" || node.op === "/" ? 1 : 0));
      if (wrap) out.push({ t: "op", text: ")" });
    }
  };
  walk(ast, 0);
  return out;
}

/** The datasets a formula reads, each once, as `source/dataset`. */
export function inputsOf(ast: FormulaTree): { source: string; dataset: string }[] {
  const seen = new Map<string, { source: string; dataset: string }>();
  const walk = (node: FormulaTree) => {
    if (node.type === "agg") {
      const key = `${node.source}/${node.dataset}`.toLowerCase();
      if (!seen.has(key)) seen.set(key, { source: node.source, dataset: node.dataset });
    } else if (node.type === "binary") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(ast);
  return [...seen.values()];
}

/** "Every month", "every 7 days": the period after the chips, as the board writes it ("7 days", "week"). */
export function periodWords(every: string): string {
  return every.trim().toLowerCase();
}
