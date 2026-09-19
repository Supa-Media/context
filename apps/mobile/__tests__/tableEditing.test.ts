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

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "../features/console/files/editorSetup";
import { engageEditor } from "../features/console/files/livePreview";
import { MARKERS, insertTable, toggleWrap } from "../features/console/files/markdownFormat";

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

/*
  Every test mounts an editor into `document.body` and some of them open a
  menu, which is drawn on the body rather than inside the grid's own scroller.
  Left there, the next test's `document.querySelector` finds the last one's —
  the leak `app-and-console.md` records from the console-chrome work, and one
  that also leaves a selection pointing into a destroyed view.
*/
afterEach(() => {
  document.querySelectorAll(".cm-lp-grid-menu").forEach((menu) => menu.remove());
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

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

  test("Enter on the last row adds one under it, in the same column", () => {
    // Enter is continuing down a column, so it stays in that column; Tab has
    // just run off the end of a row and starts the next one at its first cell.
    const view = mount();
    const cell = cellOf(view, 0, 1);
    cell.focus();
    press(cell, "Enter");
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |");
    expect(document.activeElement).toBe(cellOf(view, 1, 1));
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

/**
 * THE SHAPE OF THE TABLE, AND THE CONTROL THAT NAMES ITS OWN TARGET.
 *
 * What this replaced was a bar of four buttons acting on "the last cell that
 * had the caret", and the report it earned was *deleting a row is not really
 * possible*. Measured in a browser, two things were true of it: the obvious
 * gesture — hover the table, press delete row — did nothing at all because
 * the button was disabled until a cell had been focused, and once one had
 * been, the button stayed armed after the caret left the table and deleted a
 * row chosen by something nobody was looking at.
 *
 * So the controls belong to the rows and columns now. A handle in the gutter
 * beside a row acts on that row; one above a column acts on that column; the
 * corner acts on the table.
 */
describe("the shape of the table is editable too", () => {
  /** Press a handle and return the menu it opened. */
  function openMenu(view: EditorView, label: string): HTMLElement {
    const handle = view.dom.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    if (handle === null) throw new Error(`no handle labelled ${label}`);
    handle.click();
    const menu = document.querySelector<HTMLElement>(".cm-lp-grid-menu");
    if (menu === null) throw new Error(`pressing ${label} opened no menu`);
    return menu;
  }

  function choose(menu: HTMLElement, label: string): void {
    const item = [...menu.querySelectorAll<HTMLElement>(".cm-lp-grid-menu-item")].find(
      (row) => row.textContent === label,
    );
    if (item === undefined) {
      throw new Error(
        `no item "${label}" — the menu offers ${[...menu.querySelectorAll(".cm-lp-grid-menu-item")]
          .map((row) => row.textContent)
          .join(", ")}`,
      );
    }
    item.click();
  }

  test("every row has a handle of its own, and it says which row it is", () => {
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n") });
    const labels = [...view.dom.querySelectorAll("button[aria-label]")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toContain("Row 1 actions");
    expect(labels).toContain("Row 2 actions");
    expect(labels).toContain("Column 1 actions");
    expect(labels).toContain("Table actions");
    view.destroy();
  });

  test("a row is deleted by its own handle, with no cell focused first", () => {
    // The gesture that used to do nothing: no caret anywhere near the table.
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n") });
    choose(openMenu(view, "Row 1 actions"), "Delete row");
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 2 |"].join("\n"));
    view.destroy();
  });

  test("and it is that row, not the one somebody last had the caret in", () => {
    /*
      The second half of the defect: the old bar deleted by remembered
      coordinates, so a caret in row 2 and a press of delete took row 2 out
      however far away the pointer was.
    */
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |", "| 3 |"].join("\n") });
    cellOf(view, 2, 0).dispatchEvent(new window.FocusEvent("focus"));
    choose(openMenu(view, "Row 1 actions"), "Delete row");
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 2 |", "| 3 |"].join("\n"));
    view.destroy();
  });

  test("the handle of the second row takes out the second row", () => {
    /*
      Pinned separately from the case above, and by a sabotage: a handle that
      forgot its own index and always acted on the first row passed every
      other test in this file, because every other one presses "Row 1".
    */
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |", "| 3 |"].join("\n") });
    choose(openMenu(view, "Row 2 actions"), "Delete row");
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 1 |", "| 3 |"].join("\n"));
    view.destroy();
  });

  test("and the second column's handle takes out the second column", () => {
    const view = mount({ doc: ["| a | b | c |", "| - | - | - |", "| 1 | 2 | 3 |"].join("\n") });
    choose(openMenu(view, "Column 2 actions"), "Insert column left");
    expect(view.state.doc.toString()).toBe(
      ["| a |  | b | c |", "| - | --- | - | - |", "| 1 |  | 2 | 3 |"].join("\n"),
    );
    view.destroy();
  });

  test("a row can be inserted above, which the append could never reach", () => {
    const view = mount();
    choose(openMenu(view, "Row 1 actions"), "Insert row above");
    expect(view.state.doc.toString()).toContain("| --- | --- |\n|  |  |\n| 1 | 2 |");
    view.destroy();
  });

  test("and moved, which is the alternative to retyping it", () => {
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n") });
    choose(openMenu(view, "Row 1 actions"), "Move row down");
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 2 |", "| 1 |"].join("\n"));
    view.destroy();
  });

  test("the first row is not offered a move up, because there is nowhere to go", () => {
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n") });
    const labels = [...openMenu(view, "Row 1 actions").querySelectorAll(".cm-lp-grid-menu-item")].map(
      (row) => row.textContent,
    );
    expect(labels).toEqual(["Insert row above", "Insert row below", "Move row down", "Delete row"]);
    view.destroy();
  });

  test("a column's handle deletes, inserts and moves its own column", () => {
    const view = mount({ doc: ["| a | b | c |", "| - | - | - |", "| 1 | 2 | 3 |"].join("\n") });
    choose(openMenu(view, "Column 2 actions"), "Delete column");
    expect(view.state.doc.toString()).toBe(
      ["| a | c |", "| - | - |", "| 1 | 3 |"].join("\n"),
    );
    view.destroy();
  });

  test("and sets the alignment, which lives in the one row nobody can see", () => {
    const view = mount();
    choose(openMenu(view, "Column 2 actions"), "Align right");
    expect(view.state.doc.toString()).toContain("| --- | --: |");
    // The menu says which one is on, so the state is legible next time.
    const menu = openMenu(view, "Column 2 actions");
    const current = menu.querySelector(".cm-lp-grid-menu-current");
    expect(current?.textContent).toBe("Align right");
    view.destroy();
  });

  test("the last column is not offered a deletion: what is left is not a table", () => {
    const view = mount({ doc: ["| a |", "| - |", "| 1 |"].join("\n") });
    const labels = [...openMenu(view, "Column 1 actions").querySelectorAll(".cm-lp-grid-menu-item")]
      .map((row) => row.textContent);
    expect(labels).not.toContain("Delete column");
    view.destroy();
  });

  test("the corner deletes the whole table, which nothing else could", () => {
    // The caret cannot get inside an atomic range to select the lines by hand.
    const view = mount({ doc: `# Title\n\n${TABLE}\n\nafter\n` });
    choose(openMenu(view, "Table actions"), "Delete table");
    expect(view.state.doc.toString()).toBe("# Title\n\nafter\n");
    view.destroy();
  });

  test("and hands the pipes back, for everything the menus have no verb for", () => {
    const view = mount();
    expect(view.dom.querySelector(".cm-lp-grid")).not.toBeNull();
    choose(openMenu(view, "Table actions"), "Edit as text");
    expect(view.dom.querySelector(".cm-lp-grid")).toBeNull();
    expect(view.dom.textContent).toContain("| --- | --- |");
    view.destroy();
  });

  test("the row a menu is about is marked while it is open", () => {
    // The old control acted on a row nobody could see. This one says which.
    const view = mount();
    openMenu(view, "Row 1 actions");
    expect(cellOf(view, 0, 0).classList.contains("cm-lp-grid-target")).toBe(true);
    // Escape closes it and takes the mark off.
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".cm-lp-grid-menu")).toBeNull();
    expect(cellOf(view, 0, 0).classList.contains("cm-lp-grid-target")).toBe(false);
    view.destroy();
  });

  test("the two appends are buttons, because a menu cannot make them clearer", () => {
    const view = mount();
    control(view, "Add row at the end").click();
    expect(view.state.doc.toString()).toContain("| 1 | 2 |\n|  |  |");
    control(view, "Add column at the end").click();
    expect(view.state.doc.toString()).toContain("| a | b |  |");
    view.destroy();
  });

  test("a reader gets no handles at all", () => {
    const view = mount({ editable: false });
    expect(view.dom.querySelector(".cm-lp-grid-handle")).toBeNull();
    expect(view.dom.querySelector(".cm-lp-grid-gutter")).toBeNull();
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

/**
 * THE ONE REVEAL THAT SURVIVES AT THE TABLE'S OWN SIZE.
 *
 * Found in a browser, not here: typing a table by hand stopped working the
 * moment the delimiter row was finished, because the block parsed, the grid
 * was drawn over it, and the next two rows landed in a paragraph under the
 * table. A table the *document's* caret is inside is left as its own pipes.
 *
 * It does not undraw a grid somebody is working in, because a caret in a cell
 * is not a caret in the document — the cell is a widget's own editable DOM and
 * `state.selection` stays outside the table while it is used.
 */
describe("a table being typed is left as the characters being typed", () => {
  /** Type at the caret, the way a keystroke reaches the document. */
  function typeInto(view: EditorView, text: string): void {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
  }

  test("finishing the delimiter row does not swallow the rows after it", () => {
    /*
      The browser case, reproduced. `| - | - |` parses as a table in the
      middle of typing the dashes, so the grid used to appear right there,
      take the two lines off the screen, and leave the rest of what was typed
      going in somewhere nobody could see: measured in Chromium, the delimiter
      row finished as `-- |` under a two-column grid.
    */
    const view = mount({ doc: "" });
    view.dispatch({ effects: engageEditor(true) });
    typeInto(view, "| a | b |\n");
    typeInto(view, "| --- | --- |");
    expect(view.dom.querySelector(".cm-lp-grid")).toBeNull();
    expect(view.dom.textContent).toContain("| --- | --- |");

    typeInto(view, "\n| 1 | 2 |");
    expect(view.dom.querySelector(".cm-lp-grid")).toBeNull();
    expect(view.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");

    // And the moment the caret leaves, it is a grid with that row in it.
    view.dispatch({ selection: { anchor: 0 } });
    expect(cellOf(view, 0, 0).textContent).toBe("1");
    view.destroy();
  });

  test("arrowing about inside the one being written keeps its pipes", () => {
    const view = mount({ doc: "" });
    view.dispatch({ effects: engageEditor(true) });
    typeInto(view, "| a | b |\n| --- | --- |");
    // A selection-only move that stays in the table is fixing a character,
    // not finishing: the courtesy every construct here extends to the thing
    // you are editing.
    view.dispatch({ selection: { anchor: 4 } });
    expect(view.dom.querySelector(".cm-lp-grid")).toBeNull();
    view.destroy();
  });

  test("an edit elsewhere does not reveal a table the caret merely starts at", () => {
    /*
      `openingCaret` parks at the first line of the writing, which on plenty of
      notes is a table's own first character. An edit further down the note is
      not somebody typing that table.
    */
    const doc = `${TABLE}\n\ntail\n`;
    const view = mount({ doc });
    view.dispatch({ effects: engageEditor(true) });
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ changes: { from: doc.length - 1, insert: " more" } });
    expect(view.dom.querySelector(".cm-lp-grid")).not.toBeNull();
    view.destroy();
  });

  test("a cell taking the caret hands the table over", () => {
    /*
      Otherwise the table somebody has just finished typing would still be
      revealed as source behind the cell they clicked.
    */
    const view = mount({ doc: "" });
    view.dispatch({ effects: engageEditor(true) });
    typeInto(view, "| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(view.dom.querySelector(".cm-lp-grid")).toBeNull();

    view.dispatch({ selection: { anchor: 0 } });
    const cell = cellOf(view, 0, 0);
    cell.dispatchEvent(new window.FocusEvent("focus"));
    expect(view.dom.querySelector(".cm-lp-grid")).not.toBeNull();
    view.destroy();
  });

  test("and Escape leaves the grid drawn behind the caret it just handed back", () => {
    // The caret lands at the table's own end, which is a position inside it —
    // so the gesture says so explicitly rather than relying on where it lands.
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    press(cell, "Escape");
    expect(view.dom.querySelector(".cm-lp-grid")).not.toBeNull();
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

/* -------------------------------------------------------------------------- */

/**
 * ⌘B IN A CELL, which used to bold a word behind the table.
 *
 * The gap was stated when the grid became editable and is the one people meet
 * first: focus is in a widget's own `contenteditable`, so every formatting
 * verb acted on the document's selection — somewhere else entirely — and left
 * the cell alone. The decision is `planToggle`'s either way, so the
 * CommonMark run rule is the same one a paragraph gets.
 */
describe("the formatting verbs reach the cell that has the caret", () => {
  /** Select `word` inside a focused cell, the way a double-click would. */
  function selectIn(cell: HTMLElement, word: string): void {
    const node = cell.firstChild!;
    const at = (cell.textContent ?? "").indexOf(word);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + word.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  test("Bold wraps the cell's own word and writes it to that cell", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(new window.FocusEvent("focus"));
    selectIn(cell, "1");

    toggleWrap(view, MARKERS.bold.before, MARKERS.bold.after);

    expect(cell.textContent).toBe("**1**");
    expect(view.state.doc.toString()).toContain("| **1** | 2 |");
    // And nothing else in the note moved.
    expect(view.state.doc.toString()).toContain("# Title");
    view.destroy();
  });

  test("pressing it again takes the markers off", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(new window.FocusEvent("focus"));
    selectIn(cell, "1");
    toggleWrap(view, MARKERS.bold.before, MARKERS.bold.after);
    toggleWrap(view, MARKERS.bold.before, MARKERS.bold.after);

    expect(cell.textContent).toBe("1");
    expect(view.state.doc.toString()).toContain("| 1 | 2 |");
    view.destroy();
  });

  test("italic inside bold composes rather than eating a pair", () => {
    // The rule `markerPresent` exists for, exercised where it had never run:
    // `**1**` with `1` selected has a `*` either side of the selection.
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(new window.FocusEvent("focus"));
    selectIn(cell, "1");
    toggleWrap(view, MARKERS.bold.before, MARKERS.bold.after);
    selectIn(cell, "1");
    toggleWrap(view, MARKERS.italic.before, MARKERS.italic.after);

    expect(cell.textContent).toBe("***1***");
    view.destroy();
  });

  test("and with no cell focused the document still gets it", () => {
    const view = mount();
    view.dispatch({ selection: { anchor: 2, head: 7 } });
    toggleWrap(view, MARKERS.bold.before, MARKERS.bold.after);
    expect(view.state.doc.toString()).toContain("**Title**");
    view.destroy();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * UNDO, WHICH NOTHING ELSE IN A CELL WOULD ANSWER.
 *
 * `ignoreEvent` keeps every keystroke made inside the widget away from the
 * editor's keymap, so ⌘Z in a cell reached the browser's own contenteditable
 * history — which would put characters back into the element while the file
 * kept the change. It matters most where the menus do: a destructive control
 * is only safe to press if the press can be taken back.
 */
describe("undo reaches the document from inside a cell", () => {
  test("⌘Z takes back what was typed in a cell", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(new window.FocusEvent("focus"));
    type(cell, "changed");
    expect(view.state.doc.toString()).toContain("| changed | 2 |");

    press(cell, "z");
    // A bare `z` is a letter, not a chord: the document is untouched.
    expect(view.state.doc.toString()).toContain("| changed | 2 |");

    cell.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(view.state.doc.toString()).toContain("| 1 | 2 |");
    view.destroy();
  });

  test("and takes back a row a menu deleted", () => {
    const view = mount({ doc: ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n") });
    const handle = view.dom.querySelector<HTMLElement>('button[aria-label="Row 1 actions"]')!;
    handle.click();
    const item = [...document.querySelectorAll<HTMLElement>(".cm-lp-grid-menu-item")].find(
      (row) => row.textContent === "Delete row",
    )!;
    item.click();
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 2 |"].join("\n"));

    // The caret was handed to a cell that still exists, so the chord lands
    // where a person would press it.
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe(["| a |", "| - |", "| 1 |", "| 2 |"].join("\n"));
    view.destroy();
  });

  test("Shift-Enter is a line break in the cell rather than a new row", () => {
    const view = mount();
    const cell = cellOf(view, 0, 0);
    cell.focus();
    cell.dispatchEvent(new window.FocusEvent("focus"));
    // The caret at the end of the cell, which is where focus leaves it.
    press(cell, "Enter", true);
    expect(view.state.doc.toString()).toContain("| 1<br> | 2 |");
    // And the table still has one body row: Enter alone would have added one.
    expect(view.dom.querySelectorAll("tbody tr").length).toBe(1);
    view.destroy();
  });
});
