/**
 * THE ROUTER'S MARGIN AND CUTOFF SWEEP (`setsRun.mjs` writes its lines after a run that asked the router; `doorTools.js`
 * `routeTrusted` decides each point). Rows are router rows `{ chat, at, want, route: { pick, sure, probs }, ran }`: a row
 * with `ran: false` or no `want` is not scored. Pure: no I/O, so a log or a test reads the same numbers.
 */

import { routeTrusted } from "../src/agent/doorTools.js";

const MARGINS = Object.freeze([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]);
const FLOORS = Object.freeze([0, 0.4, 0.5, 0.6]);
const CUTS = Object.freeze([0.4, 0.5, 0.6]);

/** The rows a sweep scores: ran, and carrying the labelled route. */
const scored = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.ran !== false && typeof r.want === "string");

/** Counts for the rows a rule routes: `{ total, routed, right, coverage, accuracy }` (accuracy null when none routed). */
function tally(rows, routes) {
  const usable = scored(rows);
  let routed = 0;
  let right = 0;
  for (const row of usable) {
    if (!routes(row.route ?? {})) continue;
    routed += 1;
    if (row.route?.pick === row.want) right += 1;
  }
  const total = usable.length;
  return { total, routed, right, coverage: total === 0 ? null : routed / total, accuracy: routed === 0 ? null : right / routed };
}

/** Each (margin, floor) point of the margin rule: `{ margin, floor, total, routed, right, coverage, accuracy }`. */
export function marginSweep(rows, { margins = MARGINS, floors = FLOORS } = {}) {
  const points = [];
  for (const margin of margins) {
    for (const floor of floors) {
      points.push({ margin, floor, ...tally(rows, (read) => routeTrusted({ route: read.pick, sure: read.sure, probs: read.probs }, { margin, floor })) });
    }
  }
  return points;
}

/** Each cutoff of the flat rule (`sure >= cut`): `{ cut, total, routed, right, coverage, accuracy }`. */
export function cutSweep(rows, cuts = CUTS) {
  return cuts.map((cut) => ({ cut, ...tally(rows, (read) => typeof read.pick === "string" && typeof read.sure === "number" && read.sure >= cut) }));
}

const pct = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const fixed = (value, digits) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-");
const probsText = (probs) => (probs && typeof probs === "object" ? Object.entries(probs).map(([key, value]) => `${key}:${fixed(value, 3)}`).join(",") : "-");
const summary = (point) => `routed ${point.routed}/${point.total} (${pct(point.coverage)}), right ${point.right}/${point.routed} (${pct(point.accuracy)})`;

/** Log lines: one per scored row, then each cutoff and each margin point. */
export function sweepLines(rows) {
  const lines = scored(rows).map((row) => `route row ${row.chat}#${row.at} want=${row.want} pick=${row.route?.pick ?? "none"} sure=${fixed(row.route?.sure, 3)} probs=${probsText(row.route?.probs)}`);
  for (const point of cutSweep(rows)) lines.push(`route cut ${point.cut.toFixed(2)}: ${summary(point)}`);
  for (const point of marginSweep(rows)) lines.push(`route margin ${point.margin.toFixed(2)} floor ${point.floor.toFixed(2)}: ${summary(point)}`);
  return lines;
}
