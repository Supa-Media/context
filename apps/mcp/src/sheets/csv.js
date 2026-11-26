/**
 * Sheets: a `.csv` file kept in a workspace like a note.
 *
 * The file is the whole truth. A column's type sits in its header after a
 * colon (`renews:date`), and a header with no known type after a colon is
 * plain text, so `time: 10:30` stays a column called `time: 10:30`. There is
 * no sidecar file: the owner rejected a YAML beside every CSV (2026-11-23).
 * Select options are the values already in the column. A multiselect cell
 * holds several options joined with ", " (as Notion and Airtable export them),
 * so one option never contains a comma.
 *
 * Pure and dependency-free: the gateway's fetch and write tools and the app's
 * grid import the same functions, so every surface reads a sheet the same way.
 * See docs/decisions/sheets.md. Which paths are sheets is the file-kinds
 * list's to say (`packages/shared/src/fileKinds.cjs`).
 */

import { isSheetPath as isSheetKind } from "../../../../packages/shared/src/fileKinds.cjs";

export const SHEET_EXTENSION = ".csv";
export const COLUMN_TYPES = Object.freeze(["text", "number", "usd", "date", "person", "select", "multiselect", "checkbox", "link"]);
/** A sheet past either bound is held back and named, never cut short. */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;
export const MAX_SHEET_ROWS = 50_000;

const TYPE_SET = new Set(COLUMN_TYPES);
// A day (`2026-11-24`) or a UTC instant (`2026-11-24T09:30Z`, seconds and milliseconds optional).
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z)?$/;

/**
 * A date cell's moment in milliseconds since the epoch, UTC, or NaN when it is
 * not a date. A day means its midnight. Parsed by hand rather than with
 * `Date.parse`, which rolls `2026-02-30` over into March. Instants written to
 * different precision (`T09:00Z`, `T09:00:30Z`) do not sort by their text, so
 * anything that orders dates orders by this.
 */
export function dateMs(value) {
  const m = DATE.exec(cellText(value).trim());
  if (!m) return Number.NaN;
  const [y, mo, d, h = "0", mi = "0", sec = "0", frac = "0"] = m.slice(1);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(sec);
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, minute, second, Number(frac.padEnd(3, "0")));
  const back = new Date(ms);
  if (back.getUTCFullYear() !== Number(y) || back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return Number.NaN;
  return ms;
}

export function isSheetPath(path) {
  return isSheetKind(path);
}

/** A column's layout after its type: `wrap` and a width in pixels, `w320`. */
const LAYOUT_WRAP = "wrap";
const LAYOUT_WIDTH = /^w(\d{1,4})$/;
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 2000;

/**
 * `renews:date` → { name: "renews", type: "date" }; `notes` → text.
 * A column's layout rides after its type, so every reader sees the same
 * sheet: `notes:text:wrap:w320` wraps and is 320 wide. Layout without a
 * known type before it is not layout: the whole cell stays the name.
 */
export function parseHeaderCell(cell) {
  const raw = String(cell ?? "").trim();
  const parts = raw.split(":");
  const layout = {};
  let end = parts.length;
  while (end > 2) {
    const token = parts[end - 1].trim().toLowerCase();
    const width = LAYOUT_WIDTH.exec(token);
    if (token === LAYOUT_WRAP && !layout.wrap) layout.wrap = true;
    else if (width && layout.width === undefined) layout.width = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Number(width[1])));
    else break;
    end -= 1;
  }
  if (end < parts.length) {
    const type = parts[end - 1].trim().toLowerCase();
    const name = parts.slice(0, end - 1).join(":").trim();
    if (TYPE_SET.has(type) && name) return { name, type, ...layout };
  }
  const at = raw.lastIndexOf(":");
  if (at > 0) {
    const type = raw.slice(at + 1).trim().toLowerCase();
    const name = raw.slice(0, at).trim();
    if (TYPE_SET.has(type) && name) return { name, type };
  }
  return { name: raw, type: "text" };
}

export function renderHeaderCell(column) {
  const layout = [column.wrap ? LAYOUT_WRAP : "", Number.isInteger(column.width) ? `w${column.width}` : ""].filter(Boolean);
  const type = column.type || "text";
  if (layout.length) return [column.name, type, ...layout].join(":");
  return type !== "text" ? `${column.name}:${type}` : column.name;
}

/** A column's wrap and width changed; every value and the rest of the header stay as they were. */
export function setColumnLayout(sheet, name, { wrap, width } = {}) {
  const column = findColumn(sheet, name);
  if (!column) return sheet;
  const next = { ...column };
  if (wrap !== undefined) { if (wrap) next.wrap = true; else delete next.wrap; }
  if (width !== undefined) {
    if (width === null) delete next.width;
    else next.width = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
  }
  return { columns: sheet.columns.map((c) => (c === column ? next : c)), rows: sheet.rows };
}

/** RFC 4180 records: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes. */
export function parseCsvRecords(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let unterminated = false;
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; continue; }
    if (ch === ",") { record.push(field); field = ""; continue; }
    if (ch === "\r" && src[i + 1] === "\n") continue;
    if (ch === "\n" || ch === "\r") {
      record.push(field);
      records.push({ line: recordLine, cells: record });
      record = []; field = ""; line += 1; recordLine = line;
      continue;
    }
    field += ch;
  }
  if (quoted) unterminated = true;
  if (field !== "" || record.length) {
    record.push(field);
    records.push({ line: recordLine, cells: record });
  }
  return { records, unterminated };
}

function quote(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The value as stored text: numbers plain, checkboxes `true`/`false`. */
export function cellText(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value == null) return "";
  return String(value);
}

/** Why a value does not fit its column's type, or "" when it does. An empty cell always fits. */
export function cellProblem(type, value) {
  const s = cellText(value).trim();
  if (s === "") return "";
  switch (type) {
    case "number":
    case "usd":
      return Number.isFinite(Number(s.replace(/[$,]/g, ""))) ? "" : "not a number";
    case "date":
      return Number.isNaN(dateMs(s)) ? "not a date (YYYY-MM-DD, or YYYY-MM-DDTHH:MMZ in UTC)" : "";
    case "checkbox":
      return s === "true" || s === "false" ? "" : "not true or false";
    case "link":
      return /^https?:\/\/\S+$/i.test(s) ? "" : "not a link (https://…)";
    default:
      return "";
  }
}

/** A cell's text as the value its type means: a number, a boolean, or the text. */
export function typedValue(type, value) {
  const s = cellText(value).trim();
  if (s === "" || cellProblem(type, s)) return s;
  if (type === "number" || type === "usd") return Number(s.replace(/[$,]/g, ""));
  if (type === "checkbox") return s === "true";
  return s;
}

/**
 * Text → { columns, rows, errors, tooLarge }. Rows are objects keyed by column
 * name with the cell's text. A row with the wrong number of cells is kept and
 * reported: the reader decides, and nothing is dropped.
 */
export function parseSheet(text) {
  const src = String(text ?? "");
  const errors = [];
  if (new TextEncoder().encode(src).byteLength > MAX_SHEET_BYTES) {
    return { columns: [], rows: [], errors: [{ line: 0, message: `sheet is over ${MAX_SHEET_BYTES} bytes` }], tooLarge: true };
  }
  const { records, unterminated } = parseCsvRecords(src);
  if (unterminated) errors.push({ line: records.at(-1)?.line ?? 1, message: "a quoted cell is never closed" });
  const nonEmpty = records.filter((r) => !(r.cells.length === 1 && r.cells[0] === ""));
  if (!nonEmpty.length) return { columns: [], rows: [], errors, tooLarge: false };
  const [head, ...body] = nonEmpty;
  if (body.length > MAX_SHEET_ROWS) {
    return { columns: [], rows: [], errors: [{ line: 0, message: `sheet has over ${MAX_SHEET_ROWS} rows` }], tooLarge: true };
  }
  const columns = head.cells.map(parseHeaderCell);
  const seen = new Set();
  columns.forEach((c, i) => {
    if (!c.name) { c.name = `column ${i + 1}`; errors.push({ line: head.line, message: `column ${i + 1} has no name` }); }
    const key = c.name.toLowerCase();
    // `lossy`: rows are keyed by name, so a rewrite of this text would drop one of the two columns.
    if (seen.has(key)) errors.push({ line: head.line, message: `two columns are called "${c.name}"`, lossy: true });
    seen.add(key);
  });
  const rows = body.map((r) => {
    if (r.cells.length !== columns.length) {
      // More cells than the header is `lossy`: a rewrite keeps only the header's width. Fewer is padded, and safe.
      errors.push({ line: r.line, message: `has ${r.cells.length} cells, the header has ${columns.length}`, ...(r.cells.length > columns.length ? { lossy: true } : {}) });
    }
    const row = {};
    columns.forEach((c, i) => { row[c.name] = r.cells[i] ?? ""; });
    return row;
  });
  return { columns, rows, errors, tooLarge: false };
}

export function serializeSheet({ columns, rows }) {
  const lines = [columns.map((c) => quote(renderHeaderCell(c))).join(",")];
  for (const row of rows) lines.push(columns.map((c) => quote(cellText(row[c.name]))).join(","));
  return `${lines.join("\n")}\n`;
}

/** A multiselect cell's options, in the order written: split on commas, trimmed, blanks and repeats dropped. */
export function splitOptions(value) {
  const out = [];
  for (const part of cellText(value).split(",")) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Options as a multiselect cell stores them. */
export function joinOptions(options) {
  return splitOptions((options ?? []).join(",")).join(", ");
}

/** Values already in a select or multiselect column, each option once, in first-seen order. */
export function selectOptions(sheet, name) {
  const out = [];
  const seen = new Set();
  const multi = findColumn(sheet, name)?.type === "multiselect";
  for (const row of sheet.rows) {
    const values = multi ? splitOptions(row[name]) : [cellText(row[name]).trim()];
    for (const v of values) if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/* ------------------------------- querying -------------------------------- */

export const FILTER_OPS = Object.freeze(["is", "is not", "has", "has no", "contains", ">", "<", ">=", "<=", "after", "before", "is empty", "is not empty"]);

function findColumn(sheet, name) {
  const key = String(name ?? "").trim().toLowerCase();
  return sheet.columns.find((c) => c.name.toLowerCase() === key) ?? null;
}

function compare(type, a, b) {
  if (type === "number" || type === "usd") {
    const x = typedValue(type, a); const y = typedValue(type, b);
    if (typeof x === "number" && typeof y === "number") return x - y;
  }
  if (type === "date") {
    const x = dateMs(a);
    const y = dateMs(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  }
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
}

function hasOption(column, value, want) {
  const options = column.type === "multiselect" ? splitOptions(value) : [value];
  return options.some((o) => o.toLowerCase() === want.toLowerCase());
}

/** A value as its column stores it: a number plain, a multiselect's options tidied, the rest trimmed. */
function storedText(type, text, problem) {
  if (text === "" || problem) return text;
  if (type === "usd" || type === "number") return String(typedValue(type, text));
  if (type === "multiselect") return joinOptions([text]);
  return text;
}

export function rowMatches(sheet, row, filter) {
  const column = findColumn(sheet, filter.column);
  if (!column) return false;
  const value = cellText(row[column.name]).trim();
  const want = cellText(filter.value).trim();
  switch (filter.op ?? "is") {
    case "is": return value.toLowerCase() === want.toLowerCase();
    case "is not": return value.toLowerCase() !== want.toLowerCase();
    case "contains": return value.toLowerCase().includes(want.toLowerCase());
    // One of the cell's options: a multiselect's, split on commas, or any other cell's whole value.
    case "has": return hasOption(column, value, want);
    case "has no": return !hasOption(column, value, want);
    case ">": case "after": return value !== "" && compare(column.type, value, want) > 0;
    case "<": case "before": return value !== "" && compare(column.type, value, want) < 0;
    case ">=": return value !== "" && compare(column.type, value, want) >= 0;
    case "<=": return value !== "" && compare(column.type, value, want) <= 0;
    case "is empty": return value === "";
    case "is not empty": return value !== "";
    default: return false;
  }
}

/** Every problem with a query, so a bad one is refused rather than answered wrongly. */
export function queryProblems(sheet, { where = [], sort, columns } = {}) {
  const problems = [];
  for (const f of where) {
    if (!findColumn(sheet, f.column)) problems.push(`no column "${f.column}"`);
    if (!FILTER_OPS.includes(f.op ?? "is")) problems.push(`unknown operator "${f.op}"; use one of ${FILTER_OPS.join(", ")}`);
  }
  if (sort && !findColumn(sheet, sort.column)) problems.push(`no column "${sort.column}" to sort by`);
  for (const name of columns ?? []) if (!findColumn(sheet, name)) problems.push(`no column "${name}"`);
  return problems;
}

/**
 * Filter, sort and trim. `last: n` keeps the final n rows after sorting (the
 * newest, in a sheet kept in date order); `limit` keeps the first n.
 * Each returned row carries `line`, its line in the file.
 */
export function querySheet(sheet, { where = [], sort, last, limit, columns } = {}) {
  let rows = sheet.rows.map((row, index) => ({ row, line: index + 2 }));
  for (const f of where) rows = rows.filter(({ row }) => rowMatches(sheet, row, f));
  if (sort) {
    const column = findColumn(sheet, sort.column);
    const dir = sort.direction === "desc" ? -1 : 1;
    if (column) rows.sort((a, b) => compare(column.type, a.row[column.name], b.row[column.name]) * dir || a.line - b.line);
  }
  const total = rows.length;
  if (Number.isInteger(last) && last >= 0) rows = rows.slice(Math.max(0, rows.length - last));
  if (Number.isInteger(limit) && limit >= 0) rows = rows.slice(0, limit);
  const keep = columns?.length ? columns.map((n) => findColumn(sheet, n)).filter(Boolean) : sheet.columns;
  return {
    columns: keep,
    total,
    rows: rows.map(({ row, line }) => ({ line, ...Object.fromEntries(keep.map((c) => [c.name, row[c.name] ?? ""])) })),
  };
}

/** The newest row for each value of `groupBy`, by `dateColumn` (ties: later line wins). */
export function latestByGroup(sheet, { groupBy, dateColumn }) {
  const group = findColumn(sheet, groupBy);
  const date = findColumn(sheet, dateColumn);
  const out = new Map();
  if (!group || !date) return out;
  for (const row of sheet.rows) {
    const key = cellText(row[group.name]).trim();
    if (!key) continue;
    const current = out.get(key);
    if (!current || compare(date.type, row[date.name], current[date.name]) >= 0) out.set(key, row);
  }
  return out;
}

/* -------------------------------- changing -------------------------------- */

function normaliseRow(sheet, input, errors, where) {
  const row = {};
  const unknown = Object.keys(input ?? {}).filter((k) => !findColumn(sheet, k));
  if (unknown.length) errors.push(`${where}: no column ${unknown.map((k) => `"${k}"`).join(", ")}`);
  for (const c of sheet.columns) {
    const key = Object.keys(input ?? {}).find((k) => k.toLowerCase() === c.name.toLowerCase());
    const text = key === undefined ? "" : cellText(input[key]).trim();
    const problem = cellProblem(c.type, text);
    if (problem) errors.push(`${where}: ${c.name} "${text}" is ${problem}`);
    row[c.name] = storedText(c.type, text, problem);
  }
  return row;
}

function matchesAll(sheet, row, match) {
  return Object.entries(match ?? {}).every(([k, v]) => rowMatches(sheet, row, { column: k, op: "is", value: v }));
}

/**
 * Append, update and delete rows, all or nothing: any problem returns the
 * errors and leaves the sheet as it was. An update or delete must name at
 * least one column to match, so "every row" is never the accidental target.
 */
export function changeRows(sheet, { append = [], update, delete: remove } = {}) {
  const errors = [];
  const next = { columns: sheet.columns, rows: sheet.rows.map((r) => ({ ...r })) };
  let updated = 0;
  let deleted = 0;
  if (update) {
    if (!update.match || !Object.keys(update.match).length) errors.push("update needs match: { column: value }");
    else {
      const set = normaliseRowPartial(next, update.set ?? {}, errors);
      next.rows.forEach((row) => { if (matchesAll(next, row, update.match)) { Object.assign(row, set); updated += 1; } });
    }
  }
  if (remove) {
    if (!remove.match || !Object.keys(remove.match).length) errors.push("delete needs match: { column: value }");
    else {
      const before = next.rows.length;
      next.rows = next.rows.filter((row) => !matchesAll(next, row, remove.match));
      deleted = before - next.rows.length;
    }
  }
  append.forEach((input, i) => next.rows.push(normaliseRow(next, input, errors, `row ${i + 1}`)));
  if (next.rows.length > MAX_SHEET_ROWS) errors.push(`a sheet holds at most ${MAX_SHEET_ROWS} rows`);
  if (errors.length) return { ok: false, errors, sheet };
  return { ok: true, errors: [], sheet: next, appended: append.length, updated, deleted };
}

function normaliseRowPartial(sheet, set, errors) {
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    const c = findColumn(sheet, k);
    if (!c) { errors.push(`set: no column "${k}"`); continue; }
    const text = cellText(v).trim();
    const problem = cellProblem(c.type, text);
    if (problem) errors.push(`set: ${c.name} "${text}" is ${problem}`);
    out[c.name] = c.type === "multiselect" ? storedText(c.type, text, problem) : text;
  }
  return out;
}

/* ------------------------------ column changes ----------------------------- */

function uniqueName(sheet, wanted) {
  let name = wanted.trim() || "column";
  let n = 2;
  while (findColumn(sheet, name)) name = `${wanted.trim() || "column"} ${n++}`;
  return name;
}

export function addColumn(sheet, { name = "column", type = "text", at } = {}) {
  const column = { name: uniqueName(sheet, name.replace(/[,:\r\n"]/g, " ")), type: TYPE_SET.has(type) ? type : "text" };
  const columns = [...sheet.columns];
  columns.splice(Number.isInteger(at) ? Math.max(0, Math.min(at, columns.length)) : columns.length, 0, column);
  return { columns, rows: sheet.rows.map((r) => ({ ...r, [column.name]: "" })), column };
}

export function renameColumn(sheet, from, to) {
  const column = findColumn(sheet, from);
  const clean = String(to ?? "").replace(/[,:\r\n"]/g, " ").trim();
  if (!column || !clean || clean === column.name) return sheet;
  if (findColumn(sheet, clean) && clean.toLowerCase() !== column.name.toLowerCase()) return sheet;
  return {
    columns: sheet.columns.map((c) => (c === column ? { ...c, name: clean } : c)),
    rows: sheet.rows.map((r) => {
      const out = {};
      for (const c of sheet.columns) out[c === column ? clean : c.name] = r[c.name];
      return out;
    }),
  };
}

/** Changing a type never rewrites a value: one that no longer fits is kept and reported. */
export function setColumnType(sheet, name, type) {
  const column = findColumn(sheet, name);
  if (!column || !TYPE_SET.has(type)) return { sheet, misfits: 0 };
  const next = { columns: sheet.columns.map((c) => (c === column ? { ...c, type } : c)), rows: sheet.rows };
  const misfits = sheet.rows.filter((r) => cellProblem(type, r[column.name])).length;
  return { sheet: next, misfits };
}

export function deleteColumn(sheet, name) {
  const column = findColumn(sheet, name);
  if (!column) return sheet;
  return {
    columns: sheet.columns.filter((c) => c !== column),
    rows: sheet.rows.map((r) => { const out = { ...r }; delete out[column.name]; return out; }),
  };
}

export function moveColumn(sheet, name, to) {
  const column = findColumn(sheet, name);
  if (!column) return sheet;
  const columns = sheet.columns.filter((c) => c !== column);
  columns.splice(Math.max(0, Math.min(to, columns.length)), 0, column);
  return { columns, rows: sheet.rows };
}

/** A new, empty sheet's text. */
export function newSheetText(columns = [{ name: "name", type: "text" }, { name: "notes", type: "text" }]) {
  return serializeSheet({ columns, rows: [] });
}
