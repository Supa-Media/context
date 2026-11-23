/**
 * The pure view state of a sheet: which rows show (filters and a sort), which
 * columns are hidden, and the footer's calculation per column. None of it is
 * saved. It is the session's view of the file, not part of the file, so a
 * filter or a hidden column never changes a byte of the CSV.
 *
 * Reads what `apps/mcp/src/sheets/csv.js` says a value means (`rowMatches`,
 * `typedValue`, `cellProblem`) and nothing else, so a row this grid shows is a
 * row the gateway's query would also return.
 */

import { cellProblem, cellText, rowMatches, typedValue } from "../../../../../mcp/src/sheets/csv.js";

export type ColumnType = "text" | "number" | "usd" | "date" | "person" | "select" | "checkbox" | "link";

export interface SheetColumn {
  name: string;
  type: ColumnType;
}

export interface SheetData {
  columns: SheetColumn[];
  rows: Record<string, string>[];
}

export type CalcKind = "None" | "Sum" | "Average" | "Min" | "Max" | "Latest" | "Count";
export const CALCS: readonly CalcKind[] = ["None", "Sum", "Average", "Min", "Max", "Latest", "Count"];

export type FilterOp = "is" | "is not" | "contains" | ">" | "<" | "after" | "before" | "is checked" | "is not checked";

export interface SheetFilter {
  column: string;
  op: FilterOp;
  value: string;
}

export interface SheetViewState {
  filters: SheetFilter[];
  sort: { column: string; direction: "asc" | "desc" } | null;
  hidden: string[];
  calcs: Record<string, CalcKind>;
}

export const EMPTY_VIEW: SheetViewState = { filters: [], sort: null, hidden: [], calcs: {} };

export const TYPE_GLYPH: Record<ColumnType, string> = {
  text: "Aa",
  number: "#",
  usd: "$",
  date: "▦",
  person: "@",
  select: "◉",
  checkbox: "☑",
  link: "↗",
};

export const TYPE_LABEL: Record<ColumnType, string> = {
  text: "Text",
  number: "Number",
  usd: "Money",
  date: "Date",
  person: "Person",
  select: "Select",
  checkbox: "Checkbox",
  link: "Link",
};

export const COLUMN_TYPE_ORDER: readonly ColumnType[] = ["text", "number", "usd", "date", "person", "select", "checkbox", "link"];

export function isNumeric(type: ColumnType): boolean {
  return type === "number" || type === "usd";
}

export function filterOpsFor(type: ColumnType): FilterOp[] {
  switch (type) {
    case "select":
    case "person":
      return ["is", "is not"];
    case "text":
      return ["contains", "is"];
    case "link":
      return ["contains"];
    case "number":
    case "usd":
      return [">", "<", "is"];
    case "date":
      return ["after", "before", "is"];
    case "checkbox":
      return ["is checked", "is not checked"];
  }
}

/** A view filter as the csv module's row filter. A checkbox filter is `is` / `is not` "true". */
export function toRowFilter(filter: SheetFilter): { column: string; op: string; value: string } {
  if (filter.op === "is checked") return { column: filter.column, op: "is", value: "true" };
  if (filter.op === "is not checked") return { column: filter.column, op: "is not", value: "true" };
  return { column: filter.column, op: filter.op, value: filter.value };
}

export function cellOf(sheet: SheetData, row: number, column: string): string {
  return cellText(sheet.rows[row]?.[column] ?? "");
}

export function compareCells(type: ColumnType, a: string, b: string): number {
  if (isNumeric(type)) {
    const x = typedValue(type, a);
    const y = typedValue(type, b);
    if (typeof x === "number" && typeof y === "number") return x - y;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Which rows show, as indexes into `sheet.rows` in display order. */
export function visibleRows(sheet: SheetData, view: SheetViewState): number[] {
  let order = sheet.rows.map((_, index) => index);
  for (const filter of view.filters) {
    const rowFilter = toRowFilter(filter);
    order = order.filter((index) => rowMatches(sheet, sheet.rows[index], rowFilter));
  }
  const sort = view.sort;
  const column = sort ? sheet.columns.find((c) => c.name === sort.column) : undefined;
  if (sort && column) {
    const dir = sort.direction === "desc" ? -1 : 1;
    order = order
      .slice()
      .sort((a, b) => compareCells(column.type, cellOf(sheet, a, column.name), cellOf(sheet, b, column.name)) * dir || a - b);
  }
  return order;
}

/** "1 row", "3 rows", or "2 of 5 rows" once a filter is on. */
export function rowCountLabel(shown: number, total: number): string {
  if (shown === total) return `${total} ${total === 1 ? "row" : "rows"}`;
  return `${shown} of ${total} rows`;
}

export function formatDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** A number as a person reads it: money with dollars, decimals only when there are some. */
export function formatNumber(type: ColumnType, n: number): string {
  if (type === "usd") return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

/** A stored cell's text as shown: numbers formatted, dates in words, anything that does not fit left as written. */
export function displayText(type: ColumnType, text: string): string {
  const s = text.trim();
  if (s === "" || cellProblem(type, s)) return s;
  if (isNumeric(type)) return formatNumber(type, Number(typedValue(type, s)));
  if (type === "date") return formatDate(s);
  return s;
}

/** The footer's figure for one column over the rows that show. */
export function calcValue(kind: CalcKind, sheet: SheetData, column: SheetColumn, shown: number[]): string {
  if (kind === "None") return "";
  const values = shown.map((row) => cellOf(sheet, row, column.name).trim()).filter((v) => v !== "");
  if (kind === "Count") return String(values.length);
  if (kind === "Latest") {
    if (shown.length === 0) return "";
    const dateColumn = sheet.columns.find((c) => c.type === "date");
    // The newest by the sheet's first date column; with no date column, the last row shown.
    let pick = shown[shown.length - 1];
    if (dateColumn) {
      let best = "";
      for (const row of shown) {
        const d = cellOf(sheet, row, dateColumn.name);
        if (d !== "" && d >= best) {
          best = d;
          pick = row;
        }
      }
    }
    return displayText(column.type, cellOf(sheet, pick, column.name));
  }
  if (!isNumeric(column.type)) return "";
  const nums = values.map((v) => typedValue(column.type, v)).filter((n): n is number => typeof n === "number");
  if (nums.length === 0) return "";
  if (kind === "Sum") return formatNumber(column.type, nums.reduce((a, b) => a + b, 0));
  if (kind === "Average") return formatNumber(column.type, nums.reduce((a, b) => a + b, 0) / nums.length);
  if (kind === "Min") return formatNumber(column.type, Math.min(...nums));
  return formatNumber(column.type, Math.max(...nums));
}

/** What a column's footer shows before anybody picks: Sum for money, nothing otherwise. */
export function calcFor(view: SheetViewState, column: SheetColumn): CalcKind {
  return view.calcs[column.name] ?? (column.type === "usd" ? "Sum" : "None");
}

/** Lines to show above the grid for the parser's problems: the first three, with their line numbers. */
export function problemLines(errors: { line: number; message: string }[]): string[] {
  return errors.slice(0, 3).map((e) => (e.line > 0 ? `Line ${e.line}: ${e.message}` : e.message));
}

/** Move the selected cell by rows and columns, staying inside what shows. */
export function moveSelection(
  order: number[],
  columns: string[],
  at: { row: number; col: string } | null,
  dr: number,
  dc: number,
): { row: number; col: string } | null {
  if (order.length === 0 || columns.length === 0) return null;
  const ri = Math.max(0, Math.min(order.length - 1, order.indexOf(at?.row ?? order[0]) + dr));
  const ci = Math.max(0, Math.min(columns.length - 1, columns.indexOf(at?.col ?? columns[0]) + dc));
  return { row: order[ri], col: columns[ci] };
}

/** A column renamed: the view's sort, filters, hidden list and calculations follow it. */
export function renameInView(v: SheetViewState, from: string, to: string): SheetViewState {
  return {
    filters: v.filters.map((f) => (f.column === from ? { ...f, column: to } : f)),
    sort: v.sort && v.sort.column === from ? { ...v.sort, column: to } : v.sort,
    hidden: v.hidden.map((name) => (name === from ? to : name)),
    calcs: Object.fromEntries(Object.entries(v.calcs).map(([name, kind]) => [name === from ? to : name, kind])),
  };
}

/** A column deleted: nothing in the view refers to it any more. */
export function dropFromView(v: SheetViewState, name: string): SheetViewState {
  const calcs = Object.fromEntries(Object.entries(v.calcs).filter(([column]) => column !== name));
  return {
    filters: v.filters.filter((f) => f.column !== name),
    sort: v.sort && v.sort.column === name ? null : v.sort,
    hidden: v.hidden.filter((n) => n !== name),
    calcs,
  };
}

/** Distinct non-empty values of a column, first seen first: the choices a filter offers. */
export function distinctValues(sheet: SheetData, column: string): string[] {
  const seen = new Set<string>();
  for (const row of sheet.rows) {
    const v = cellText(row[column] ?? "").trim();
    if (v !== "") seen.add(v);
  }
  return [...seen];
}
