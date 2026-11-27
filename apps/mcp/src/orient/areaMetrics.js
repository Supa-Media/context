/**
 * An area's metric worked out for the reader, so a bot told to move it knows where it stands without researching it
 * (Seyi, 2026-11-26, the area routines backlog: every routine push carries "the metric's name, target, definition path
 * and current computed value plus recent readings (Context computes them; bots can't over MCP)").
 *
 * Worked out with the same engine as the app (`../data/formula`), over the sheets **this connection** may read: a sheet
 * it cannot see and one that is not there both read as "can't read", and the value says "hidden", so a metric never
 * tells anyone a sheet they cannot see exists (`docs/decisions/data-and-metrics.md`). The metric's own note must be
 * visible too, or the metric is "not found", whatever it is called.
 */

import { evaluate, formatValue, parseFormula, plainReading, series } from "../data/formula/index.js";
import { linkedSheets } from "../data/sheetLinks.js";
import { canSee } from "../privacy/engine.js";
import { parseSheet } from "../sheets/csv.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { factProps } from "../tree/facts.js";
import { isNotePath, withoutTextExtension } from "../../../../packages/shared/src/fileKinds.cjs";

/** Periods a reading lists, the current one last. */
const PERIODS_SHOWN = 6;
/** Sheets one metric may read: a formula names a few. */
const MAX_SHEETS = 12;

const word = (value) => (typeof value === "string" ? value.trim() : Array.isArray(value) ? String(value[0] ?? "").trim() : "");

/** `Monthly cost · target under $600` → `{name: "Monthly cost", target: "under $600"}`. */
export function metricOfLine(line) {
  const text = word(line);
  if (text === "") return null;
  const match = /^(.*?)\s*·\s*target\s+(.+)$/i.exec(text);
  return match ? { name: match[1].trim(), target: match[2].trim() } : { name: text, target: null };
}

/** The metric note this connection sees whose `metric:` (or file name) is `name`: `{path, properties}` or null. */
async function metricNote(store, entries, dataFolder, name) {
  const prefix = `${dataFolder}/metrics/`;
  const paths = entries.map(({ key }) => key).filter((key) => key.startsWith(prefix) && isNotePath(key) && !key.slice(prefix.length).includes("/"));
  if (paths.length === 0) return null;
  const props = await factProps(store, paths);
  const wanted = name.toLowerCase();
  const slug = wanted.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const path of paths) {
    const properties = props?.get(path)?.props?.properties ?? {};
    const file = withoutTextExtension(path.slice(prefix.length)).toLowerCase();
    if (word(properties.metric).toLowerCase() === wanted || (word(properties.metric) === "" && file === slug)) return { path, properties };
  }
  return null;
}

/** A sheet's rows as this connection reads them, or null (missing and unseen alike). */
async function sheetAt(store, scope, rules, overrides, path) {
  if (!canSee(path, scope, rules, overrides)) return null;
  try {
    const object = await getWithLegacyFallback(store, path);
    if (!object) return null;
    const text = typeof object.text === "function" ? await object.text() : new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
    const sheet = parseSheet(text);
    return sheet.tooLarge ? null : { columns: sheet.columns, rows: sheet.rows };
  } catch {
    return null;
  }
}

/** A value as said: "$412.00", "hidden" (a sheet this connection can't read), "no data" or "can't be worked out". */
function said(result, format) {
  if (result.status === "ok" && typeof result.value === "number") return formatValue(result.value, format || undefined);
  if (result.status === "error" && String(result.note ?? "").startsWith("can't read ")) return "hidden";
  if (result.status === "no_data") return "no data";
  return `can't be worked out${result.note ? ` (${result.note})` : ""}`;
}

/**
 * The area's metric for this connection: `{name, target, path, reading, every, now, recent}`, or `{name, target,
 * missing: true}` when no metric note it can see has that name. `now` and each of `recent` are words.
 */
export async function metricReading(store, scope, rules, overrides, entries, dataFolder, line, at = Date.now()) {
  const metric = metricOfLine(line);
  if (metric === null) return null;
  const note = dataFolder ? await metricNote(store, entries, dataFolder, metric.name) : null;
  if (note === null) return { ...metric, missing: true };
  const formula = word(note.properties.formula);
  const every = word(note.properties.every) || "week";
  const format = word(note.properties.format);
  const parsed = parseFormula(formula);
  if (!parsed.ok) return { ...metric, path: note.path, every, now: `can't be worked out (${parsed.error?.message ?? "the formula can't be read"})`, recent: [] };

  // Each input read once, as the app reads it: `<data>/<source>/<dataset>.csv`, or a sheet its source's about links.
  const sheets = new Map();
  const linksOf = new Map();
  const wanted = [];
  const walk = (node) => {
    if (node?.type === "agg") wanted.push({ source: node.source, dataset: node.dataset });
    else if (node?.type === "binary") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(parsed.ast);
  for (const { source, dataset } of wanted.slice(0, MAX_SHEETS)) {
    const key = `${source}\u0000${dataset}`.toLowerCase();
    if (sheets.has(key)) continue;
    if (!linksOf.has(source)) {
      const about = `${dataFolder}/${source}/about.md`;
      const props = canSee(about, scope, rules, overrides) ? (await factProps(store, [about]))?.get(about)?.props?.properties : null;
      linksOf.set(source, linkedSheets(props ?? {}));
    }
    const linked = linksOf.get(source).find((each) => each.name.toLowerCase() === String(dataset).toLowerCase());
    sheets.set(key, await sheetAt(store, scope, rules, overrides, linked ? linked.path : `${dataFolder}/${source}/${dataset}.csv`));
  }
  const kept = await sheetAt(store, scope, rules, overrides, `${withoutTextExtension(note.path)}.csv`);
  const ctx = { rowsOf: (source, dataset) => sheets.get(`${source}\u0000${dataset}`.toLowerCase()) ?? null, every, now: at, ...(kept ? { kept } : {}) };
  const latest = evaluate(parsed.ast, ctx);
  const recent = series(parsed.ast, ctx, PERIODS_SHOWN)
    .slice(0, -1)
    .map((period) => `${period.from.slice(0, 10)}: ${said(period, format)}`);
  return { ...metric, path: note.path, every, reading: plainReading(parsed.ast, every), now: said(latest, format), recent };
}

/** The lines a brief or `orient { area }` says for one reading. */
export function readingLines(reading, { indent = "" } = {}) {
  if (reading === null) return [`${indent}- Metric: none set`];
  const head = `${indent}- Metric: ${reading.name}${reading.target ? ` · target ${reading.target}` : " (no target set)"}`;
  if (reading.missing) return [head, `${indent}  - No metric note this connection can see is called "${reading.name}": its definition is a note in the data folder's metrics/.`];
  const lines = [head, `${indent}  - Now (this ${reading.every}): ${reading.now}`, `${indent}  - Defined in ${reading.path}${reading.reading ? `: ${reading.reading}` : ""}`];
  if (reading.recent?.length) lines.push(`${indent}  - Before: ${reading.recent.join(", ")}`);
  return lines;
}
