/**
 * The file-kinds list (`packages/shared/src/fileKinds.cjs`): what a path is,
 * asked in one place (`docs/decisions/file-kinds.md`).
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `takesExactOverride` through `kindOf`: "only an exact extension takes
 *    its own visibility" fails on `Budget.CSV`.
 * 2. `.csv` removed from `TEXT_KINDS`: "a sheet is text" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILE, NOTE, SHEET, TEXT_EXTENSIONS, extensionOf, isNotePath, isSheetPath, isTextFilePath, kindOf, takesExactOverride, withoutTextExtension,
} from "../../../packages/shared/src/fileKinds.cjs";

test("a note is Markdown, a sheet is a .csv, and anything else is a file", () => {
  assert.equal(kindOf("areas/plan.md"), NOTE);
  assert.equal(kindOf("areas/metrics/readings.csv"), SHEET);
  assert.equal(kindOf("files/photo.png"), FILE);
  assert.equal(kindOf("report.pdf"), FILE);
  assert.equal(kindOf("README"), FILE);
});

test("a sheet is text, and so is a note; a picture is not", () => {
  assert.equal(isTextFilePath("a/b.csv"), true);
  assert.equal(isTextFilePath("a/b.md"), true);
  assert.equal(isTextFilePath("a/b.png"), false);
  assert.deepEqual([...TEXT_EXTENSIONS], [".md", ".csv"]);
});

test("the last extension decides: a Markdown subtype is a note, a .csv.md is a note", () => {
  assert.equal(isNotePath("site/home.page.md"), true);
  assert.equal(isNotePath("drawings/board.excalidraw.md"), true);
  assert.equal(isNotePath("a.csv.md"), true);
  assert.equal(isSheetPath("a.csv.md"), false);
  assert.equal(isNotePath("a.md.bak"), false);
});

test("a kind is any case", () => {
  assert.equal(extensionOf("Plan.MD"), ".md");
  assert.equal(kindOf("Plan.MD"), NOTE);
  assert.equal(kindOf("Data.CSV"), SHEET);
});

// The privacy parsers match `.md` and `.csv` as written, and one line they refuse makes the manifest unreadable.
test("only an exact extension takes its own visibility", () => {
  assert.equal(takesExactOverride("a/plan.md"), true);
  assert.equal(takesExactOverride("a/readings.csv"), true);
  assert.equal(takesExactOverride("a/Budget.CSV"), false);
  assert.equal(takesExactOverride("a/Plan.MD"), false);
  assert.equal(takesExactOverride("a/photo.png"), false);
});

test("a dot-file, a folder and a non-string have no text kind", () => {
  assert.equal(extensionOf(".gitignore"), "");
  assert.equal(extensionOf("folder.d/plain"), "");
  assert.equal(kindOf("areas/"), FILE);
  assert.equal(kindOf(null), FILE);
  assert.equal(kindOf(42), FILE);
});

test("a name loses only a text extension", () => {
  assert.equal(withoutTextExtension("readings.csv"), "readings");
  assert.equal(withoutTextExtension("Plan.MD"), "Plan");
  assert.equal(withoutTextExtension("home.page.md"), "home.page");
  assert.equal(withoutTextExtension("photo.png"), "photo.png");
});
