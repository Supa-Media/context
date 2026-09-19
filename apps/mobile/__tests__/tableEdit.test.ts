/**
 * THE WRITES A DRAWN TABLE MAKES, WITHOUT A BROWSER.
 *
 * `tableEdit.ts` is the half of the editable grid that can be wrong silently:
 * an off-by-one in a delimiter offset does not throw, it puts somebody's text
 * in the column next to the one they typed it in, and the note still parses.
 * So every planner is pinned here against the characters it produces, and the
 * mounted half — focus, the caret, the controls — is `tableEditing.test.ts`.
 *
 * The rule the whole file is checking is one sentence: **a change touches the
 * span it was asked about and nothing else.** A table somebody hand-aligned
 * stays hand-aligned everywhere except the cell they are in, because the
 * alternative is a serializer, and a serializer is the thing
 * `docs/decisions/app-and-console.md` says this editor does not have.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import {
  columnCount,
  encodeCellInput,
  planAddColumn,
  planAddRow,
  planAlignColumn,
  planCellEdit,
  planDeleteColumn,
  planDeleteRow,
  planDeleteTable,
  planInsertColumn,
  planInsertRow,
  planMoveColumn,
  planMoveRow,
  rowCount,
  splitRow,
} from "../features/console/files/tableEdit";
import { markdownLanguage, tableGrids } from "../features/console/files/livePreview";

const TABLE = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

function stateFor(doc: string, options: { readOnly?: boolean } = {}): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdownLanguage(), EditorState.readOnly.of(options.readOnly ?? false)],
  });
}

/** The document a plan produces, or `null` when there was no plan. */
function applied(state: EditorState, plan: ReturnType<typeof planAddRow>): string | null {
  if (plan === null) return null;
  return state.update(plan).state.doc.toString();
}

const whole = (doc: string) => ({ from: 0, to: doc.length });

/* -------------------------------------------------------------------------- */

describe("the columns of a row are the gaps between unescaped pipes", () => {
  test("a row with outer pipes has the columns between them", () => {
    expect(splitRow("| a | b |").map((span) => "| a | b |".slice(span.from, span.to))).toEqual([
      " a ",
      " b ",
    ]);
  });

  test("an escaped pipe is a pipe in a cell, not the end of one", () => {
    // How a pipe survives a table at all, and what forms.js writes into every
    // value it puts in a response row. A splitter that missed it would cut a
    // submitted answer in half and call the remainder a column.
    const row = "| a\\|b | c |";
    expect(splitRow(row).map((span) => row.slice(span.from, span.to))).toEqual([" a\\|b ", " c "]);
  });

  test("an empty cell is still a column", () => {
    expect(splitRow("| a |  | c |").length).toBe(3);
  });

  test("and the grammar agrees with it about where the columns are", () => {
    /*
      The duplication this pins: `cellsOf` reads the tree and `splitRow` reads
      the text, and a structural edit uses the second because the delimiter row
      has no cells in the first. Two readers that disagreed would add a column
      to two lines of three.
    */
    const doc = ["| a | b\\|c | d |", "| --- | --- | --- |", "| 1 |  | 3 |"].join("\n");
    const grid = tableGrids(stateFor(doc))[0];
    const header = doc.split("\n")[0];
    expect(splitRow(header).length).toBe(grid.header.length);
    const row = doc.split("\n")[2];
    expect(splitRow(row).length).toBe(grid.rows[0].length);
  });
});

/* -------------------------------------------------------------------------- */

describe("what a person typed, as characters a cell can hold", () => {
  test("a bare pipe is escaped rather than allowed to end the cell", () => {
    expect(encodeCellInput("a|b")).toBe("a\\|b");
  });

  test("one that is already escaped is left as the pipe it is", () => {
    expect(encodeCellInput("a\\|b")).toBe("a\\|b");
  });

  test("a newline becomes the break the cell reader already draws", () => {
    expect(encodeCellInput("one\ntwo")).toBe("one<br>two");
  });

  test("the padding is ours and the spaces inside are not", () => {
    expect(encodeCellInput("  a  b  ")).toBe("a  b");
  });

  test("an escaped backslash is not an escape for what follows it", () => {
    expect(encodeCellInput("a\\\\|b")).toBe("a\\\\\\|b");
  });
});

/* -------------------------------------------------------------------------- */

describe("typing in a cell writes that cell and nothing else", () => {
  /** The span of the body row's first cell in `TABLE`. */
  function firstBodyCell(doc: string) {
    const grid = tableGrids(stateFor(doc))[0];
    const span = grid.rowSpans[0][0];
    if (span === null) throw new Error("the fixture's first cell has no span");
    return span;
  }

  test("the rest of the file is byte for byte what it was", () => {
    const doc = `# Title\n\n${TABLE}\n\nafter\n`;
    const state = stateFor(doc);
    const next = applied(state, planCellEdit(state, firstBodyCell(doc), "changed"));
    expect(next).toBe(`# Title\n\n| a | b |\n| --- | --- |\n| changed | 2 |\n\nafter\n`);
  });

  test("a hand-aligned table keeps its alignment in the cells nobody touched", () => {
    const doc = ["| name    | qty |", "| ------- | --- |", "| apples  | 3   |"].join("\n");
    const state = stateFor(doc);
    const next = applied(state, planCellEdit(state, firstBodyCell(doc), "pears"));
    // Only the edited cell is re-padded. The header's own spacing is untouched,
    // which is the whole promise: no serializer walked this table.
    expect(next).toBe(["| name    | qty |", "| ------- | --- |", "| pears | 3   |"].join("\n"));
  });

  test("a typed pipe is escaped rather than becoming a third column", () => {
    const doc = TABLE;
    const state = stateFor(doc);
    const next = applied(state, planCellEdit(state, firstBodyCell(doc), "a|b"));
    expect(next).toContain("| a\\|b | 2 |");
    // And it is still a two-column table, which is the point of the escape.
    expect(columnCount(stateFor(next!), whole(next!))).toBe(2);
  });

  test("emptying a cell leaves a cell rather than closing the column", () => {
    const doc = TABLE;
    const state = stateFor(doc);
    const next = applied(state, planCellEdit(state, firstBodyCell(doc), ""));
    expect(next).toBe(["| a | b |", "| --- | --- |", "|  | 2 |"].join("\n"));
    expect(columnCount(stateFor(next!), whole(next!))).toBe(2);
  });

  test("typing what is already there plans nothing", () => {
    // An `input` event fires for things that are not edits. A transaction per
    // non-edit is an undo step per non-edit.
    const state = stateFor(TABLE);
    expect(planCellEdit(state, firstBodyCell(TABLE), "1")).toBeNull();
  });

  test("and a read-only note plans nothing at all", () => {
    const state = stateFor(TABLE, { readOnly: true });
    expect(planCellEdit(state, firstBodyCell(TABLE), "anything")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("a row, added", () => {
  test("under the row it was asked about", () => {
    const doc = ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n");
    const state = stateFor(doc);
    expect(applied(state, planAddRow(state, whole(doc), 0))).toBe(
      ["| a |", "| - |", "| 1 |", "|  |", "| 2 |"].join("\n"),
    );
  });

  test("with one cell per column of the header", () => {
    const doc = ["| a | b | c |", "| - | - | - |", "| 1 | 2 | 3 |"].join("\n");
    const state = stateFor(doc);
    const next = applied(state, planAddRow(state, whole(doc), 0))!;
    expect(next.split("\n")[3]).toBe("|  |  |  |");
    expect(rowCount(stateFor(next), whole(next))).toBe(2);
  });

  test("straight under the header when that is what was asked", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planAddRow(state, whole(TABLE), -1))).toBe(
      ["| a | b |", "| --- | --- |", "|  |  |", "| 1 | 2 |"].join("\n"),
    );
  });

  test("and the table still parses as one", () => {
    const state = stateFor(TABLE);
    const next = applied(state, planAddRow(state, whole(TABLE), 0))!;
    const grids = tableGrids(stateFor(next));
    expect(grids.length).toBe(1);
    expect(grids[0].rows.length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */

describe("a column, added", () => {
  test("to every line of the table, dashes included", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planAddColumn(state, whole(TABLE), 1))).toBe(
      ["| a | b |  |", "| --- | --- | --- |", "| 1 | 2 |  |"].join("\n"),
    );
  });

  test("in the middle when that is the column it was given", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planAddColumn(state, whole(TABLE), 0))).toBe(
      ["| a |  | b |", "| --- | --- | --- |", "| 1 |  | 2 |"].join("\n"),
    );
  });

  test("and the delimiter row is why the table survives it", () => {
    /*
      A header of three columns over a delimiter of two is not a table to any
      parser. The grid would vanish mid-edit and take the caret with it, so
      this is the assertion the feature rests on rather than a detail.
    */
    const state = stateFor(TABLE);
    const next = applied(state, planAddColumn(state, whole(TABLE), 1))!;
    const grids = tableGrids(stateFor(next));
    expect(grids.length).toBe(1);
    expect(grids[0].header.length).toBe(3);
    expect(grids[0].rows[0].length).toBe(3);
  });

  test("a short row gets the column at its end rather than being skipped", () => {
    const doc = ["| a | b |", "| - | - |", "| 1 |"].join("\n");
    const state = stateFor(doc);
    expect(applied(state, planAddColumn(state, whole(doc), 1))).toBe(
      ["| a | b |  |", "| - | - | --- |", "| 1 |  |"].join("\n"),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a row or a column, taken out", () => {
  test("the row goes with the newline that carried it", () => {
    const doc = ["| a |", "| - |", "| 1 |", "| 2 |"].join("\n");
    const state = stateFor(doc);
    expect(applied(state, planDeleteRow(state, whole(doc), 0))).toBe(
      ["| a |", "| - |", "| 2 |"].join("\n"),
    );
  });

  test("the last body row may go: a header over its dashes is still a table", () => {
    const state = stateFor(TABLE);
    const next = applied(state, planDeleteRow(state, whole(TABLE), 0))!;
    expect(next).toBe(["| a | b |", "| --- | --- |"].join("\n"));
    expect(tableGrids(stateFor(next)).length).toBe(1);
  });

  test("the header is not a row and cannot be deleted as one", () => {
    const state = stateFor(TABLE);
    expect(planDeleteRow(state, whole(TABLE), -1)).toBeNull();
  });

  test("a column goes from every line, and the line keeps its outer pipes", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planDeleteColumn(state, whole(TABLE), 1))).toBe(
      ["| a |", "| --- |", "| 1 |"].join("\n"),
    );
  });

  test("the first column too, without taking the opening pipe with it", () => {
    const state = stateFor(TABLE);
    const next = applied(state, planDeleteColumn(state, whole(TABLE), 0))!;
    expect(next).toBe(["| b |", "| --- |", "| 2 |"].join("\n"));
    expect(tableGrids(stateFor(next)).length).toBe(1);
  });

  test("the only column stays: what is left of a table without one is not one", () => {
    const doc = ["| a |", "| - |", "| 1 |"].join("\n");
    const state = stateFor(doc);
    expect(planDeleteColumn(state, whole(doc), 0)).toBeNull();
  });

  test("and nothing is planned in a note that cannot be written to", () => {
    const state = stateFor(TABLE, { readOnly: true });
    expect(planAddRow(state, whole(TABLE), 0)).toBeNull();
    expect(planAddColumn(state, whole(TABLE), 0)).toBeNull();
    expect(planDeleteRow(state, whole(TABLE), 0)).toBeNull();
    expect(planDeleteColumn(state, whole(TABLE), 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("the table a plan was asked about is the one in the document", () => {
  test("a table further down the note is found by its own range", () => {
    const doc = `intro\n\n${TABLE}\n\n## Next\n\n${TABLE}\n`;
    const state = stateFor(doc);
    const second = tableGrids(state)[1];
    const next = applied(state, planAddRow(state, second, 0))!;
    // The first table is untouched; the second grew.
    const grids = tableGrids(stateFor(next));
    expect(grids[0].rows.length).toBe(1);
    expect(grids[1].rows.length).toBe(2);
  });

  test("and a range with no table in it plans nothing", () => {
    const doc = "just a paragraph\n";
    const state = stateFor(doc);
    expect(syntaxTree(state).topNode.name).toBe("Document");
    // One line, so there is no delimiter row to add a column to.
    expect(planAddColumn(state, whole(doc), 0)).toBeNull();
    expect(planAddRow(state, whole(doc), 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE REST OF WHAT A TABLE NEEDS DOING TO IT.
 *
 * The first version of the grid could add a row or a column and delete one,
 * and the report that followed was "deleting a row is not really possible" —
 * which was about the control rather than the write, but the set was short
 * either way. A row you cannot move is a row you retype; a column whose
 * alignment lives in a delimiter row nobody can see cannot be set at all; and
 * a table drawn as a grid cannot be deleted, because the caret cannot get
 * inside an atomic range to select it.
 */
describe("a row or a column, inserted on a side", () => {
  test("above the first row, which append could not reach", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planInsertRow(state, whole(TABLE), 0, "above"))).toBe(
      ["| a | b |", "| --- | --- |", "|  |  |", "| 1 | 2 |"].join("\n"),
    );
  });

  test("and below it", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planInsertRow(state, whole(TABLE), 0, "below"))).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "|  |  |"].join("\n"),
    );
  });

  test("to the left of the first column, which append could not reach either", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planInsertColumn(state, whole(TABLE), 0, "left"))).toBe(
      ["|  | a | b |", "| --- | --- | --- |", "|  | 1 | 2 |"].join("\n"),
    );
  });

  test("and to the right of it", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planInsertColumn(state, whole(TABLE), 0, "right"))).toBe(
      ["| a |  | b |", "| --- | --- | --- |", "| 1 |  | 2 |"].join("\n"),
    );
  });
});

describe("a row, moved", () => {
  const THREE = ["| a |", "| - |", "| 1 |", "| 2 |", "| 3 |"].join("\n");

  test("down, as whole lines", () => {
    const state = stateFor(THREE);
    expect(applied(state, planMoveRow(state, whole(THREE), 0, 1))).toBe(
      ["| a |", "| - |", "| 2 |", "| 1 |", "| 3 |"].join("\n"),
    );
  });

  test("up", () => {
    const state = stateFor(THREE);
    expect(applied(state, planMoveRow(state, whole(THREE), 2, -1))).toBe(
      ["| a |", "| - |", "| 1 |", "| 3 |", "| 2 |"].join("\n"),
    );
  });

  test("and never into the header or past the end", () => {
    const state = stateFor(THREE);
    expect(planMoveRow(state, whole(THREE), 0, -1)).toBeNull();
    expect(planMoveRow(state, whole(THREE), 2, 1)).toBeNull();
  });

  test("a row of different length keeps every character it had", () => {
    const doc = ["| a |", "| - |", "| short |", "| a much longer cell |"].join("\n");
    const state = stateFor(doc);
    expect(applied(state, planMoveRow(state, whole(doc), 0, 1))).toBe(
      ["| a |", "| - |", "| a much longer cell |", "| short |"].join("\n"),
    );
  });
});

describe("a column, moved", () => {
  const WIDE = ["| a | b | c |", "| :-- | --- | --: |", "| 1 | 2 | 3 |"].join("\n");

  test("right, in every line including the dashes", () => {
    const state = stateFor(WIDE);
    expect(applied(state, planMoveColumn(state, whole(WIDE), 0, 1))).toBe(
      ["| b | a | c |", "| --- | :-- | --: |", "| 2 | 1 | 3 |"].join("\n"),
    );
  });

  test("so the alignment travels with the column rather than staying put", () => {
    const state = stateFor(WIDE);
    const next = applied(state, planMoveColumn(state, whole(WIDE), 2, -1))!;
    expect(tableGrids(stateFor(next))[0].align).toEqual(["left", "right", null]);
  });

  test("and never off either end", () => {
    const state = stateFor(WIDE);
    expect(planMoveColumn(state, whole(WIDE), 0, -1)).toBeNull();
    expect(planMoveColumn(state, whole(WIDE), 2, 1)).toBeNull();
  });
});

describe("a column's alignment, which lives in a row nobody can see", () => {
  test("left, centre, right and back to none", () => {
    const state = stateFor(TABLE);
    const left = applied(state, planAlignColumn(state, whole(TABLE), 0, "left"))!;
    expect(left.split("\n")[1]).toBe("| :-- | --- |");

    const centre = stateFor(left);
    const both = applied(centre, planAlignColumn(centre, whole(left), 1, "center"))!;
    expect(both.split("\n")[1]).toBe("| :-- | :-: |");

    const back = stateFor(both);
    expect(applied(back, planAlignColumn(back, whole(both), 0, null))!.split("\n")[1]).toBe(
      "| --- | :-: |",
    );
  });

  test("and the grid reads back what was written", () => {
    const state = stateFor(TABLE);
    const next = applied(state, planAlignColumn(state, whole(TABLE), 1, "right"))!;
    expect(tableGrids(stateFor(next))[0].align).toEqual([null, "right"]);
  });

  test("a table hand-aligned to wide dashes keeps its width", () => {
    const doc = ["| name    | qty |", "| ------- | --- |", "| apples  | 3   |"].join("\n");
    const state = stateFor(doc);
    expect(applied(state, planAlignColumn(state, whole(doc), 0, "right"))!.split("\n")[1]).toBe(
      "| ------: | --- |",
    );
  });
});

describe("the whole table, deleted", () => {
  test("goes with the blank line under it", () => {
    const doc = `intro\n\n${TABLE}\n\ntail\n`;
    const state = stateFor(doc);
    const region = tableGrids(state)[0];
    expect(applied(state, planDeleteTable(state, region))).toBe("intro\n\ntail\n");
  });

  test("and is the only way out of one, because the caret cannot get inside", () => {
    const state = stateFor(TABLE);
    expect(applied(state, planDeleteTable(state, whole(TABLE)))).toBe("");
  });

  test("but not in a note nobody can write to", () => {
    const state = stateFor(TABLE, { readOnly: true });
    expect(planDeleteTable(state, whole(TABLE))).toBeNull();
    expect(planMoveRow(state, whole(TABLE), 0, 1)).toBeNull();
    expect(planAlignColumn(state, whole(TABLE), 0, "left")).toBeNull();
    expect(planInsertRow(state, whole(TABLE), 0, "above")).toBeNull();
  });
});
