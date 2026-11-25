/**
 * The rows a metric adds to the Data folder's `metrics/readings.csv`
 * (`date, metric, value`): closed periods only, each once (stage E of
 * `docs/decisions/data-and-metrics.md`). Pure.
 *
 * The caller decides whether a metric may be written at all: only one whose
 * every input is at least as visible as the `metrics/` folder, and `rowsOf`
 * reads sheets at that folder's own clearance, never an owner's. This module
 * only works out which periods have closed and what each one came to.
 *
 * - `day`, `week`, `month`: a period is closed once the next one has begun;
 *   its reading is dated the period's first day (a week's Monday, a month's
 *   1st).
 * - `N days` is rolling, so it has no periods of its own: it is read once a
 *   day, at UTC midnight, over the N days before it, and dated the last day
 *   it covers.
 * - A period that came to nothing (`no_data`) or could not be worked out is
 *   not written: a reading is a number someone can trust, and a gap says
 *   "nothing" better than a zero would. An error is returned so the run can
 *   name it.
 * - With nothing written yet, only the last closed period is written
 *   (`backfill` raises that, at most `MAX_BACKFILL`): whether connecting a
 *   source should fill in the past is still the owner's question.
 */

import { evaluate, series } from "../formula/evaluate.js";
import { MAX_WINDOWS, parseEvery } from "../formula/windows.js";
import { dateMs } from "../../sheets/csv.js";

export const MAX_BACKFILL = 399;
export const READINGS_COLUMNS = Object.freeze([
  Object.freeze({ name: "date", type: "date" }),
  Object.freeze({ name: "metric", type: "text" }),
  Object.freeze({ name: "value", type: "number" }),
]);
const DAY_MS = 86_400_000;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const midnight = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

/** The newest reading date already written for `metric` (names match lower-cased), as ms, or NaN. */
export function lastReading(rows, metric) {
  const want = String(metric ?? "").trim().toLowerCase();
  let last = Number.NaN;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.metric ?? "").trim().toLowerCase() !== want) continue;
    const t = dateMs(row.date);
    if (Number.isFinite(t) && !(t <= last)) last = t;
  }
  return last;
}

/**
 * → `{ rows: [{ date, metric, value }], errors: [{ date, note }] }`, oldest
 * first. `after` is the last date already written for this metric (ms or
 * NaN, `lastReading`).
 */
export function closedReadings({ metric, formula, every, rowsOf, on, now = Date.now(), after = Number.NaN, backfill = 1 }) {
  const period = parseEvery(every);
  const at = typeof now === "number" ? now : Date.parse(now);
  const out = { rows: [], errors: [] };
  if (!period || !Number.isFinite(at) || typeof metric !== "string" || metric.trim() === "") return out;
  const most = Math.max(1, Math.min(MAX_BACKFILL, Number.isInteger(backfill) ? backfill : 1));
  const keep = (date, result) => {
    if (Number.isFinite(after) && dateMs(date) <= after) return;
    if (result.status === "ok") out.rows.push({ date, metric: metric.trim(), value: String(Number(result.value.toPrecision(12))) });
    else if (result.status === "error") out.errors.push({ date, note: result.note });
  };

  if (period.unit === "days") {
    // One reading per UTC midnight since the last one, each over the N days before it.
    const today = midnight(at);
    const first = Number.isFinite(after) ? Math.max(after + 2 * DAY_MS, today - (MAX_BACKFILL - 1) * DAY_MS) : today - (most - 1) * DAY_MS;
    for (let m = first; m <= today; m += DAY_MS) keep(day(m - DAY_MS), evaluate(formula, { every, now: m, rowsOf, on }));
    return out;
  }

  // Calendar periods: the last window is the current, open one; every one before it is closed.
  // Only as many windows as can have closed since the last reading, so a daily run reads each sheet over a few windows, not 400.
  const shortest = { day: 1, week: 7, month: 28 }[period.unit];
  const since = Number.isFinite(after) ? Math.ceil((at - after) / (shortest * DAY_MS)) + 1 : most;
  const windows = series(formula, { every, now: at, rowsOf, on }, Math.min(MAX_WINDOWS, since + 1));
  if (!windows.length) {
    out.errors.push({ date: null, note: "the formula could not be read" });
    return out;
  }
  const closed = windows.slice(0, -1).slice(Number.isFinite(after) ? 0 : -most);
  for (const w of closed) keep(w.from.slice(0, 10), w);
  return out;
}
