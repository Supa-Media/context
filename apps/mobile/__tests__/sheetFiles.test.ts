import { describe, expect, test } from "@jest/globals";
import { isSheetPath, newSheetText } from "../../mcp/src/sheets/csv.js";
import { isSheetDocument } from "../features/console/files/sheet/sheetFile";
import { sheetFileName } from "../features/console/files/paths";
import { untitledName, isUntitled } from "../features/console/files/untitled";
import { noteHeading } from "../features/console/files/frontmatter";
import { downloadName, fileDownload } from "../features/console/files/zip";

/**
 * Sheets (`.csv`) as first-class files: which ones open in the grid, what a new
 * one is called, what the breadcrumb says, and what a download is named.
 *
 * SABOTAGE: `isSheetDocument` written as `path !== null` fails the first group;
 * `sheetFileName` through `ensureMarkdown` fails the second; `fileDownload`
 * with `.md` for every path fails the last.
 */

const NOW = new Date(2026, 10, 23);

describe("which files open as a sheet", () => {
  test("a .csv path is the sheet document, in any case", () => {
    expect(isSheetDocument("1-projects/budget.csv", false)).toBe(true);
    expect(isSheetDocument("1-projects/BUDGET.CSV", false)).toBe(true);
  });

  test("a note, a drawing or a page is not", () => {
    expect(isSheetDocument("1-projects/plan.md", false)).toBe(false);
    expect(isSheetDocument("1-projects/plan.excalidraw.md", false)).toBe(false);
    expect(isSheetDocument("1-projects/plan.page.md", false)).toBe(false);
  });

  test("an encrypted sheet, and no path at all, are not drawn as a grid", () => {
    expect(isSheetDocument("1-projects/budget.csv", true)).toBe(false);
    expect(isSheetDocument(null, false)).toBe(false);
  });
});

describe("sheetFileName", () => {
  test("a typed name gets the .csv, and the person never types the format", () => {
    expect(sheetFileName("Budget")).toBe("Budget.csv");
    expect(sheetFileName("  Budget  ")).toBe("Budget.csv");
  });

  test("a name already ending in .csv is kept as it was typed", () => {
    expect(sheetFileName("Budget.csv")).toBe("Budget.csv");
    expect(sheetFileName("Budget.CSV")).toBe("Budget.CSV");
  });

  test("never gains a .md: a sheet is not a Markdown note", () => {
    expect(sheetFileName("Budget")).not.toMatch(/\.md$/);
    expect(isSheetPath(sheetFileName("Budget"))).toBe(true);
  });
});

describe("untitled sheets are de-duplicated like untitled drawings", () => {
  test("the first one in a day takes the bare name", () => {
    expect(untitledName({}, "", "sheet", NOW)).toBe("untitled-2026-11-23.csv");
  });

  test("a second one in the same folder takes the next number, before the extension", () => {
    const listings = {
      "": {
        folderDefault: "private",
        entries: [{ name: "untitled-2026-11-23.csv" }],
      },
    } as unknown as Parameters<typeof untitledName>[0];
    expect(untitledName(listings, "", "sheet", NOW)).toBe("untitled-2026-11-23-2.csv");
  });

  test("a sheet and a note made the same day do not collide with each other", () => {
    const listings = {
      "": {
        folderDefault: "private",
        entries: [{ name: "untitled-2026-11-23.md" }],
      },
    } as unknown as Parameters<typeof untitledName>[0];
    expect(untitledName(listings, "", "sheet", NOW)).toBe("untitled-2026-11-23.csv");
  });

  test("a generated sheet name is recognised as untitled, a named one is not", () => {
    expect(isUntitled("1-projects/untitled-2026-11-23.csv")).toBe(true);
    expect(isUntitled("1-projects/untitled-2026-11-23-2.csv")).toBe(true);
    expect(isUntitled("1-projects/budget.csv")).toBe(false);
  });
});

describe("a sheet's name is its file name, without .csv", () => {
  test("the breadcrumb and tab title drop the extension, not the words", () => {
    expect(noteHeading(newSheetText(), "1-projects/Q4 budget.csv")).toBe("Q4 budget");
  });

  test("a sort number is filing, not a name", () => {
    expect(noteHeading(newSheetText(), "1-projects/2-budget.csv")).toBe("budget");
  });

  test("a line in the CSV that starts with # is data, never the title", () => {
    expect(noteHeading("# not a heading,notes\n", "1-projects/budget.csv")).toBe("budget");
  });
});

describe("a single sheet downloads as .csv", () => {
  test("the name is the file's, with .csv, and the type is text/csv", () => {
    expect(fileDownload("1-projects/budget.csv")).toEqual({
      name: "budget.csv",
      type: "text/csv;charset=utf-8",
    });
  });

  test("the stem drops .csv once, so the name never reads budget.csv.csv", () => {
    expect(downloadName("1-projects/budget.csv", ".csv")).toBe("budget.csv");
    expect(downloadName("1-projects/budget.csv.md", ".md")).toBe("budget.csv.md");
  });

  test("a note still downloads as .md", () => {
    expect(fileDownload("1-projects/plan.md")).toEqual({
      name: "plan.md",
      type: "text/markdown;charset=utf-8",
    });
  });
});
