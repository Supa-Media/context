/**
 * Every change the grid makes, as text in and text out: the file's current
 * text is parsed, one csv.js function applies the change, and the result is
 * serialized again. The grid hands the answer to `onChangeText` and keeps no
 * copy of its own, so the file is the only truth.
 *
 * A cell edit has no csv.js function of its own (`changeRows` matches rows by
 * value, and two identical rows would both change), so it sets one row by its
 * index and normalises the value the way `changeRows` does for a number.
 */

import {
  addColumn,
  cellProblem,
  changeRows,
  deleteColumn,
  joinOptions,
  parseSheet,
  renameColumn,
  serializeSheet,
  setColumnLayout,
  setColumnType,
  typedValue,
} from "../../../../../mcp/src/sheets/csv.js";
import type { ColumnType } from "./sheetModel";

/** The parsed shape the csv functions take and return. */
interface SheetShape {
  columns: { name: string; type: string; wrap?: boolean; width?: number }[];
  rows: Record<string, string>[];
}

/** The file's text as the csv module reads it. */
function load(text: string): SheetShape {
  return parseSheet(text) as unknown as SheetShape;
}

// csv.js is plain JavaScript and its default parameters are inferred narrower than the callers need,
// so these two are typed where they are called. The behaviour is the module's own.
const appendRows = changeRows as unknown as (sheet: SheetShape, change: { append: Record<string, string>[] }) => {
  ok: boolean;
  sheet: SheetShape;
};
const addTo = addColumn as unknown as (sheet: SheetShape, options: { name: string; type: string; at: number }) => {
  columns: SheetShape["columns"];
  rows: Record<string, string>[];
};

/** The text a typed value is stored as: a number in a number column is written as the number. */
export function storedValue(type: ColumnType, text: string): string {
  const s = text.trim();
  if ((type === "number" || type === "usd") && s !== "" && !cellProblem(type, s)) return String(typedValue(type, s));
  if (type === "multiselect") return joinOptions([s]) as string;
  return s;
}

/** Set one cell of the row at `row` (its index in the file's rows). */
export function editCell(text: string, row: number, column: string, value: string): string {
  return editCells(text, [{ row, column, value }]);
}

/** Set several cells at once (a paste), as one change. A cell whose row or column is gone is skipped. */
export function editCells(text: string, cells: readonly { row: number; column: string; value: string }[]): string {
  const sheet = load(text);
  const rows = sheet.rows.slice();
  let changed = false;
  for (const { row, column, value } of cells) {
    const col = sheet.columns.find((c) => c.name === column);
    if (!col || !rows[row]) continue;
    rows[row] = { ...rows[row], [column]: storedValue(col.type as ColumnType, value) };
    changed = true;
  }
  return changed ? serializeSheet({ columns: sheet.columns, rows }) : text;
}

/** Clipboard text as a block of cells: tab-separated lines, as every spreadsheet copies them. */
export function clipboardBlock(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return lines.map((line) => line.split("\t"));
}

/** The name a rename would store, as csv.js cleans it: separators become spaces. */
export function cleanColumnName(name: string): string {
  return name.replace(/[,:\r\n"]/g, " ").trim();
}

/** Append an empty row. `changeRows` fills every column with "". */
export function appendRow(text: string): string {
  const result = appendRows(load(text), { append: [{}] });
  return result.ok ? serializeSheet(result.sheet) : text;
}

/** Insert an empty row at `at` (its index in the file's rows; the end when past it). */
export function insertRow(text: string, at: number): string {
  const sheet = load(text);
  const empty = Object.fromEntries(sheet.columns.map((c) => [c.name, ""]));
  const rows = sheet.rows.slice();
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, empty);
  return serializeSheet({ columns: sheet.columns, rows });
}

/** Remove the row at `row` (its index in the file's rows). A row that is not there changes nothing. */
export function deleteRow(text: string, row: number): string {
  const sheet = load(text);
  if (!sheet.rows[row]) return text;
  return serializeSheet({ columns: sheet.columns, rows: sheet.rows.filter((_, i) => i !== row) });
}

/** Insert a column at `at` (its position in the header; the end when past it). */
export function insertColumn(text: string, at: number, name = "new column"): string {
  const added = addTo(load(text), { name, type: "text", at });
  return serializeSheet({ columns: added.columns, rows: added.rows });
}

export function renameColumnText(text: string, from: string, to: string): string {
  return serializeSheet(renameColumn(load(text), from, to));
}

/** The new text and how many values no longer fit the type (kept, never rewritten). */
export function retypeColumn(text: string, name: string, type: ColumnType): { text: string; misfits: number } {
  const result = setColumnType(load(text), name, type);
  return { text: serializeSheet(result.sheet), misfits: result.misfits };
}

export function removeColumn(text: string, name: string): string {
  return serializeSheet(deleteColumn(load(text), name));
}

/** The column's index in the file's header, or -1. */
export function columnIndex(text: string, name: string): number {
  return load(text).columns.findIndex((c) => c.name === name);
}

/** Wrap a column's cells, or not: written into its header, so everyone who opens the sheet sees the same. */
export function setColumnWrap(text: string, name: string, wrap: boolean): string {
  return serializeSheet(setColumnLayout(load(text), name, { wrap }));
}

/** A column's width in pixels, or null to share the grid's width again: written into its header. */
export function setColumnWidth(text: string, name: string, width: number | null): string {
  return serializeSheet(setColumnLayout(load(text), name, { width }));
}
