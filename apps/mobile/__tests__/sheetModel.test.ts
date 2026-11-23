/**
 * The sheet's pure parts, in plain node: what shows (filters, sorts), what a
 * footer adds up to, how a selection moves, and every text edit the grid makes.
 *
 * These are the rules the gateway's query and the csv format already hold, so a
 * row the grid shows is a row a query returns. Nothing here renders.
 *
 * SABOTAGE: an edit that rewrote every value on a type change, or a sum that
 * counted an empty cell as zero, fails the cases below.
 */

import { describe, expect, test } from "@jest/globals";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import {
  appendRow,
  columnIndex,
  editCell,
  insertColumn,
  removeColumn,
  renameColumnText,
  retypeColumn,
  storedValue,
} from "../features/console/files/sheet/sheetEdits";
import {
  calcValue,
  compareCells,
  displayText,
  dropFromView,
  filterOpsFor,
  moveSelection,
  problemLines,
  renameInView,
  rowCountLabel,
  toRowFilter,
  visibleRows,
  EMPTY_VIEW,
  type SheetData,
  type SheetViewState,
} from "../features/console/files/sheet/sheetModel";

const TEXT = ["name,renews:date,amount:usd,status:select,paid:checkbox", "Netflix,2026-12-01,$15,Active,true", "Gym,2026-11-20,40,,false", "Hulu,2026-12-09,,Paused,true", ""].join("\n");

function sheetOf(text: string): SheetData {
  return parseSheet(text) as unknown as SheetData;
}

const view = (patch: Partial<SheetViewState>): SheetViewState => ({ ...EMPTY_VIEW, ...patch });

describe("which rows show", () => {
  test("with no filter or sort, every row in file order", () => {
    expect(visibleRows(sheetOf(TEXT), EMPTY_VIEW)).toEqual([0, 1, 2]);
  });

  test("a filter narrows by the csv module's rules: contains is case-insensitive", () => {
    const rows = visibleRows(sheetOf(TEXT), view({ filters: [{ column: "name", op: "contains", value: "U" }] }));
    expect(rows).toEqual([2]);
  });

  test("a checkbox filter is is / is not 'true'", () => {
    const sheet = sheetOf(TEXT);
    expect(visibleRows(sheet, view({ filters: [{ column: "paid", op: "is checked", value: "" }] }))).toEqual([0, 2]);
    expect(visibleRows(sheet, view({ filters: [{ column: "paid", op: "is not checked", value: "" }] }))).toEqual([1]);
    expect(toRowFilter({ column: "paid", op: "is not checked", value: "" })).toEqual({ column: "paid", op: "is not", value: "true" });
  });

  test("a sort orders numbers as numbers and keeps equal rows in file order", () => {
    const sheet = sheetOf(TEXT);
    // Empty sorts first ascending, then 15 before 40; descending is the exact reverse.
    expect(visibleRows(sheet, view({ sort: { column: "amount", direction: "asc" } }))).toEqual([2, 0, 1]);
    expect(visibleRows(sheet, view({ sort: { column: "amount", direction: "desc" } }))).toEqual([1, 0, 2]);
  });

  test("a sort on a column that is gone is ignored rather than crashing", () => {
    expect(visibleRows(sheetOf(TEXT), view({ sort: { column: "missing", direction: "asc" } }))).toEqual([0, 1, 2]);
  });

  test("the count says rows, or how many of how many once a filter is on", () => {
    expect(rowCountLabel(1, 1)).toBe("1 row");
    expect(rowCountLabel(3, 3)).toBe("3 rows");
    expect(rowCountLabel(1, 3)).toBe("1 of 3 rows");
  });

  test("filter operators per type are the ones the type means", () => {
    expect(filterOpsFor("select")).toEqual(["is", "is not"]);
    expect(filterOpsFor("date")).toEqual(["after", "before", "is"]);
    expect(filterOpsFor("checkbox")).toEqual(["is checked", "is not checked"]);
  });
});

describe("footer calculations", () => {
  const sheet = sheetOf(TEXT);
  const amount = sheet.columns.find((c) => c.name === "amount")!;
  const renews = sheet.columns.find((c) => c.name === "renews")!;
  const all = [0, 1, 2];

  test("Sum counts a money column and skips the empty cell, rather than treating it as zero", () => {
    expect(calcValue("Sum", sheet, amount, all)).toBe("$55");
  });

  test("Average, Min and Max are over the numbers present", () => {
    expect(calcValue("Average", sheet, amount, all)).toBe("$27.5");
    expect(calcValue("Min", sheet, amount, all)).toBe("$15");
    expect(calcValue("Max", sheet, amount, all)).toBe("$40");
  });

  test("Count counts the values present; Latest takes the newest by the date column", () => {
    expect(calcValue("Count", sheet, amount, all)).toBe("2");
    expect(calcValue("Latest", sheet, sheet.columns.find((c) => c.name === "name")!, all)).toBe("Hulu");
    expect(calcValue("Latest", sheet, renews, [0, 1])).toBe("Dec 1, 2026");
  });

  test("a number calculation on a text column says nothing rather than a wrong sum", () => {
    const name = sheet.columns.find((c) => c.name === "name")!;
    expect(calcValue("Sum", sheet, name, all)).toBe("");
  });

  test("a value that is not a number is left out of Sum", () => {
    const bad = sheetOf("n:number\n1\nx\n2\n");
    expect(calcValue("Sum", bad, bad.columns[0], [0, 1, 2])).toBe("3");
  });

  test("display: money with dollars, dates in words, a misfit left exactly as written", () => {
    expect(displayText("usd", "1200")).toBe("$1,200");
    expect(displayText("date", "2026-12-01")).toBe("Dec 1, 2026");
    expect(displayText("date", "soon")).toBe("soon");
  });
});

describe("the view follows its columns", () => {
  const busy = view({
    filters: [{ column: "status", op: "is", value: "Paused" }],
    sort: { column: "status", direction: "asc" },
    hidden: ["paid"],
    calcs: { amount: "Max", status: "Count" },
  });

  test("a rename carries the filter, sort, hidden list and calculation over", () => {
    const next = renameInView(busy, "status", "state");
    expect(next.filters).toEqual([{ column: "state", op: "is", value: "Paused" }]);
    expect(next.sort).toEqual({ column: "state", direction: "asc" });
    expect(next.calcs).toEqual({ amount: "Max", state: "Count" });
    expect(renameInView(busy, "paid", "settled").hidden).toEqual(["settled"]);
  });

  test("a delete drops everything that named the column", () => {
    const next = dropFromView(busy, "status");
    expect(next.filters).toEqual([]);
    expect(next.sort).toBeNull();
    expect(next.calcs).toEqual({ amount: "Max" });
    expect(dropFromView(busy, "paid").hidden).toEqual([]);
  });
});

describe("selection and the parser's problems", () => {
  test("moving stays inside what shows and never leaves the grid", () => {
    expect(moveSelection([4, 7], ["a", "b"], { row: 7, col: "b" }, 1, 1)).toEqual({ row: 7, col: "b" });
    expect(moveSelection([4, 7], ["a", "b"], { row: 4, col: "a" }, 1, 0)).toEqual({ row: 7, col: "a" });
    expect(moveSelection([], ["a"], null, 1, 0)).toBeNull();
  });

  test("a move from nothing starts at the first cell", () => {
    expect(moveSelection([3, 5], ["a", "b"], null, 0, 1)).toEqual({ row: 3, col: "b" });
  });

  test("the first three problems, with their lines", () => {
    const errors = [
      { line: 2, message: "one" },
      { line: 3, message: "two" },
      { line: 4, message: "three" },
      { line: 5, message: "four" },
    ];
    expect(problemLines(errors)).toEqual(["Line 2: one", "Line 3: two", "Line 4: three"]);
    expect(problemLines([{ line: 0, message: "sheet is over 5 bytes" }])).toEqual(["sheet is over 5 bytes"]);
  });

  test("compareCells: numbers by value, text naturally", () => {
    expect(compareCells("usd", "9", "10")).toBeLessThan(0);
    expect(compareCells("text", "item 2", "item 10")).toBeLessThan(0);
  });
});

describe("every edit the grid makes is text in, text out", () => {
  test("a cell edit sets one row by its index and leaves the rest of the file as it was", () => {
    const next = editCell(TEXT, 1, "name", "Gym Plus");
    expect(next).toBe(
      ["name,renews:date,amount:usd,status:select,paid:checkbox", "Netflix,2026-12-01,$15,Active,true", "Gym Plus,2026-11-20,40,,false", "Hulu,2026-12-09,,Paused,true", ""].join("\n"),
    );
  });

  test("a number is written as the number, a usd figure as its digits", () => {
    expect(storedValue("usd", " $1,200 ")).toBe("1200");
    expect(storedValue("number", "3.50")).toBe("3.5");
    expect(storedValue("number", "three")).toBe("three");
    expect(storedValue("text", " hi ")).toBe("hi");
  });

  test("a checkbox is written as true or false", () => {
    expect(editCell(TEXT, 0, "paid", "false")).toContain("Netflix,2026-12-01,$15,Active,false");
  });

  test("an edit to a row or column that is not there changes nothing", () => {
    expect(editCell(TEXT, 99, "name", "x")).toBe(TEXT);
    expect(editCell(TEXT, 0, "nope", "x")).toBe(TEXT);
  });

  test("a new row is empty in every column", () => {
    const next = appendRow(TEXT);
    expect(next.split("\n").at(-2)).toBe(",,,,");
    expect(parseSheet(next).rows).toHaveLength(4);
  });

  test("a changed type keeps every value and reports the ones that no longer fit", () => {
    const { text, misfits } = retypeColumn(TEXT, "amount", "date");
    expect(misfits).toBe(2);
    expect(text.split("\n")[0]).toBe("name,renews:date,amount:date,status:select,paid:checkbox");
    expect(text).toContain("Netflix,2026-12-01,$15,Active,true");
  });

  test("insert puts a column at a position and leaves the values of the others alone", () => {
    const at = columnIndex(TEXT, "amount");
    const next = insertColumn(TEXT, at + 1, "note");
    expect(next.split("\n")[0]).toBe("name,renews:date,amount:usd,note,status:select,paid:checkbox");
    expect(next.split("\n")[1]).toBe("Netflix,2026-12-01,$15,,Active,true");
  });

  test("rename and delete keep every row", () => {
    expect(renameColumnText(TEXT, "status", "state").split("\n")[0]).toContain("state:select");
    const gone = removeColumn(TEXT, "paid");
    expect(gone.split("\n")[0]).toBe("name,renews:date,amount:usd,status:select");
    expect(parseSheet(gone).rows).toHaveLength(3);
  });

  test("the text a select or person cell takes is as typed, trimmed", () => {
    expect(storedValue("select", "  New option ")).toBe("New option");
  });
});
