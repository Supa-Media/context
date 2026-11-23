/**
 * `read_sheet`: a `.csv` sheet's rows as a typed table, through `fetch`.
 *
 * A sheet is a CSV whose header carries each column's type (`sheets/csv.js`),
 * so its rows come back as a table a model can filter, sort and count. `read_file`
 * turns a CSV into words instead; `fetch` routes a `.csv` path here (`translateFetch`).
 *
 * The refusals follow `read_file`'s rule (`readFile.js`): the existence probe
 * runs for every caller, the bytes are fetched only once `canSee` and the probe
 * have both passed, and a hidden sheet and a missing one get the same "not found".
 *
 * What comes back is marked untrusted, as a file's words are: whoever wrote the
 * sheet wrote its cells, so they are a quotation, never an instruction.
 */

import { effectiveVisibility, canSee } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { toolError, toolText } from "./results.js";
import { QUOTATION } from "./readFile.js";
import { MAX_SHEET_BYTES, isSheetPath, parseSheet, queryProblems, querySheet } from "../sheets/csv.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_PROBLEMS = 5;
const HINT = "To add rows, write with action rows, args { path, append: [{...}] }.";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const columnText = (column) => `${column.name}:${column.type}`;

/** The query's shape, checked before the sheet is looked at: nothing here depends on the sheet's content. */
function queryArgs(args) {
  const { where = [], sort, last, limit = DEFAULT_LIMIT, columns } = args;
  if (!Array.isArray(where) || where.some((f) => !isObject(f) || typeof f.column !== "string")) {
    return { error: 'where is a list of { column, op, value }, with the column\'s name in each' };
  }
  if (sort !== undefined && (!isObject(sort) || typeof sort.column !== "string" || (sort.direction !== undefined && sort.direction !== "asc" && sort.direction !== "desc"))) {
    return { error: 'sort is { column, direction }, with the column\'s name and direction "asc" or "desc"' };
  }
  if (last !== undefined && (!Number.isInteger(last) || last < 0)) return { error: "last is a whole number of rows: the final n rows" };
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) return { error: `limit is a whole number of rows from 0 to ${MAX_LIMIT}` };
  if (columns !== undefined && (!Array.isArray(columns) || columns.some((c) => typeof c !== "string"))) {
    return { error: "columns is a list of column names" };
  }
  return { query: { where, sort, last, limit, columns } };
}

export async function toolReadSheet(store, scope, rules, overrides, args = {}) {
  const path = normalizePath(args.path);
  if (!path) return toolError("invalid path");
  if (!isSheetPath(path)) return toolError("read_sheet opens a .csv sheet; pass a note to read_note, or another file to read_file instead");
  const parsed = queryArgs(args);
  if (parsed.error) return toolError(parsed.error);

  const seen = canSee(path, scope, rules, overrides);
  const present = Boolean(await probeWithLegacyFallback(store, path));
  const obj = seen && present ? await getWithLegacyFallback(store, path) : null;
  if (!seen || !present || !obj) return toolError("not found");

  const declared = Number.isFinite(obj.size) ? obj.size : 0;
  if (declared > MAX_SHEET_BYTES) return tooLarge(path, `this sheet is ${megabytes(declared)}, over the ${megabytes(MAX_SHEET_BYTES)} a sheet is read at`);
  const sheet = parseSheet(new TextDecoder().decode(new Uint8Array(await obj.arrayBuffer())));
  if (sheet.tooLarge) return tooLarge(path, sheet.errors[0]?.message ?? "this sheet is too big");

  const problems = queryProblems(sheet, parsed.query);
  if (problems.length) {
    return toolError(`read_sheet refused: ${problems.join("; ")}. The columns are ${sheet.columns.map(columnText).join(", ")}`);
  }
  // A row is an object keyed by column name with its `line` added, so a column called `line` would be overwritten: refused, not shown wrong.
  if (sheet.columns.some((c) => c.name.toLowerCase() === "line")) {
    return toolError(`${path} has a column called line, which the line numbers read_sheet shows would overwrite. Tell the person to rename it`);
  }

  const { columns, total, rows } = querySheet(sheet, parsed.query);
  const head = [
    `path: ${path}`,
    `visibility: ${effectiveVisibility(path, rules, overrides)}`,
    "kind: sheet",
    `etag: ${obj.etag}`,
    `rows: ${rows.length} of ${total} matching (${sheet.rows.length} in the sheet)`,
    `columns: ${sheet.columns.map(columnText).join(", ")}`,
    "trust: untrusted",
    "",
    QUOTATION,
  ];
  const problemLines = sheet.errors.slice(0, MAX_PROBLEMS).map((e) => `problem: line ${e.line}: ${e.message}`);
  if (sheet.errors.length > MAX_PROBLEMS) problemLines.push(`and ${sheet.errors.length - MAX_PROBLEMS} more problems`);
  const parts = [...head, "", ...(problemLines.length ? [...problemLines, ""] : []), table(columns, rows), "", HINT];
  return toolText(parts.join("\n"));
}

/** A Markdown table: the file's line first, then the shown columns; `|` and line breaks inside a cell are escaped. */
function table(columns, rows) {
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
  const out = [
    `| ${["line", ...columns.map(columnText)].map(cell).join(" | ")} |`,
    `| ${["line", ...columns].map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) out.push(`| ${[row.line, ...columns.map((c) => row[c.name])].map(cell).join(" | ")} |`);
  return out.join("\n");
}

const megabytes = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

function tooLarge(path, detail) {
  return toolError(`${detail}: ${path}. Tell the person it is too big to read here`);
}
