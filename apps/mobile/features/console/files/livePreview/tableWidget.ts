/**
 * `TableGridWidget`: a GFM table drawn as a real `<table>`, with the handles
 * and appends that change its shape while the note is editable.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import { WidgetType, type EditorView } from "@codemirror/view";
/*
  The writes a drawn grid makes back into the pipes, and nothing else: pure,
  DOM-free, and the module that holds the promise that there is no serializer
  here. Separate for the reason `imageBlock.ts` is separate — the interesting
  cases are in the text, and they are testable without a tree or a browser.
*/
import {
  planAddColumn,
  planAddRow,
  planAlignColumn,
  planDeleteColumn,
  planDeleteRow,
  planDeleteTable,
  planInsertColumn,
  planInsertRow,
  planMoveColumn,
  planMoveRow,
} from "../tableEdit";
/*
  The controls a drawn table wears. A separate module for the reason its own
  header gives: they hang off rows and columns rather than off the table, and
  what they draw and how a menu behaves is testable without an editor.
*/
import {
  appendButton,
  closeGridMenu,
  columnHandle,
  rowHandle,
  tableHandle,
  type GridAction,
  type GridChromeHost,
} from "../tableChrome";
import { makeCellEditable } from "./cellEditing";
import {
  HEADER_ROW,
  cellElement,
  dispatchPlan,
  drawnGrids,
  focusCell,
  paddingOf,
  paintCell,
  regionOf,
  spanOf,
} from "./gridDom";
import type { CellRun, TableGrid } from "./tableModel";
import { showTableSource } from "./writingTable";

/**
 * A table, drawn as a table — and, while the note can be typed into, edited as
 * one.
 *
 * A real `<table>` rather than a grid of divs, because this is tabular data and
 * the element carries the row and column relationships to a screen reader for
 * free — a reader who cannot see the alignment is exactly the one who needs to
 * be told which header a cell belongs to.
 *
 * Nothing here interprets the note as markup: every string reaches the DOM
 * through `textContent`, the way `FormWidget` does and for the same reason. The
 * one tag a cell may contain that means something — `<br>` — has already become
 * a `\n` in `cellRuns`, so the break is drawn by this file rather than parsed
 * by the browser.
 *
 * ## The reveal rule, one level down
 *
 * An editable cell is `contenteditable`, and **the cell with focus shows its
 * own characters** while every other cell stays drawn: `**bold**` in the cell
 * you are in, **bold** in the one beside it. That is this file's rule about
 * `## Heading` applied to a unit the size of a cell, and it is what makes the
 * grid editable without a serializer — the text in the focused cell *is* the
 * source, so writing it back is a change to one span rather than a rendering
 * of a model. See `tableEdit.ts`.
 *
 * Two consequences worth naming:
 *
 *  - **CodeMirror's caret is not in the cell.** The widget's DOM is not the
 *    document, so focus is in a `contenteditable` element of ours and
 *    `view.hasFocus` is false while it is there. That is deliberate — it is
 *    what stops CodeMirror redrawing its own selection over the top — and it
 *    is why Escape exists below: it hands focus back with the caret after the
 *    table. It also means the editor's own toolbar commands (bold, a link)
 *    act on the document rather than on the cell while a cell has focus; the
 *    characters are right there to type instead, which is the honest half of
 *    a gap that is stated rather than papered over.
 *  - **`ignoreEvent` and `ignoreMutation` both say "not yours".** Every event
 *    inside the grid is the grid's, and every mutation inside it is this
 *    widget writing to its own DOM. Without the second, CodeMirror reads our
 *    cell edit as somebody typing into the document and appends the text
 *    twice.
 */
export class TableGridWidget extends WidgetType {
  /*
    `canEdit`, not `editable`: `WidgetType` owns `editable` as a getter with no
    setter, and a field of that name throws on construction and takes the whole
    note screen down. The full story is in `ImageRowWidget`, which found it.
  */
  constructor(
    private readonly grid: TableGrid,
    private readonly canEdit: boolean,
  ) {
    super();
  }

  /*
    Compared on the table's own text. Like `FormWidget.eq` this is load-bearing
    rather than an optimisation — the decoration set is rebuilt on every
    transaction, and a widget that reported itself new would have its DOM torn
    down and rebuilt on every keystroke elsewhere in the note. When it does
    report itself new, `updateDOM` below keeps the element anyway, because the
    keystroke that changed the text is usually somebody typing *in* the grid.
  */
  eq(other: TableGridWidget): boolean {
    return other.grid.source === this.grid.source && other.canEdit === this.canEdit;
  }

  toDOM(view: EditorView): HTMLElement {
    /*
      The scroller is the wrapper rather than the table, so a table wider than
      the measure scrolls inside its own box. Without it the note itself scrolls
      sideways, and then every paragraph in the note is dragged off screen by
      one wide table.
    */
    const wrap = document.createElement("div");
    wrap.className = this.canEdit ? "cm-lp-grid cm-lp-grid-live" : "cm-lp-grid";
    drawnGrids.set(wrap, { grid: this.grid, canEdit: this.canEdit, focused: null });

    /*
      The frame is what the controls are positioned against, and it shrinks to
      the table: pinning them to the scroller instead would leave the add-column
      button at the right edge of the *measure* on a two-column table, a hand's
      width from the column it adds to.
    */
    const frame = document.createElement("div");
    frame.className = "cm-lp-grid-frame";
    frame.append(this.drawTable(view, wrap));
    if (this.canEdit) frame.append(this.drawAppends(view, wrap));
    wrap.append(frame);
    return wrap;
  }

  /**
   * The same element, brought up to date — rather than a new one.
   *
   * Returning `false` here would be correct and unusable: CodeMirror would
   * throw the element away and build another, and the `contenteditable` cell
   * the person is typing in would lose focus and the caret with it on **every
   * keystroke**, because every keystroke is a document change. So the element
   * is patched in place, and the one cell that must not be touched is the one
   * with focus: its DOM already holds what the person just typed, and writing
   * the document's version of it back would move the caret to the end of the
   * cell mid-word.
   *
   * A change of shape — a row or a column added or taken away — rebuilds the
   * table inside the *same* wrapper, which is what keeps the listeners' captured
   * element valid and lets the control that made the change put focus back on a
   * cell that now exists.
   */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const drawn = drawnGrids.get(dom);
    const table = dom.querySelector("table");
    if (drawn === undefined || table === null) return false;

    /*
      A repaint writes text into cells that are already wired up; it does not
      wire one up. So anything that changes *which* cells can be typed into is
      a rebuild: the count of rows and columns, the mode, and the pattern of
      padded-out columns — a row that gained a real cell while somebody else
      was editing the file would otherwise stay uneditable until the note was
      reopened.
    */
    const reshaped =
      drawn.canEdit !== this.canEdit ||
      drawn.grid.header.length !== this.grid.header.length ||
      drawn.grid.rows.length !== this.grid.rows.length ||
      paddingOf(drawn.grid) !== paddingOf(this.grid);
    drawnGrids.set(dom, { grid: this.grid, canEdit: this.canEdit, focused: drawn.focused });

    if (reshaped) {
      dom.className = this.canEdit ? "cm-lp-grid cm-lp-grid-live" : "cm-lp-grid";
      const frame = table.parentElement ?? dom;
      /*
        A menu open over a table whose shape has just changed is a menu
        pointing at a row that may not exist; it is closed with the redraw.
      */
      closeGridMenu();
      frame.replaceChildren(this.drawTable(view, dom));
      if (this.canEdit) frame.append(this.drawAppends(view, dom));
      return true;
    }

    const active = dom.ownerDocument.activeElement;
    this.eachCell((row, column, runs) => {
      const cell = cellElement(dom, row, column);
      if (cell === null || cell === active) return;
      paintCell(cell, runs, this.grid.align[column] ?? null);
    });
    return true;
  }

  /** Every cell of the grid, header first, in the order they are drawn. */
  private eachCell(visit: (row: number, column: number, runs: readonly CellRun[]) => void): void {
    this.grid.header.forEach((runs, column) => visit(HEADER_ROW, column, runs));
    this.grid.rows.forEach((cells, row) => cells.forEach((runs, column) => visit(row, column, runs)));
  }

  private drawTable(view: EditorView, wrap: HTMLElement): HTMLElement {
    const table = document.createElement("table");
    table.className = "cm-lp-grid-table";
    const host = this.canEdit ? this.chromeHost(view, wrap) : null;

    const head = document.createElement("thead");

    /*
      The handles are cells of the table rather than boxes floating over it.
      A gutter column on the left and a strip across the top mean every handle
      is laid out by the table itself, beside the row or above the column it
      acts on, at whatever width that column turned out to be — the
      alternative is measuring the grid and positioning nine buttons against
      it, which is wrong for a frame every keystroke rebuilds.

      Only while the note can be edited. A reader's table has no gutter and no
      strip, so it is exactly the table it always was.
    */
    if (host !== null) {
      const strip = document.createElement("tr");
      strip.className = "cm-lp-grid-strip";
      const corner = document.createElement("th");
      corner.className = "cm-lp-grid-corner";
      corner.append(tableHandle(host));
      strip.append(corner);
      this.grid.header.forEach((_cell, column) => {
        const slot = document.createElement("th");
        slot.className = "cm-lp-grid-colslot";
        slot.dataset.lpColumnHandle = String(column);
        slot.append(columnHandle(host, column));
        strip.append(slot);
      });
      head.append(strip);
    }

    const headRow = document.createElement("tr");
    if (host !== null) headRow.append(gutterCell("th"));
    this.grid.header.forEach((cell, column) => {
      headRow.append(this.drawCell(view, wrap, "th", cell, HEADER_ROW, column));
    });
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    this.grid.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      if (host !== null) {
        const gutter = gutterCell("td");
        gutter.append(rowHandle(host, index));
        tr.append(gutter);
      }
      row.forEach((cell, column) => {
        tr.append(this.drawCell(view, wrap, "td", cell, index, column));
      });
      body.append(tr);
    });
    table.append(body);
    return table;
  }

  private drawCell(
    view: EditorView,
    wrap: HTMLElement,
    tag: "th" | "td",
    runs: readonly CellRun[],
    row: number,
    column: number,
  ): HTMLElement {
    const cell = document.createElement(tag);
    cell.dataset.lpRow = String(row);
    cell.dataset.lpColumn = String(column);
    paintCell(cell, runs, this.grid.align[column] ?? null);

    /*
      A column GFM padded into a short row has no characters in the file, so
      there is nothing for a keystroke in it to replace — see
      `TableGrid.headerSpans`. Drawn, and not editable, which is the same
      answer `editability` gives about a control that could only ever fail.
    */
    if (this.canEdit && spanOf(this.grid, row, column) !== null) {
      makeCellEditable(view, wrap, cell, row, column);
    }
    return cell;
  }


  /**
   * The four things a person can do to a table's shape.
   *
   * Pinned to the frame and revealed on hover or focus, so an editable table
   * that nobody is working in looks exactly like the one a reader gets. The two
   * deletions stay disabled until a cell in *this* grid has been focused,
   * because "delete row" with no row named has to guess, and the guess is a
   * row of somebody's note.
   *
   * `mousedown` is cancelled on each of them: a press on a button moves focus,
   * and the cell losing focus is how the widget would forget which row the
   * person meant a fraction of a second before being asked to delete it.
   */
  /**
   * What the handles ask, answered from the table as it is **now**.
   *
   * Never from the grid this widget was built with: a person can press two
   * menu items before a redraw, and a plan made against the first one's
   * document would delete a row that has already moved. Same argument as
   * `ImageRowWidget.rowNow`, and the reason every action re-reads the region.
   */
  private chromeHost(view: EditorView, wrap: HTMLElement): GridChromeHost {
    const now = () => drawnGrids.get(wrap)?.grid ?? this.grid;
    return {
      rows: () => now().rows.length,
      columns: () => now().header.length,
      align: (column) => now().align[column] ?? null,
      cellsOfRow: (row) => [...wrap.querySelectorAll<HTMLElement>(`[data-lp-row="${row}"]`)],
      cellsOfColumn: (column) => [
        ...wrap.querySelectorAll<HTMLElement>(`[data-lp-column="${column}"]`),
      ],
      run: (action) => this.runAction(view, wrap, action),
    };
  }

  /**
   * One thing a person asked of the table's shape, done.
   *
   * Every branch ends by putting the caret somewhere sensible, and that is not
   * a nicety: a structural change is undone with ⌘Z, and ⌘Z goes to whatever
   * has focus. After a press on a menu item that is the menu, which is gone —
   * so the grid hands focus to a cell that still exists, or to the note.
   */
  private runAction(view: EditorView, wrap: HTMLElement, action: GridAction): void {
    const region = regionOf(view, wrap);
    if (region === null || view.state.readOnly) return;
    const state = view.state;

    switch (action.kind) {
      case "insert-row": {
        if (!dispatchPlan(view, planInsertRow(state, region, action.at, action.where))) return;
        focusCell(wrap, action.where === "below" ? action.at + 1 : action.at, 0, "end");
        return;
      }
      case "delete-row": {
        if (!dispatchPlan(view, planDeleteRow(state, region, action.at))) return;
        // The row below took this one's index, or the one above is the last.
        const rows = drawnGrids.get(wrap)?.grid.rows.length ?? 0;
        focusCell(wrap, Math.min(action.at, rows - 1), 0, "end");
        return;
      }
      case "move-row": {
        if (!dispatchPlan(view, planMoveRow(state, region, action.at, action.by))) return;
        // The caret follows the row rather than staying at the index.
        focusCell(wrap, action.at + action.by, 0, "end");
        return;
      }
      case "insert-column": {
        if (!dispatchPlan(view, planInsertColumn(state, region, action.at, action.where))) return;
        focusCell(wrap, HEADER_ROW, action.where === "right" ? action.at + 1 : action.at, "end");
        return;
      }
      case "delete-column": {
        if (!dispatchPlan(view, planDeleteColumn(state, region, action.at))) return;
        const columns = drawnGrids.get(wrap)?.grid.header.length ?? 0;
        focusCell(wrap, HEADER_ROW, Math.min(action.at, columns - 1), "end");
        return;
      }
      case "move-column": {
        if (!dispatchPlan(view, planMoveColumn(state, region, action.at, action.by))) return;
        focusCell(wrap, HEADER_ROW, action.at + action.by, "end");
        return;
      }
      case "align-column": {
        dispatchPlan(view, planAlignColumn(state, region, action.at, action.align));
        return;
      }
      case "edit-source": {
        /*
          The escape hatch, and the one action that writes nothing. The table
          gives way to its own pipes and the caret goes into them, which is
          the state `writingTable` already models for a table being typed —
          so leaving is the same gesture as leaving one you just wrote.
        */
        view.focus();
        view.dispatch({
          selection: { anchor: Math.min(region.to, view.state.doc.length) },
          effects: showTableSource(region.from),
          scrollIntoView: true,
        });
        return;
      }
      case "delete-table": {
        const at = region.from;
        if (!dispatchPlan(view, planDeleteTable(state, region))) return;
        view.focus();
        view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) } });
        return;
      }
    }
  }

  /** The two appends, which need no menu to say what they will do. */
  private drawAppends(view: EditorView, wrap: HTMLElement): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-lp-grid-controls";
    bar.append(
      appendButton("Add row at the end", "+ row", () => {
        const region = regionOf(view, wrap);
        if (region === null) return;
        const rows = drawnGrids.get(wrap)?.grid.rows.length ?? this.grid.rows.length;
        if (!dispatchPlan(view, planAddRow(view.state, region, rows - 1))) return;
        focusCell(wrap, rows, 0, "end");
      }),
      appendButton("Add column at the end", "+ col", () => {
        const region = regionOf(view, wrap);
        if (region === null) return;
        const columns = drawnGrids.get(wrap)?.grid.header.length ?? this.grid.header.length;
        if (!dispatchPlan(view, planAddColumn(view.state, region, columns - 1))) return;
        focusCell(wrap, HEADER_ROW, columns, "end");
      }),
    );
    return bar;
  }

  /**
   * The grid is going off the screen, so its menus go with it.
   *
   * A menu is drawn on the document's body rather than inside the grid, which
   * is what keeps it out of the scroller that would clip it — and means
   * nothing removes it when CodeMirror throws the widget away. Scrolling a
   * table out of the viewport does exactly that, and the menu left behind
   * would act on a row through a handle that is no longer anywhere.
   */
  destroy(): void {
    closeGridMenu();
  }

  /*
    Every event inside the grid is the grid's. CodeMirror's default is to
    ignore events in a widget already; saying it for all of them is what keeps
    a click into a cell from also being a click into the document, and a
    keystroke in a cell from also being one in the note.
  */
  ignoreEvent(): boolean {
    return true;
  }

  /*
    And every mutation inside it is this widget writing to its own DOM — a
    focused cell showing its source, a redraw after a blur. Without this
    CodeMirror reads those as edits to the document it is displaying and writes
    them into the file a second time.
  */
  ignoreMutation(): boolean {
    return true;
  }
}

/** A cell of the handle gutter: chrome, never content, never editable. */
function gutterCell(tag: "th" | "td"): HTMLElement {
  const cell = document.createElement(tag);
  cell.className = "cm-lp-grid-gutter";
  return cell;
}
