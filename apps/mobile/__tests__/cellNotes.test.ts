/**
 * Comments and Tex on a sheet's cell, in the app (`files/sheet/cellNotes.ts`, `cellTexRun.ts`): a thread is
 * written into the comments column the first comment makes, a reply follows its row, and Tex's answer and its
 * changes to the whole sheet are one save, refused whole when they name a column or row the sheet lacks.
 */

import { describe, expect, test } from "@jest/globals";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import { addCellThread, addToCellThread, applyTexAnswer, cellThreadsOf, threadInText } from "../features/console/files/sheet/cellNotes";
import { cellRequest } from "../features/console/files/sheet/cellTexRun";

const CSV = "Name:text,Status:text\nA,live\nB,partial\n";
const rows = (text: string) => (parseSheet(text) as unknown as { rows: Record<string, string>[] }).rows;
const threads = (text: string) => cellThreadsOf(parseSheet(text) as never);

describe("a cell's thread", () => {
  test("the first comment makes the comments column and is found by id at once", () => {
    const added = addCellThread(CSV, { row: 1, column: "Status" }, "@seyi", "@Tex is this right?");
    if ("error" in added) throw new Error(added.error);
    expect(added.text.split("\n")[0]).toBe("Name,Status,comments:comments");
    const found = threadInText(added.text, added.thread);
    expect(found?.row).toBe(1);
    expect(found?.column).toBe("Status");
    expect(rows(added.text)[1]!.Status).toBe("partial");
  });

  test("Tex's answer and its changes to other rows are one edit", () => {
    const added = addCellThread(CSV, { row: 1, column: "Status" }, "@seyi", "@Tex fix the sheet");
    if ("error" in added) throw new Error(added.error);
    const done = applyTexAnswer(added.text, added.thread, "Fixed.", { cells: [{ row: 1, column: "Status", value: "live ✅" }], append: [{ Name: "C" }], delete: [] }, "Tex");
    if (done.error !== undefined) throw new Error(done.error);
    expect(rows(done.text).map((r) => [r.Name, r.Status])).toEqual([["A", "live ✅"], ["B", "partial"], ["C", ""]]);
    expect(threads(done.text)[0]!.thread.events.map((e) => e.author)).toEqual(["@seyi", "Tex"]);
  });

  test("a change naming an unknown column, or the comments column, is refused whole and the answer kept", () => {
    const added = addCellThread(CSV, { row: 0, column: "Name" }, "@seyi", "@Tex go");
    if ("error" in added) throw new Error(added.error);
    for (const column of ["Nope", "comments"]) {
      const done = applyTexAnswer(added.text, added.thread, "Done.", { cells: [{ row: 1, column, value: "x" }], append: [], delete: [2] }, "Tex");
      expect(done.refused).toBe(true);
      expect(rows(done.text!).length).toBe(2);
      expect(threads(done.text!)[0]!.thread.events.length).toBe(2);
    }
  });

  test("rows are deleted by the number Tex was shown, after the reply moved nothing", () => {
    const added = addCellThread(CSV, { row: 1, column: "Status" }, "@seyi", "@Tex drop row 1");
    if ("error" in added) throw new Error(added.error);
    const done = applyTexAnswer(added.text, added.thread, "Dropped.", { cells: [], append: [], delete: [1] }, "Tex");
    expect(rows(done.text!).map((r) => r.Name)).toEqual(["B"]);
    expect(threads(done.text!)[0]!.row).toBe(0);
    expect(addToCellThread(done.text!, added.thread, "resolved", "@seyi").error).toBeUndefined();
  });

  test("the request names the cell and takes @Tex out of the ask", () => {
    const added = addCellThread(CSV, { row: 1, column: "Status" }, "@seyi", "@Tex is this right?");
    if ("error" in added) throw new Error(added.error);
    const found = threadInText(added.text, added.thread)!;
    const request = cellRequest({ workspace: "@team", noteId: "n1", path: "p/s.csv" }, { row: 1, column: "Status", value: "partial" }, found.thread, "@Tex is this right?");
    expect(request.cell).toEqual({ row: 1, column: "Status" });
    expect(request.ask).toBe("is this right?");
    expect(request.anchor.text).toBe("partial");
  });
});
