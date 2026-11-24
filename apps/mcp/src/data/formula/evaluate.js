/**
 * Working a metric formula out over dataset sheets.
 *
 * `evaluate(ast, ctx)` → `{ value, status, note? }`, status `ok`, `no_data`
 * (an aggregate other than count found nothing in the window) or `error`
 * (with a note in plain words). It never throws.
 *
 * ctx:
 * - `rowsOf(source, dataset)` → a parsed sheet `{ columns, rows }` (as
 *   `sheets/csv.js` reads it), or null. Null means missing **or** not visible
 *   to this reader, and the two read the same — "can't read source/dataset" —
 *   so a metric never tells anyone a sheet they cannot see exists. A rowsOf
 *   that throws or returns something else reads the same way too.
 * - `every`: the period (`windows.js`); `now`: the time (default: now).
 * - `on`: the date column that places a row in time; without it, each
 *   sheet's first date column does.
 *
 * Per row, a date minus a date is minutes; numbers follow csv.js (`$` and
 * commas dropped), a checkbox is 1 or 0, and a row whose cell is empty or not
 * a number is left out. `count(column)` counts the filled cells, and count
 * over arithmetic the rows it could be worked out for.
 * Dividing by zero, or a result too large to be a number, is an error.
 */

import { cellText, dateMs, typedValue } from "../../sheets/csv.js";
import { columnKey, parseFormula } from "./parse.js";
import { parseEvery, toMs, windowsMs } from "./windows.js";

class Stop {
  constructor(note) {
    this.note = note;
  }
}

const EMPTY = Symbol("empty");

const nameOf = (source, dataset) => `${source}/${dataset}`;

/** One reader's sheets for one evaluation (or a whole series): each asked for once. */
function sheetReader(rowsOf) {
  const cache = new Map();
  return (source, dataset) => {
    const key = `${source}\u0000${dataset}`;
    if (!cache.has(key)) {
      let sheet = null;
      try {
        const got = typeof rowsOf === "function" ? rowsOf(source, dataset) : null;
        if (got && Array.isArray(got.columns) && Array.isArray(got.rows)) sheet = prepare(got);
      } catch {
        sheet = null;
      }
      cache.set(key, sheet);
    }
    const sheet = cache.get(key);
    if (!sheet) throw new Stop(`can't read ${nameOf(source, dataset)}`);
    return sheet;
  };
}

function prepare(sheet) {
  const byKey = new Map();
  for (const column of sheet.columns) {
    if (!column || typeof column.name !== "string") continue;
    const key = columnKey(column.name);
    if (!byKey.has(key)) byKey.set(key, { name: column.name, type: typeof column.type === "string" ? column.type : "text" });
  }
  const firstDate = sheet.columns.find((c) => c && c.type === "date" && typeof c.name === "string") ?? null;
  return { byKey, firstDate: firstDate ? byKey.get(columnKey(firstDate.name)) : null, rows: sheet.rows };
}

function cell(row, column) {
  if (!row || typeof row !== "object" || !Object.hasOwn(row, column.name)) return "";
  return cellText(row[column.name]).trim();
}

function columnIn(sheet, name, where) {
  const column = sheet.byKey.get(columnKey(name));
  if (!column) throw new Stop(`no column "${name}" in ${where}`);
  return column;
}

/** A per-row value: `{ date: ms }`, a number, or EMPTY. */
function rowValue(node, row, columns) {
  switch (node.type) {
    case "number":
      return node.value;
    case "ref": {
      const column = columns.get(node);
      const text = cell(row, column);
      if (text === "") return EMPTY;
      if (column.type === "date") {
        const ms = dateMs(text);
        return Number.isNaN(ms) ? EMPTY : { date: ms, column: column.name };
      }
      if (column.type === "checkbox") return text === "true" ? 1 : text === "false" ? 0 : EMPTY;
      const n = typedValue("number", text);
      return typeof n === "number" && Number.isFinite(n) ? n : EMPTY;
    }
    case "binary": {
      const left = rowValue(node.left, row, columns);
      const right = rowValue(node.right, row, columns);
      if (left === EMPTY || right === EMPTY) return EMPTY;
      const leftDate = typeof left === "object";
      const rightDate = typeof right === "object";
      if (leftDate || rightDate) {
        if (node.op === "-" && leftDate && rightDate) return (left.date - right.date) / 60_000;
        const date = leftDate ? left.column : right.column;
        throw new Stop(`${date} is a date: subtract another date from it to get minutes`);
      }
      return arithmetic(node.op, left, right);
    }
    default:
      throw new Stop("the formula could not be read");
  }
}

function arithmetic(op, a, b) {
  if (op === "/" && b === 0) throw new Stop("divides by 0");
  const out = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : Number.NaN;
  if (!Number.isFinite(out)) throw new Stop("the result is too large to show");
  return out;
}

function percentile95(sorted) {
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

function aggregate(fn, values, count) {
  if (fn === "count") return count;
  if (!values.length) return null;
  let out;
  if (fn === "sum" || fn === "average") {
    let total = 0;
    for (const v of values) total += v;
    out = fn === "sum" ? total : total / values.length;
  } else if (fn === "min" || fn === "max") {
    out = values[0];
    for (const v of values) if (fn === "min" ? v < out : v > out) out = v;
  } else {
    const sorted = [...values].sort((a, b) => a - b);
    if (fn === "p95") out = percentile95(sorted);
    else {
      const mid = sorted.length >> 1;
      out = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
  if (!Number.isFinite(out)) throw new Stop("the result is too large to show");
  return out;
}

function refsIn(node, out = []) {
  if (node.type === "ref") out.push(node);
  else if (node.type === "binary") {
    refsIn(node.left, out);
    refsIn(node.right, out);
  }
  return out;
}

function evalAggregate(node, env) {
  const where = nameOf(node.source, node.dataset);
  const sheet = env.read(node.source, node.dataset);
  const placeBy = env.on ? columnIn(sheet, env.on, where) : sheet.firstDate;
  if (!placeBy) throw new Stop(`${where} has no date column to place its rows in time`);
  const columns = new Map(refsIn(node.expr).map((ref) => [ref, columnIn(sheet, ref.column, where)]));
  const conds = (node.where ?? []).map((cond) => ({ column: columnIn(sheet, cond.column, where), op: cond.op, value: String(cond.value) }));
  const values = [];
  let count = 0;
  const { from, to, current } = env.window;
  for (const row of sheet.rows) {
    const t = dateMs(cell(row, placeBy));
    if (Number.isNaN(t) || t < from || (current ? t > to : t >= to)) continue;
    if (!conds.every((c) => sameValue(cell(row, c.column), c.value) === (c.op === "="))) continue;
    // count(column) counts the filled cells, whatever they hold.
    if (node.fn === "count" && node.expr.type === "ref") {
      if (cell(row, columns.get(node.expr)) !== "") count += 1;
      continue;
    }
    const v = rowValue(node.expr, row, columns);
    if (v === EMPTY) continue;
    count += 1;
    if (node.fn === "count") continue;
    if (typeof v === "object") throw new Stop(`${v.column} is a date: subtract another date from it to get minutes`);
    values.push(v);
  }
  return aggregate(node.fn, values, count);
}

function sameValue(text, want) {
  if (text.toLowerCase() === want.trim().toLowerCase()) return true;
  const a = typedValue("number", text);
  const b = typedValue("number", want);
  return typeof a === "number" && typeof b === "number" && a === b;
}

/** number | null (no data); throws Stop for an error. Both sides are worked out, so an error is never hidden by no data. */
function evalNode(node, env) {
  if (!node || typeof node !== "object") throw new Stop("the formula could not be read");
  switch (node.type) {
    case "number":
      return node.value;
    case "agg":
      return evalAggregate(node, env);
    case "binary": {
      const left = evalNode(node.left, env);
      const right = evalNode(node.right, env);
      if (left === null || right === null) return null;
      return arithmetic(node.op, left, right);
    }
    default:
      throw new Stop("the formula could not be read");
  }
}

function inWindow(ast, env) {
  try {
    const value = evalNode(ast, env);
    if (value === null) return { value: null, status: "no_data" };
    if (!Number.isFinite(value)) return { value: null, status: "error", note: "the result is too large to show" };
    return { value, status: "ok" };
  } catch (err) {
    if (err instanceof Stop) return { value: null, status: "error", note: err.note };
    return { value: null, status: "error", note: "the formula could not be worked out" };
  }
}

function start(ast, ctx) {
  const tree = typeof ast === "string" ? parseFormula(ast) : { ok: true, ast };
  if (!tree.ok) return { fail: { value: null, status: "error", note: tree.error.message } };
  if (!parseEvery(ctx?.every)) return { fail: { value: null, status: "error", note: `"${ctx?.every}" isn't a period: use day, week, month or N days` } };
  const now = ctx.now === undefined ? Date.now() : toMs(ctx.now);
  if (!Number.isFinite(now)) return { fail: { value: null, status: "error", note: "the time to work it out at isn't a time" } };
  const on = typeof ctx.on === "string" && ctx.on.trim() ? ctx.on : null;
  return { ast: tree.ast, now, env: { read: sheetReader(ctx.rowsOf), on } };
}

/** The formula's value for the current window of `ctx.every`. */
export function evaluate(ast, ctx) {
  const run = start(ast, ctx);
  if (run.fail) return run.fail;
  const [window] = windowsMs(ctx.every, run.now, 1);
  if (!window) return { value: null, status: "error", note: "the time to work it out at isn't a time" };
  return inWindow(run.ast, { ...run.env, window });
}

/** The formula over the last `n` windows, oldest first: `[{ from, to, value, status, note? }]`. Each sheet is read once. */
export function series(ast, ctx, n) {
  const run = start(ast, ctx);
  if (run.fail) return [];
  return windowsMs(ctx.every, run.now, n).map((window) => ({
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    ...inWindow(run.ast, { ...run.env, window }),
  }));
}
