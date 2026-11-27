/**
 * Tex in a sheet cell's comment thread (Dev, 2026-11-27: "should be able to comment and @tex on a csv cell", and
 * "make sure that the tex in these comments can make changes to the whole page"). The same headless run as Tex in a
 * note (`noteRun.js`), told which cell the thread is on and shown the sheet as a numbered table, and able to change
 * any cell, add rows and delete rows, not only the cell it was asked from.
 *
 * As in a note, the run only reads: it answers with the changes as data, and the app applies them to the sheet it has
 * open, through the grid's own save, as one step ⌘Z takes back. The gateway never writes the sheet.
 *
 * Rows are numbered as the file holds them, from 1, the way the grid numbers them before a sort or a filter. The
 * comments column (`cellComments.cjs`) is conversation about the cells, so the model is never shown it and can never
 * change it.
 */

import { isCommentsColumn, parseSheet } from "../../../../apps/mcp/src/sheets/csv.js";

/** The most of the sheet's table the model is shown, in characters. */
export const RUN_SHEET_CHARS = 24_000;
/** The most of each kind of change one run may make. */
export const MAX_CELL_CHANGES = 500;
export const MAX_APPENDED_ROWS = 200;
export const MAX_DELETED_ROWS = 200;
const MAX_VALUE_CHARS = 20_000;
const MAX_COLUMN_CHARS = 200;

const str = (value) => (typeof value === "string" ? value : "");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const cell = (value) => str(value).replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");

/** The cell a thread is on, as the route checked it: `{ row, column }`, row counted from 0 in the file. */
export function isSheetCell(value) {
  return isObject(value) && Number.isInteger(value.row) && value.row >= 0 && typeof value.column === "string" && value.column.length > 0 && value.column.length <= MAX_COLUMN_CHARS;
}

/**
 * The sheet as the model reads it: a Markdown table numbered from 1 with each column's type, without the comments
 * column, cut at `RUN_SHEET_CHARS` with a line saying how many rows were left out.
 */
export function sheetTable(text) {
  const sheet = parseSheet(text);
  const columns = sheet.columns.filter((column) => !isCommentsColumn(column));
  if (columns.length === 0) return { table: "(no columns)", rows: 0, columns: [] };
  const lines = [`| row | ${columns.map((c) => cell(`${c.name} (${c.type})`)).join(" | ")} |`, `| --- | ${columns.map(() => "---").join(" | ")} |`];
  let size = lines.join("\n").length;
  let shown = 0;
  for (const [index, row] of sheet.rows.entries()) {
    const line = `| ${index + 1} | ${columns.map((c) => cell(row[c.name])).join(" | ")} |`;
    if (size + line.length + 1 > RUN_SHEET_CHARS) break;
    lines.push(line);
    size += line.length + 1;
    shown += 1;
  }
  if (shown < sheet.rows.length) lines.push(`(${sheet.rows.length - shown} rows cut)`);
  return { table: lines.join("\n"), rows: sheet.rows.length, columns: columns.map((c) => c.name) };
}

/** The thread's cell in words: its column, its row and what it holds now. */
export function cellWords(text, target) {
  const sheet = parseSheet(text);
  const row = sheet.rows[target.row];
  const value = row === undefined ? "" : str(row[target.column]);
  return { row: target.row + 1, column: target.column, value, exists: row !== undefined && sheet.columns.some((c) => c.name === target.column && !isCommentsColumn(c)) };
}

/**
 * The facts a cell's run is handed, as labelled data: the sheet, its columns and the cell. What Tex may do with
 * them, the answer's shape and its examples are the `sheet-cell` prompt module (`texPrompt/sheet-cell.md`).
 */
export function sheetRunParts({ path, noteText, cell: target }) {
  const { table, rows, columns } = sheetTable(noteText);
  const at = cellWords(noteText, target);
  return {
    where: [`Sheet: ${str(path)}`, `Rows: ${rows}`, `Columns: ${columns.map((name) => JSON.stringify(name)).join(", ") || "(none)"}`, `Table:\n\n${table}`].join("\n"),
    anchor: [`Cell row: ${at.row}`, `Cell column: ${JSON.stringify(at.column)}`, `Cell value: ${at.value === "" ? "(empty)" : JSON.stringify(at.value)}`, ...(at.exists ? [] : ["Cell gone: yes"])].join("\n"),
  };
}

/**
 * The model's changes, checked: `{ cells, append, delete }` with only well-formed entries kept, or null when it asked
 * for none. A change that names no column of the sheet is still kept here: the app refuses it whole, against the
 * sheet as it is when the answer lands, and says so.
 */
export function sheetChangesOf(value) {
  if (!isObject(value)) return null;
  const cells = (Array.isArray(value.cells) ? value.cells : [])
    .filter((c) => isObject(c) && Number.isInteger(c.row) && c.row >= 1 && typeof c.column === "string" && c.column.length <= MAX_COLUMN_CHARS && (typeof c.value === "string" || typeof c.value === "number" || typeof c.value === "boolean"))
    .slice(0, MAX_CELL_CHANGES)
    .map((c) => ({ row: c.row, column: c.column, value: String(c.value).slice(0, MAX_VALUE_CHARS) }));
  const append = (Array.isArray(value.append) ? value.append : [])
    .filter(isObject)
    .slice(0, MAX_APPENDED_ROWS)
    .map((row) => Object.fromEntries(Object.entries(row).filter(([k, v]) => k.length <= MAX_COLUMN_CHARS && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")).map(([k, v]) => [k, String(v).slice(0, MAX_VALUE_CHARS)])))
    .filter((row) => Object.keys(row).length > 0);
  const remove = [...new Set((Array.isArray(value.delete) ? value.delete : []).filter((n) => Number.isInteger(n) && n >= 1))].slice(0, MAX_DELETED_ROWS);
  if (cells.length === 0 && append.length === 0 && remove.length === 0) return null;
  return { cells, append, delete: remove };
}

/** `{ answer, changes }` from the model's words; the raw words as the answer when no JSON answer is in them. */
export function parseSheetRun(answer, maxAnswer) {
  const text = str(answer).trim();
  const raw = { answer: text.slice(0, maxAnswer), changes: null };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return raw;
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return raw;
  }
  if (!isObject(value) || typeof value.answer !== "string" || value.answer.trim() === "" || value.answer.length > maxAnswer) return raw;
  return { answer: value.answer.trim(), changes: sheetChangesOf(value) };
}

/** The step's label once the run has answered: what it did to the sheet. */
export function sheetStepLabel(changes) {
  if (changes === null) return "Writing the answer";
  const only = changes.cells.length === 1 && changes.append.length === 0 && changes.delete.length === 0;
  return only ? `Writing row ${changes.cells[0].row} · ${changes.cells[0].column}` : "Editing the sheet";
}
