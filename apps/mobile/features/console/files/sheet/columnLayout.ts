/**
 * How wide each column draws and how tall a wrapped row is, as pure numbers.
 *
 * A column with a width in its header (`notes:text:w320`) keeps it. Columns
 * nobody sized share what is left of the grid's width, as a table does, and
 * never go narrower than the minimum: past that the grid scrolls. A drag or a
 * Fit clamps to FIT_MIN–FIT_MAX for Fit and DRAG_MIN upward for a drag.
 */

import { splitOptions } from "../../../../../mcp/src/sheets/csv.js";
import { canWrap, cellOf, displayText, type SheetColumn, type SheetData } from "./sheetModel";

export const ROW_HEIGHT = 34;
/** A wrapped cell shows at most this many lines; editing it shows the rest. */
export const WRAP_LINES = 6;
export const CHIP_GAP = 4;

/** About how wide a chip draws: dot, gap, padding and its word at the grid's size. Close enough to choose what fits. */
export function chipWidth(word: string): number {
  return 31 + Math.ceil(word.length * 7);
}

export const COLUMN_WIDTH = 168;
export const NARROW_COLUMN_WIDTH = 128;
export const DRAG_MIN = 72;
export const FIT_MIN = 72;
export const FIT_MAX = 480;
/** A wrapped line's height, and the padding above and below a wrapped cell's text. */
export const LINE_HEIGHT = 18;
export const WRAP_PAD = 8;
/** About how wide a character draws at the grid's size: enough to choose a width or guess a height. */
const CHAR = 7;
const CELL_PAD = 16;

export function columnWidths(
  columns: readonly SheetColumn[],
  room: number,
  minWidth: number,
  override?: { name: string; width: number } | null,
): number[] {
  const set = columns.map((c) => (override && override.name === c.name ? override.width : c.width));
  const fixed = set.reduce<number>((sum, w) => sum + (w ?? 0), 0);
  const flexible = set.filter((w) => w === undefined).length;
  const share = flexible === 0 ? minWidth : Math.max(minWidth, Math.floor((room - fixed) / flexible));
  return set.map((w) => w ?? share);
}

/** The width that shows a column's longest value (and its name) whole, within FIT_MIN–FIT_MAX. */
export function fitWidth(sheet: SheetData, column: SheetColumn, rows: readonly number[]): number {
  let widest = column.name.length * CHAR + 18 + 4 + CELL_PAD;
  for (const row of rows) {
    const text = cellOf(sheet, row, column.name);
    const w =
      column.type === "multiselect"
        ? (splitOptions(text) as string[]).reduce((sum, word, i) => sum + (i > 0 ? 4 : 0) + chipWidth(word), 0)
        : displayText(column.type, text).length * CHAR;
    widest = Math.max(widest, w + CELL_PAD);
  }
  return Math.max(FIT_MIN, Math.min(FIT_MAX, Math.ceil(widest)));
}

/** A drag's width: whole pixels, never narrower than DRAG_MIN. */
export function dragWidth(start: number, moved: number): number {
  return Math.max(DRAG_MIN, Math.round(start + moved));
}

export function wraps(column: SheetColumn): boolean {
  return column.wrap !== false && canWrap(column.type);
}

/**
 * About how tall a row draws with its wrapped cells, for sizing the grid's
 * box; the list measures the real rows itself.
 */
export function estimateRowHeight(sheet: SheetData, row: number, columns: readonly SheetColumn[], widths: readonly number[]): number {
  let lines = 1;
  columns.forEach((c, i) => {
    if (!wraps(c)) return;
    const room = Math.max(1, widths[i] - CELL_PAD);
    const text = cellOf(sheet, row, c.name);
    const need =
      c.type === "multiselect"
        ? Math.ceil((splitOptions(text) as string[]).reduce((sum, word) => sum + 4 + chipWidth(word), 0) / room) * 26 / LINE_HEIGHT
        : Math.ceil((text.length * CHAR) / room);
    lines = Math.max(lines, Math.min(WRAP_LINES, need));
  });
  return lines <= 1 ? ROW_HEIGHT : Math.max(ROW_HEIGHT, Math.ceil(lines * LINE_HEIGHT + WRAP_PAD * 2));
}

/**
 * How many of a multi-select's chips show whole in `room` pixels, keeping room
 * for a "+N" pill when some are left out. At least one always shows.
 */
export function chipsThatFit(words: readonly string[], room: number): number {
  let used = 0;
  for (let i = 0; i < words.length; i += 1) {
    const next = used + (i > 0 ? CHIP_GAP : 0) + chipWidth(words[i]);
    const rest = words.length - i - 1;
    const pill = rest > 0 ? CHIP_GAP + 12 + 8 * String(`+${rest}`).length : 0;
    if (next + pill > room) return Math.max(1, i);
    used = next;
  }
  return words.length;
}
