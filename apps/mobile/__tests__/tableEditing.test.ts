/**
 * @jest-environment jsdom
 *
 * TYPING IN A TABLE, IN A REAL VIEW.
 *
 * `tableEdit.test.ts` pins the characters. This pins the half that only exists
 * once a view is mounted, and that a pure test could not have caught: the grid
 * is a block widget, every keystroke in it is a document change, and a document
 * change rebuilds every decoration. So the bug this file exists for is not a
 * wrong character — it is the `contenteditable` cell being thrown away and
 * rebuilt underneath the person, losing focus and the caret on every letter.
 *
 * What is pinned:
 *
 *   a table in an editable note   → drawn as a grid, cells editable
 *   a table in a read-only note   → drawn as a grid, nothing editable
 *   typing in a cell              → that cell's span changes, nothing else
 *   and the element survives it   → same node, still focused, still holding
 *                                   what was typed
 *   focus                         → the cell shows its own markdown
 *   blur                          → it is drawn again
 *   Tab / Enter / Escape          → the next cell, a new row, the document
 *   the controls                  → a row, a column, and neither delete armed
 *                                   until a cell has been focused
 */

import { describe, expect, test } from "@jest/globals";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../features/console/files/editorSetup";
import { insertTable } from "../features/console/files/markdownFormat";

const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
const DOC = `# Title\n\n${TABLE}\n\nafter\n`;

function mount(options: { doc?: string; editable?: boolean } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editable = options.editable ?? true;
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc ?? DOC,
      extensions: [
        editorExtensions({
          editable,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
        EditorState.readOnly.of(!editable),
      ],
    }),
  });
}

/** One drawn cell. `row` is `-1` for the header, as the widget numbers them. */
function cellOf(view: EditorView, row: number, column: number): HTMLElement {
  const cell = view.dom.querySelector<HTMLElement>(
    `[data-lp-row="${row}"][data-lp-column="${column}"]`,
  );
  if (cell === null) throw new Error(`no cell at ${row},${column}`);
  return cell;
}

/** Type into a cell the way a browser does: the text is there, then the event. */
function type(cell: HTMLElement, text: string): void {
  cell.textContent = text;
  cell.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function press(cell: HTMLElement, key: string, shift = false): void {
  cell.dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
}

function control(view: EditorView, label: string): HTMLButtonElement {
  const button = view.dom.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (button === null) throw new Error(`no control labelled ${label}`);
  return button;
}

/* -------------------------------------------------------------------------- */

describe("a table is a table while the note is being written", () => {
  test("the grid is drawn in an editable note, not only for a reader", () => {
    // The whole request: a table that only rendered once you stopped editing
    // was a paragraph of pipes for the entire time you were working on it.
    const view = mount();
    expect(view.dom.querySelector(".cm-lp-grid-table")).not.toBeNull();
    expect(view.dom.querySelector(".cm-lp-grid-live")).not.toBeNull();
    expect(cellOf(view, 0, 0).textContent).toBe("1");
    view.destroy();
  });

  test("its cells can be typed into", () => {
    const view = mount();
    expect(cellOf(view, -1, 0).getAttribute("contenteditable")).toBe("true");
    expect(cellOf(view, 0, 1).getAttribute("contenteditable")).toBe("true");
    view.destroy();
  });

  test("and a reader gets the same grid with nothing to type into", () => {
    const view = mount({ editable: false });
    expect(view.dom.querySelector(".cm-lp-grid-table")).not.toBeNull();
    expect(view.dom.querySelector(".cm-lp-grid-live")).toBeNull();
    expect(cellOf(view, 0, 0).getAttribute("contenteditable")).toBeNull();
    // A control that could only ever fail is not drawn — `editability`'s rule.
    expect(view.dom.querySelector(".cm-lp-grid-controls")).toBeNull();
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("typing in a cell", () => {
  test("writes that cell and leaves the rest of the note alone", () => {
    const view = mount();
    type(cellOf(view, 0, 0), "changed");
    expect(view.state.doc.toString()).toBe(
      `# Title\n\n| a | b |\n| --- | --- |\n| changed | 2 |\n\nafter\n`,
    );
    view.destroy();
  });

  test("the element survives the keystroke that changed the document", () => {
    /*
      THE BUG THIS FILE EXISTS FOR. Every keystroke is a document change and a
      document change rebuilds every decoration; a widget that let CodeMirror
      replace its DOM would lose the caret on every letter. `updateDOM` keeps
      the element and skips the focused cell.
    */
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    type(cell, "wor");
    expect(cellOf(view, 0, 0)).toBe(cell);
    expect(document.activeElement).toBe(cell);
    expect(cell.textContent).toBe("wor");

    type(cell, "word");
    expect(cellOf(view, 0, 0)).toBe(cell);
    expect(view.state.doc.toString()).toContain("| word | 2 |");
    view.destroy();
  });

  test("a typed pipe is escaped rather than becoming a column", () => {
    const view = mount();
    type(cellOf(view, 0, 0), "a|b");
    expect(view.state.doc.toString()).toContain("| a\\|b | 2 |");
    // Still one two-column table: the escape is what keeps the grid drawn.
    expect(view.dom.querySelectorAll(".cm-lp-grid-table").length).toBe(1);
    expect(view.dom.querySelectorAll('[data-lp-row="0"]').length).toBe(2);
    view.destroy();
  });

  test("the header is a cell like any other", () => {
    const view = mount();
    type(cellOf(view, -1, 1), "count");
    expect(view.state.doc.toString()).toContain("| a | count |");
    view.destroy();
  });

  test("and a cell in the table above is not disturbed by one below it", () => {
    const view = mount({ doc: `${TABLE}\n\n${TABLE}\n` });
    const tables = view.dom.querySelectorAll(".cm-lp-grid");
    expect(tables.length).toBe(2);
    const second = tables[1].querySelector<HTMLElement>('[data-lp-row="0"][data-lp-column="0"]')!;
    type(second, "second");
    const lines = view.state.doc.toString().split("\n");
    expect(lines[2]).toBe("| 1 | 2 |");
    expect(lines[6]).toBe("| second | 2 |");
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("the reveal rule, at the size of a cell", () => {
  const MARKED = ["| v |", "| --- |", "| **bold** |"].join("\n");

  test("a cell that has focus shows its own markdown", () => {
    const view = mount({ doc: MARKED });
    const cell = cellOf(view, 0, 0);
    expect(cell.textContent).toBe("bold");
    cell.dispatchEvent(new window.FocusEvent("focus"));
    expect(cell.textContent).toBe("**bold**");
    expect(cell.classList.contains("cm-lp-grid-source")).toBe(true);
    view.destroy();
  });

  test("and is drawn again when it loses it", () => {
    const view = mount({ doc: MARKED });
    const cell = cellOf(view, 0, 0);
    cell.dispatchEvent(new window.FocusEvent("focus"));
    cell.dispatchEvent(new window.FocusEvent("blur"));
    expect(cell.textContent).toBe("bold");
    expect(cell.querySelector(".cm-lp-strong")).not.toBeNull();
    view.destroy();
  });

  test("the source is what is written back, so the markup survives an edit", () => {
    /*
      The half that makes this safe: the focused cell holds the characters, so
      the write is those characters. A widget that wrote back what it *drew*
      would replace `**bold**` with `bold` the first time anybody put a caret
      in the cell — a serializer, and the thing this design exists to avoid.
    */
    const view = mount({ doc: MARKED });
    const cell = cellOf(view, 0, 0);
    cell.dispatchEvent(new window.FocusEvent("focus"));
    type(cell, "**bold** and more");
    expect(view.state.doc.toString()).toBe(["| v |", "| --- |", "| **bold** and more |"].join("\n"));
    view.destroy();
  });

  test("a plain cell is left exactly as it was drawn, so a click keeps its caret", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    const text = cell.firstChild;
    cell.dispatchEvent(new window.FocusEvent("focus"));
    // Same text node: nothing was replaced, so the browser's caret is still
    // where the person put it.
    expect(cell.firstChild).toBe(text);
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("the keys that mean somewhere else in the table", () => {
  test("Tab moves to the next cell", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Tab");
    expect(document.activeElement).toBe(cellOf(view, 0, 1));
    view.destroy();
  });

  test("Shift-Tab moves back, and the header is where it stops", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Tab", true);
    expect(document.activeElement).toBe(cellOf(view, -1, 1));
    view.destroy();
  });

  test("Tab past the last cell adds a row and lands in it", () => {
    const view = mount();
    const last = cellOf(view, 0, 1);
    last.focus();
    press(last, "Tab");
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |");
    expect(document.activeElement).toBe(cellOf(view, 1, 0));
    view.destroy();
  });

  test("Enter on the last row adds one under it", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Enter");
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |");
    view.destroy();
  });

  test("Escape hands the note back with the caret after the table", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Escape");
    // The table ends where `after` begins; the caret is at its end rather than
    // inside a widget nobody can type in.
    expect(view.state.selection.main.head).toBe(DOC.indexOf("\n\nafter"));
    expect(document.activeElement).not.toBe(cell);
    view.destroy();
  });

  test("a column that is padding rather than characters is stepped over", () => {
    /*
      GFM pads a short row out to the header's width, and the column it invents
      has nothing in the file to edit. Tab landing on it would look exactly
      like Tab being broken — focus stays put and the key did nothing — so the
      move walks on to the next cell that can take a caret.
    */
    const view = mount({ doc: ["| a | b |", "| --- | --- |", "| 1 |", "| 3 | 4 |"].join("\n") });
    expect(cellOf(view, 0, 1).getAttribute("contenteditable")).toBeNull();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Tab");
    expect(document.activeElement).toBe(cellOf(view, 1, 0));
    view.destroy();
  });

  test("and the arrows walk the rows", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "ArrowUp");
    expect(document.activeElement).toBe(cellOf(view, -1, 0));
    press(cellOf(view, -1, 0), "ArrowDown");
    expect(document.activeElement).toBe(cellOf(view, 0, 0));
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("the shape of the table is editable too", () => {
  test("a row is added under the focused one", () => {
    const view = mount();
    cellOf(view, 0, 0).dispatchEvent(new window.FocusEvent("focus"));
    control(view, "Add row below").click();
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |");
    view.destroy();
  });

  test("a column is added to every line, dashes included", () => {
    const view = mount();
    cellOf(view, 0, 1).dispatchEvent(new window.FocusEvent("focus"));
    control(view, "Add column to the right").click();
    expect(view.state.doc.toString()).toContain(
      "| a | b |  |\n| --- | --- | --- |\n| 1 | 2 |  |",
    );
    // And the grid redrew with the column in it rather than falling apart.
    expect(view.dom.querySelectorAll('[data-lp-row="0"]').length).toBe(3);
    view.destroy();
  });

  test("the deletions stay disabled until a cell has been focused", () => {
    // "Delete row" with no row named has to guess, and the guess is a row of
    // somebody's note.
    const view = mount();
    expect(control(view, "Delete row").disabled).toBe(true);
    expect(control(view, "Delete column").disabled).toBe(true);
    view.destroy();
  });

  test("and then take out the row or the column that cell is in", () => {
    const view = mount({ doc: ["| a | b |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"].join("\n") });
    cellOf(view, 0, 0).dispatchEvent(new window.FocusEvent("focus"));
    control(view, "Delete row").click();
    expect(view.state.doc.toString()).toBe(["| a | b |", "| - | - |", "| 3 | 4 |"].join("\n"));

    cellOf(view, 0, 1).dispatchEvent(new window.FocusEvent("focus"));
    control(view, "Delete column").click();
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 3 |"].join("\n"));
    view.destroy();
  });

  test("a row that gains a real cell can be typed into without reopening the note", () => {
    /*
      A repaint writes text into cells that are already wired up; it does not
      wire one up. A change from somewhere else — a sync, an undo — that fills
      a short row has to rebuild, or the cell stays uneditable with nothing on
      screen saying why.
    */
    const doc = ["| a | b |", "| --- | --- |", "| 1 |"].join("\n");
    const view = mount({ doc });
    expect(cellOf(view, 0, 1).getAttribute("contenteditable")).toBeNull();

    const line = view.state.doc.line(3);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "| 1 | 2 |" } });

    expect(cellOf(view, 0, 1).getAttribute("contenteditable")).toBe("true");
    type(cellOf(view, 0, 1), "two");
    expect(view.state.doc.toString()).toContain("| 1 | two |");
    view.destroy();
  });

  test("a grid that grew is still the same element, so its controls still work", () => {
    /*
      A shape change rebuilds the table inside the *same* wrapper. If it did
      not, the button that added the row would be holding an element that is no
      longer in the document, and the second press would do nothing at all.
    */
    const view = mount();
    const wrap = view.dom.querySelector(".cm-lp-grid")!;
    control(view, "Add row below").click();
    control(view, "Add row below").click();
    expect(view.dom.querySelector(".cm-lp-grid")).toBe(wrap);
    expect(view.state.doc.toString().split("\n").filter((line) => line === "|  |  |").length).toBe(2);
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("the caret steps over a drawn table rather than into it", () => {
  test("moving forward from the line above lands past the table", () => {
    /*
      The grid is drawn while the note is editable, so without
      `EditorView.atomicRanges` arrowing down into it walks an invisible caret
      through three lines of pipes that are not on screen — the failure the old
      reading-mode-only rule never had to face.
    */
    const view = mount();
    /*
      From the table's own first character, which is a position a caret may
      hold — being *before* a block is not being inside it. One step forward
      from there is the far side of the whole table rather than the second
      pipe of a line nobody can see.
    */
    const start = DOC.indexOf("| a |");
    const moved = view.moveByChar(EditorSelection.cursor(start), true);
    expect(moved.head).toBe(DOC.indexOf("| 1 | 2 |") + "| 1 | 2 |".length);
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

describe("a table somebody has just asked for", () => {
  test("lands them in its first cell rather than inside a block they cannot see", () => {
    /*
      "4 × 3" used to put the caret two characters past the opening pipe, which
      was the first header cell's own text. There is no such position any more:
      the grid is drawn the moment the table exists, so the source the caret
      was aimed at is behind a widget. The cell takes it instead.
    */
    const view = mount({ doc: "" });
    // The boolean is what tells the caller not to focus the editor over the
    // top of the cell — `LiveEditor.web.tsx` did exactly that until a real
    // browser typed into a table nobody was in.
    expect(insertTable(view, 2, 3)).toBe(true);
    const first = cellOf(view, -1, 0);
    expect(document.activeElement).toBe(first);
    type(first, "name");
    expect(view.state.doc.toString().split("\n")[0]).toBe("| name |     |     |");
    view.destroy();
  });
});
