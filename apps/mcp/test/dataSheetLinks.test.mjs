/**
 * A source's sheets kept outside its folder (`src/data/sheetLinks.js`): read from the `sheets:` links in its about
 * note, by the sheet's file name, with its own folder's sheets winning a shared name.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `linkedSheetPath` accepting `..`: "a path that climbs, a non-sheet or an empty link is left out" fails.
 * 2. `linkedSheets` ignoring `ownNames`: "the source's own folder keeps a name it already has" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { datasetNameOf, linkedSheetPath, linkedSheets } from "../src/data/sheetLinks.js";
import { noteProperties } from "../src/lists/properties.js";
import { inputSheetOf } from "../src/data/sync/snap.js";

test("a link is read as a workspace path, whichever way it is written", () => {
  assert.equal(linkedSheetPath("[[areas/operations/Filings/filings.csv]]"), "areas/operations/Filings/filings.csv");
  assert.equal(linkedSheetPath("[[areas/operations/Filings/filings.csv|Filings]]"), "areas/operations/Filings/filings.csv");
  assert.equal(linkedSheetPath("[Filings](areas/operations/Filings/filings.csv)"), "areas/operations/Filings/filings.csv");
  assert.equal(linkedSheetPath("[Scores](<areas/operations/Scorecard/my%20scores.csv>)"), "areas/operations/Scorecard/my scores.csv");
  assert.equal(linkedSheetPath("/areas/x/y.csv"), "areas/x/y.csv");
  assert.equal(linkedSheetPath("areas/x/Y.CSV"), "areas/x/Y.CSV");
});

test("a path that climbs, a non-sheet or an empty link is left out", () => {
  for (const value of ["[[../secret/x.csv]]", "areas/../x.csv", "areas//x.csv", "[[areas/x/notes.md]]", "[[]]", "", "   ", null, 7, "[x](%E0%A4%A.csv)"]) {
    assert.equal(linkedSheetPath(value), null, String(value));
  }
});

test("the dataset is the sheet's file name, first link wins a name, and the source's own folder keeps a name it already has", () => {
  assert.equal(datasetNameOf("areas/operations/Filings/filings.csv"), "filings");
  const props = { sheets: ["[[areas/a/scores.csv]]", "[[areas/b/Scores.csv]]", "[[areas/c/filings.csv]]", "nonsense"] };
  assert.deepEqual(linkedSheets(props), [{ name: "scores", path: "areas/a/scores.csv" }, { name: "filings", path: "areas/c/filings.csv" }]);
  assert.deepEqual(linkedSheets(props, ["Filings"]), [{ name: "scores", path: "areas/a/scores.csv" }]);
  assert.deepEqual(linkedSheets({ sheets: "[[areas/a/one.csv]]" }), [{ name: "one", path: "areas/a/one.csv" }]);
  assert.deepEqual(linkedSheets({}), []);
  assert.deepEqual(linkedSheets(undefined), []);
});

test("an about note's front matter, as the tree reads it, gives its links", () => {
  const text = `---\nsource: push\nsheets: ["[[areas/operations/Filings/filings.csv]]", "[[areas/operations/Scorecard/scores.csv]]"]\n---\n\n# Ops\n`;
  assert.deepEqual(linkedSheets(noteProperties(text)).map((each) => each.path), ["areas/operations/Filings/filings.csv", "areas/operations/Scorecard/scores.csv"]);
});

test("the hourly keep reads a linked dataset where it is, and any other from the source's folder", () => {
  const linked = [{ name: "filings", path: "areas/operations/Filings/filings.csv" }];
  assert.equal(inputSheetOf("data", { source: "filings", dataset: "Filings" }, linked), "areas/operations/Filings/filings.csv");
  assert.equal(inputSheetOf("data", { source: "filings", dataset: "other" }, linked), "data/filings/other.csv");
  assert.equal(inputSheetOf("data", { source: "filings", dataset: "filings" }), "data/filings/filings.csv");
});
