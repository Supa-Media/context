/**
 * Editing a drawn table cell in place: the formatting chords applied to the
 * cell's own text, and the listeners that make one cell editable.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { planAddRow, planCellEdit } from "../tableEdit";
/*
  The marker rule, over a plain string. Lifted out of `markdownFormat.ts` so
  this file can run it against a cell's own text: `markdownFormat` imports this
  module, so the shared half had to stop living there. See `markerToggle.ts`.
*/
import { MARKERS, planToggle, type MarkerName } from "../markerToggle";
/*
  Undo, for the one place the editor's own keymap cannot reach: a keystroke
  made inside a cell never gets to it (`ignoreEvent`), and the browser's
  contenteditable history knows nothing about the document. See the cell's
  keydown handler.
*/
import { redo, undo } from "@codemirror/commands";
import {
  HEADER_ROW,
  caretOffset,
  cellSelection,
  cellSpanNow,
  dispatchPlan,
  drawnGrids,
  focusCell,
  insertInCell,
  paintCell,
  placeCaret,
  regionOf,
  selectInCell,
} from "./gridDom";
import { stopWritingTable, writingTable } from "./writingTable";

/**
 * ⌘B, IN THE CELL RATHER THAN IN THE DOCUMENT.
 *
 * The gap this closes was stated rather than hidden when the grid became
 * editable, and it is the one people would meet first: focus is in a widget's
 * own `contenteditable`, so every formatting verb — the keymap's ⌘B, the
 * phone's Bold key, the right-click menu — acted on the document behind the
 * table and left the cell alone. "The characters are right there to type
 * instead" is true and is not an answer for a chord somebody has in their
 * fingers.
 *
 * The decision is `planToggle`'s, unchanged, over the cell's text and the
 * selection *inside the cell*: the same reading of the grammar, so `**x**` and
 * `*x*` compose in a cell exactly as they do in a paragraph. What differs is
 * where it is applied — the cell holds source while it has focus, so the new
 * text is written straight back into that one span and the DOM keeps the
 * selection the plan returned.
 *
 * Returns whether a cell took it, so `markdownFormat` can fall through to the
 * document when no cell has focus.
 */
export function toggleMarkerInCell(view: EditorView, before: string, after: string): boolean {
  const active = view.dom.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (!active.classList.contains("cm-lp-grid-cell")) return false;
  if (!view.dom.contains(active) || view.state.readOnly) return false;

  const wrap = active.closest<HTMLElement>(".cm-lp-grid");
  if (wrap === null) return false;
  const row = Number(active.dataset.lpRow);
  const column = Number(active.dataset.lpColumn);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return false;
  const span = cellSpanNow(view, wrap, row, column);
  if (span === null) return false;

  const text = active.textContent ?? "";
  const selected = cellSelection(active);
  if (selected === null) return false;

  const plan = planToggle(text, EditorSelection.range(selected.from, selected.to), before, after);
  /*
    Applied here rather than through a transaction on the document: the
    changes are offsets into the cell's own text, and what reaches the file is
    one replacement of one span — `planCellEdit`'s rule, and the reason this
    feature has no serializer.
  */
  const next = ChangeSet.of(plan.changes, text.length).apply(Text.of(text.split("\n"))).toString();

  active.textContent = next;
  dispatchPlan(view, planCellEdit(view.state, span, next));
  selectInCell(active, plan.range.from, plan.range.to);
  return true;
}

/**
 * The marker chord a keystroke is, or `null`.
 *
 * The same three the editor's keymap binds (`editorSetup.ts`), and the same
 * reason there is no fourth: every obvious chord for an inline code span is
 * taken by the browser or by this app.
 */
function markerChord(event: KeyboardEvent): MarkerName | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "b" && !event.shiftKey) return "bold";
  if (key === "i" && !event.shiftKey) return "italic";
  if (key === "x" && event.shiftKey) return "strikethrough";
  return null;
}

/**
 * One cell, wired up: focus shows its source, typing writes it back, and the
 * keys that mean "somewhere else in this table" move rather than being typed.
 *
 * The write is `planCellEdit` against the span this cell has **now**, looked
 * up per event — see `cellSpanNow`. Nothing captured from the draw survives a
 * keystroke, because a keystroke is a document change and every span after the
 * caret has moved by the time the next one arrives.
 */
export function makeCellEditable(
  view: EditorView,
  wrap: HTMLElement,
  cell: HTMLElement,
  row: number,
  column: number,
): void {
  /*
    The attribute rather than the property: `contenteditable="true"` is the one
    value every engine this ships to has always understood, and the property
    setter is not implemented by the DOM the unit suite runs against.
    `plaintext-only` would remove the paste handler below and take Firefox
    before 136 with it.
  */
  cell.setAttribute("contenteditable", "true");
  cell.setAttribute("spellcheck", "false");
  cell.classList.add("cm-lp-grid-cell");

  const moveTo = (nextRow: number, nextColumn: number, caret: "start" | "end"): boolean =>
    focusCell(wrap, nextRow, nextColumn, caret);

  /**
   * Move, stepping over anything that cannot take a caret.
   *
   * A column GFM padded into a short row is drawn and not editable, and Tab
   * landing on one would look exactly like Tab being broken: focus stays where
   * it was and the key appears to have done nothing. So the move walks on in
   * the same direction until a cell takes it, or the table runs out.
   */
  const moveThrough = (
    step: (from: { row: number; column: number }) => { row: number; column: number } | null,
    start: { row: number; column: number },
    caret: "start" | "end",
  ): boolean => {
    let at: { row: number; column: number } | null = step(start);
    // Bounded by the size of the table: every step moves one cell on.
    for (let guard = 0; at !== null && guard <= width() * (depth() + 1); guard += 1) {
      if (moveTo(at.row, at.column, caret)) return true;
      at = step(at);
    }
    return false;
  };

  const width = (): number => drawnGrids.get(wrap)?.grid.header.length ?? 0;
  const depth = (): number => drawnGrids.get(wrap)?.grid.rows.length ?? 0;

  /** The cell after this one in reading order, or `null` at the end. */
  const after = (at: { row: number; column: number }): { row: number; column: number } | null => {
    if (at.column + 1 < width()) return { row: at.row, column: at.column + 1 };
    if (at.row + 1 <= depth() - 1) return { row: at.row + 1, column: 0 };
    return null;
  };
  const before = (at: { row: number; column: number }): { row: number; column: number } | null => {
    if (at.column > 0) return { row: at.row, column: at.column - 1 };
    if (at.row > HEADER_ROW) return { row: at.row - 1, column: width() - 1 };
    return null;
  };
  const here = (): { row: number; column: number } => ({ row, column });
  const next = (): { row: number; column: number } | null => after(here());
  const previous = (): { row: number; column: number } | null => before(here());

  /*
    `into` is where the caret lands in the new row, and the two callers want
    different columns: Enter is continuing down a column and stays in it, Tab
    has just run off the end of the row and starts the next one.
  */
  const addRowBelow = (into: number): void => {
    const region = regionOf(view, wrap);
    if (region === null) return;
    if (!dispatchPlan(view, planAddRow(view.state, region, row))) return;
    moveTo(row + 1, into, "end");
  };

  cell.addEventListener("focus", () => {
    const drawn = drawnGrids.get(wrap);
    if (drawn !== undefined) drawn.focused = { row, column };
    /*
      Whatever was being typed is handed over: a caret in a cell is how
      somebody says they are done writing the pipes. Without this, the table
      you had just finished typing would still be revealed as source behind the
      cell you clicked, and the click would land on a grid that is about to
      disappear. See `writingTable`.
    */
    if (!view.state.readOnly && (view.state.field(writingTable, false) ?? null) !== null) {
      view.dispatch({ effects: stopWritingTable() });
    }
    /*
      THE REVEAL, at the size of a cell. The characters of the cell replace its
      drawing, so what the person edits is the source and what is written back
      is the characters they typed — no serializer, which is the whole promise
      of `tableEdit.ts`. A cell whose source is already what is on screen (most
      of them: plain text) is left alone, so a click lands the caret where the
      person aimed it rather than at the end of the word.
    */
    const span = cellSpanNow(view, wrap, row, column);
    if (span === null) return;
    const source = view.state.doc.sliceString(span.from, span.to).trim();
    cell.classList.add("cm-lp-grid-source");
    cell.classList.remove("cm-lp-grid-empty");
    if ((cell.textContent ?? "") === source) return;
    cell.textContent = source;
    placeCaret(cell, "end");
  });

  cell.addEventListener("blur", () => {
    cell.classList.remove("cm-lp-grid-source");
    /*
      Drawn again from the document rather than from what is in the element:
      the element holds source and the grid holds a rendering of it, and the
      one that is true is the file's.
    */
    const drawn = drawnGrids.get(wrap);
    if (drawn === undefined) return;
    const runs =
      row === HEADER_ROW ? drawn.grid.header[column] : (drawn.grid.rows[row]?.[column] ?? []);
    paintCell(cell, runs ?? [], drawn.grid.align[column] ?? null);
  });

  cell.addEventListener("input", () => {
    const span = cellSpanNow(view, wrap, row, column);
    if (span === null) return;
    dispatchPlan(view, planCellEdit(view.state, span, cell.textContent ?? ""));
  });

  cell.addEventListener("paste", (event) => {
    /*
      Plain text, always. A cell is markdown source while it is focused, and
      pasted HTML would put elements inside it that `textContent` flattens on
      the next keystroke — the paste would appear to work and then collapse.
    */
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (clipboard === null || clipboard === undefined) return;
    event.preventDefault();
    const text = clipboard.getData("text/plain");
    if (text === "") return;
    const document_ = cell.ownerDocument;
    const selection = document_.defaultView?.getSelection?.() ?? null;
    if (selection === null || selection.rangeCount === 0) {
      cell.textContent = (cell.textContent ?? "") + text;
    } else {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document_.createTextNode(text));
      range.collapse(false);
    }
    const span = cellSpanNow(view, wrap, row, column);
    if (span === null) return;
    dispatchPlan(view, planCellEdit(view.state, span, cell.textContent ?? ""));
  });

  cell.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    const shift = (event as KeyboardEvent).shiftKey;

    /*
      ⌘B and its two neighbours, handled here rather than by the editor's own
      keymap. `ignoreEvent` tells CodeMirror that every event inside this
      widget is the widget's, so the keymap never sees a keystroke made in a
      cell — which is exactly right for Tab and Enter and leaves the chords
      with nobody to answer them. The chord table is short and shared
      (`markerToggle.ts`), so this is one more caller of the same pairs rather
      than a second spelling of Bold.
    */
    const chord = markerChord(event as KeyboardEvent);
    if (chord !== null) {
      event.preventDefault();
      toggleMarkerInCell(view, MARKERS[chord].before, MARKERS[chord].after);
      return;
    }

    if (key === "Tab") {
      event.preventDefault();
      if (moveThrough(shift ? before : after, here(), "end")) return;
      /*
        Tab past the last cell adds a row, which is how a table gets longer
        without anybody reaching for a control. Shift-Tab past the first one
        does nothing: there is no row above the header, and adding one would
        make somebody's header into data.
      */
      if (!shift) addRowBelow(0);
      return;
    }

    /*
      ⌘Z, which nothing else would answer. `ignoreEvent` keeps every keystroke
      made in a cell away from the editor's keymap, and what is left is the
      browser's own contenteditable history — which would put characters back
      into this element while the file kept the change. It matters more here
      than anywhere: the menus delete rows and columns, and undo is the whole
      of what makes a destructive control safe to press.

      The cell is let go of first. The document is about to become one the
      grid draws differently, and a focused cell is the one thing a redraw
      leaves alone.
    */
    if ((event as KeyboardEvent).metaKey || (event as KeyboardEvent).ctrlKey) {
      const lower = key.toLowerCase();
      const isUndo = lower === "z" && !shift;
      const isRedo = (lower === "z" && shift) || lower === "y";
      if (isUndo || isRedo) {
        event.preventDefault();
        cell.blur();
        view.focus();
        (isUndo ? undo : redo)(view);
        return;
      }
    }

    if (key === "Enter") {
      event.preventDefault();
      /*
        Shift-Enter is a line break inside the cell, which in a table is the
        `<br>` the cell reader already draws — the only way a cell holds two
        lines, and otherwise something a person has to know to type.
      */
      if (shift) {
        insertInCell(cell, "<br>");
        const span = cellSpanNow(view, wrap, row, column);
        if (span !== null) dispatchPlan(view, planCellEdit(view.state, span, cell.textContent ?? ""));
        return;
      }
      if (row + 1 <= depth() - 1 && moveTo(row + 1, column, "end")) return;
      addRowBelow(column);
      return;
    }

    if (key === "Escape") {
      /*
        Out of the grid and back into the note, with the caret after the table
        — the one gesture that has to exist, because focus in a widget is not
        focus in the document and nothing else here gives it back.
      */
      event.preventDefault();
      const region = regionOf(view, wrap);
      cell.blur();
      view.focus();
      if (region !== null) {
        view.dispatch({
          selection: { anchor: region.to },
          // The caret lands *at* the table's end, which is a position inside
          // it as far as `writingTable` is concerned. Saying so explicitly is
          // what keeps the grid drawn behind the caret that just left it.
          effects: stopWritingTable(),
        });
      }
      return;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      const to = key === "ArrowUp" ? row - 1 : row + 1;
      if (to < HEADER_ROW || to > depth() - 1) return;
      moveTo(to, column, "end");
      return;
    }

    /*
      Left at the start of a cell and right at the end are the other two edges
      of the same movement — inside the text they are the browser's, which is
      what makes a cell feel like a text box rather than like a form field.
    */
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const offset = caretOffset(cell);
      if (offset === null) return;
      const length = (cell.textContent ?? "").length;
      if (key === "ArrowLeft" && offset === 0) {
        if (previous() === null) return;
        event.preventDefault();
        moveThrough(before, here(), "end");
        return;
      }
      if (key === "ArrowRight" && offset === length) {
        if (next() === null) return;
        event.preventDefault();
        moveThrough(after, here(), "start");
      }
    }
  });
}
