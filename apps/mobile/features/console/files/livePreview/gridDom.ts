/**
 * A drawn grid's DOM: the per-element state that outlives each widget
 * (`drawnGrids`), painting a cell, finding a cell and its current span, and
 * placing a caret or selection inside one.
 *
 * `drawnGrids` is created once, here. Part of the Live Preview extension;
 * `../livePreview.ts` is the facade that re-exports the public names and holds
 * the module map.
 */

import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { CellSpan, TableRegion } from "../tableEdit";
import { readTable, type CellAlign, type CellRun, type TableGrid } from "./tableModel";

/**
 * Where each drawn grid's own state lives between redraws.
 *
 * A widget object is thrown away and rebuilt on **every** transaction, and its
 * DOM is not: `updateDOM` hands the new widget the old element. So anything a
 * listener needs at event time — which table it belongs to now, which cell was
 * last in — belongs to the element rather than to the widget that made it. A
 * handler that closed over `this.grid` would write the state of the keystroke
 * before last back into the file, which is the bug `ImageRowWidget.rowNow`
 * exists to avoid, one redraw earlier.
 *
 * A `WeakMap` rather than dataset properties because the values are objects,
 * and because nothing here should put editor state in the DOM where a paste of
 * the rendered note would carry it away.
 */
export interface DrawnGrid {
  grid: TableGrid;
  canEdit: boolean;
  /** The last cell focused in this grid, for the controls to act on. */
  focused: { row: number; column: number } | null;
}
export const drawnGrids = new WeakMap<HTMLElement, DrawnGrid>();

/** The header row's own row index. Not `0`: that is the first body row. */
export const HEADER_ROW = -1;

/**
 * One cell's drawn content, replacing whatever was in it.
 *
 * Outside the widget because two things paint a cell: the draw, and a cell
 * losing focus — which has to put the *rendering* back where the source was,
 * and would otherwise need a widget instance it does not have.
 */
export function paintCell(cell: HTMLElement, runs: readonly CellRun[], align: CellAlign): void {
  cell.replaceChildren();
  cell.classList.remove(
    "cm-lp-grid-empty",
    "cm-lp-grid-source",
    "cm-lp-grid-left",
    "cm-lp-grid-center",
    "cm-lp-grid-right",
  );
  if (align !== null) cell.classList.add(`cm-lp-grid-${align}`);

  if (runs.every((run) => run.text.trim() === "")) {
    /*
      A dash rather than nothing — while reading. An empty cell drawn as empty
      is indistinguishable from a column that failed to render, and a reader has
      no way to tell which they are looking at. In an editable grid the cell is
      a box you can click into and the question does not arise, so the dash is
      dropped there by `livePreviewStyles` rather than typed over.
    */
    cell.classList.add("cm-lp-grid-empty");
    return;
  }

  for (const run of runs) {
    // A `\n` is the hard break the author wrote as `<br>`; see `cellRuns`.
    const pieces = run.text.split("\n");
    pieces.forEach((piece, index) => {
      if (index > 0) cell.append(document.createElement("br"));
      if (piece === "") return;
      if (run.className === null) {
        cell.append(document.createTextNode(piece));
        return;
      }
      const span = document.createElement("span");
      span.className = run.className;
      span.textContent = piece;
      cell.append(span);
    });
  }
}

/** Which cells of a grid are padding rather than characters, as a signature. */
export function paddingOf(grid: TableGrid): string {
  const row = (spans: ReadonlyArray<CellSpan | null>) =>
    spans.map((span) => (span === null ? "0" : "1")).join("");
  return [row(grid.headerSpans), ...grid.rowSpans.map(row)].join("/");
}

/** The selection inside a cell, as offsets into its text. */
export function cellSelection(cell: HTMLElement): { from: number; to: number } | null {
  const view = cell.ownerDocument.defaultView;
  if (view === null || typeof view.getSelection !== "function") return null;
  const selection = view.getSelection();
  if (selection === null || selection.rangeCount === 0) return { from: 0, to: 0 };
  try {
    const range = selection.getRangeAt(0);
    if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null;
    const before = cell.ownerDocument.createRange();
    before.selectNodeContents(cell);
    before.setEnd(range.startContainer, range.startOffset);
    const from = before.toString().length;
    return { from, to: from + range.toString().length };
  } catch {
    return null;
  }
}

/**
 * Type into a cell at its caret, for the keys that mean text rather than a
 * command — Shift-Enter, and a paste.
 */
export function insertInCell(cell: HTMLElement, text: string): void {
  const view = cell.ownerDocument.defaultView;
  const selection = view?.getSelection?.() ?? null;
  /*
    The end of the cell when there is no usable caret *in this cell*. A
    selection left somewhere else — another cell, a node a redraw removed —
    is not a caret here, and inserting at it would put the person's break in a
    table they are not looking at. Found by a jsdom suite where one test's
    selection outlived its editor, which is the same thing a stale range is in
    a browser.
  */
  const inside =
    selection !== null &&
    selection.rangeCount > 0 &&
    cell.contains(selection.getRangeAt(0).startContainer);
  if (!inside || selection === null) {
    cell.textContent = (cell.textContent ?? "") + text;
    return;
  }
  try {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = cell.ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    cell.textContent = (cell.textContent ?? "") + text;
  }
}

/** Put a selection back in a cell, by offsets into the text it now holds. */
export function selectInCell(cell: HTMLElement, from: number, to: number): void {
  const view = cell.ownerDocument.defaultView;
  if (view === null || typeof view.getSelection !== "function") return;
  const selection = view.getSelection();
  const node = cell.firstChild;
  if (selection === null || node === null || node.nodeType !== 3) return;
  try {
    const length = node.textContent?.length ?? 0;
    const range = cell.ownerDocument.createRange();
    range.setStart(node, Math.min(from, length));
    range.setEnd(node, Math.min(to, length));
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* A selection this browser will not place is not a reason to lose the edit. */
  }
}

/** The span of one drawn cell, or `null` where GFM padded the row out. */
export function spanOf(grid: TableGrid, row: number, column: number): CellSpan | null {
  const spans = row === HEADER_ROW ? grid.headerSpans : (grid.rowSpans[row] ?? []);
  return spans[column] ?? null;
}

/** The cell element at these coordinates, in a grid that is already drawn. */
export function cellElement(wrap: HTMLElement, row: number, column: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(
    `[data-lp-row="${row}"][data-lp-column="${column}"]`,
  );
}

/**
 * The table this element is drawing, as the document has it **now**.
 *
 * Not the grid the widget was built from: a control can be pressed twice
 * before a redraw, and the second press would plan against the first one's
 * document. The element's stored grid is replaced by `updateDOM` on every
 * transaction, so its `from` is where the table is now, and the tree is read
 * from there.
 */
export function regionOf(view: EditorView, wrap: HTMLElement): TableRegion | null {
  const drawn = drawnGrids.get(wrap);
  if (drawn === undefined) return null;
  const table = tableNodeAt(view.state, drawn.grid.from);
  if (table === null) return null;
  return { from: table.from, to: table.to };
}

/** The `Table` node that starts at `from`, if the document still has one. */
function tableNodeAt(state: EditorState, from: number): SyntaxNode | null {
  if (from < 0 || from > state.doc.length) return null;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1);
  for (; node !== null; node = node.parent) {
    if (node.name === "Table") return node;
  }
  return null;
}

/** The current source of one cell, by coordinates rather than by captured span. */
export function cellSpanNow(view: EditorView, wrap: HTMLElement, row: number, column: number): CellSpan | null {
  const drawn = drawnGrids.get(wrap);
  if (drawn === undefined) return null;
  const table = tableNodeAt(view.state, drawn.grid.from);
  if (table === null) return null;
  const grid = readTable(view.state, table);
  if (grid === null) return null;
  return spanOf(grid, row, column);
}

export function dispatchPlan(view: EditorView, plan: TransactionSpec | null): boolean {
  if (plan === null) return false;
  if (view.state.readOnly) return false;
  view.dispatch(plan);
  return true;
}

/**
 * Put the caret in a cell of the grid drawn for the table at `from`.
 *
 * The one thing outside this file that has to reach inside a grid: something
 * that *makes* a table — the size picker's "4 × 3" — has to leave the person
 * in its first cell, and after this change there is no caret position in the
 * source for it to use. The table's start is the handle, because that is what
 * the command that inserted it knows.
 *
 * Returns whether a cell took the caret, so a caller can keep whatever it was
 * doing before when the grid is not there: a read-only note, or a table the
 * grid refused.
 */
export function focusGridCell(
  view: EditorView,
  from: number,
  row: number,
  column: number,
): boolean {
  const wraps = view.dom.querySelectorAll<HTMLElement>(".cm-lp-grid");
  for (const wrap of wraps) {
    if (drawnGrids.get(wrap)?.grid.from !== from) continue;
    return focusCell(wrap, row, column, "end");
  }
  return false;
}

/** Put the caret in a cell of a grid that is on screen. */
export function focusCell(
  wrap: HTMLElement,
  row: number,
  column: number,
  caret: "start" | "end",
): boolean {
  const cell = cellElement(wrap, row, column);
  if (cell === null || cell.getAttribute("contenteditable") === null) return false;
  cell.focus();
  placeCaret(cell, caret);
  return true;
}

/**
 * The caret, at one end of a cell.
 *
 * Wrapped in the feature checks rather than assumed: this runs in a WKWebView
 * and in jsdom, and the unit suite mounts no selection at all. A cell that
 * could not place its caret is still focused and still typed into — at
 * whichever end the browser chose — which is worth more than a thrown error
 * inside a keystroke handler.
 */
export function placeCaret(cell: HTMLElement, caret: "start" | "end"): void {
  const view = cell.ownerDocument.defaultView;
  if (view === null || typeof view.getSelection !== "function") return;
  const selection = view.getSelection();
  if (selection === null || typeof cell.ownerDocument.createRange !== "function") return;
  try {
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(cell);
    range.collapse(caret === "start");
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* A selection this browser will not place is not a reason to lose the key. */
  }
}

/** Where the caret is in a cell, as an offset into its text. */
export function caretOffset(cell: HTMLElement): number | null {
  const view = cell.ownerDocument.defaultView;
  if (view === null || typeof view.getSelection !== "function") return null;
  const selection = view.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  try {
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(cell);
    range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}
