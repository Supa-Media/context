/**
 * A link straight to a sheet opens the sheet, not an empty editor.
 *
 * On a cold load from `?note=products/tex/capabilities.csv` the parent folder
 * is not listed yet, so the file browser guesses from the path whether it is
 * a folder. The guess asked `.md` alone, took the sheet for a folder, and the
 * page drew an empty "Write in markdown" editor under the sheet's name until
 * the row was clicked.
 */
import { expect, describe, test } from "@jest/globals";
import { opensAsDocument } from "../features/console/files/paths";
import { targetFolder } from "../features/console/files/tree";

describe("a path the listings do not know yet", () => {
  test("a sheet opens as a document", () => {
    expect(opensAsDocument("products/tex/capabilities.csv")).toBe(true);
    expect(opensAsDocument("data/Budget.CSV")).toBe(true);
  });

  test("a note opens as a document", () => {
    expect(opensAsDocument("projects/plan.md")).toBe(true);
    expect(opensAsDocument("projects/plan.page.md")).toBe(true);
  });

  test("anything else is a folder", () => {
    expect(opensAsDocument("products/tex")).toBe(false);
    expect(opensAsDocument("1-projects/pilot")).toBe(false);
  });

  test("a new note from a linked sheet lands beside it, not inside it", () => {
    expect(targetFolder({}, "products/tex/capabilities.csv")).toBe("products/tex");
  });
});
