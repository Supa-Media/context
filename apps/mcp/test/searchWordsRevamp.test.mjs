/**
 * Word search finds a note by its file name, by another form of a word, and puts running records below the notes
 * they mention (the search revamp, 2026-11-04). Against real FTS5 (`node:sqlite`), as `searchD1.test.mjs` is.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `projectNote` leaving the file name out of `headings`        → "a note is found by its file name" fails
 *   `wordTerm` asking the word alone                             → "another form of a word" fails
 *   the typing expression without the last word's prefix        → "still typing" fails
 *   `wordForms` letting a three-letter root stand ("this")       → "a short root never stands" fails
 *   `notePrior` without the any-depth log folders                → "running records rank below" fails
 *   `withForms` without its length cap                           → "a pasted paragraph" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileNameWords, projectNote, upsertStatements } from "../src/search/d1/project.js";
import { mergeHits, searchParams, searchSql, toMatchExpression, toRelaxedMatchExpression, toTypingMatchExpression } from "../src/search/d1/query.js";
import { wordForms } from "../src/search/d1/wordForms.js";
import { LOG_PRIOR, notePrior } from "../src/search/priors.js";

function db(notes) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE notes (path TEXT PRIMARY KEY, version TEXT NOT NULL, visibility TEXT NOT NULL, title TEXT, uploaded TEXT, chunks INTEGER NOT NULL, indexed_at TEXT NOT NULL)`);
  for (const table of ["notes_private_fts", "notes_team_fts"]) {
    sqlite.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(path UNINDEXED, ord UNINDEXED, title, headings, tags, body, tokenize='unicode61 remove_diacritics 2')`);
  }
  for (const [path, content] of Object.entries(notes)) {
    for (const { sql, params } of upsertStatements(path, projectNote(path, { version: "v1", visibility: "team", content }))) sqlite.prepare(sql).run(...params);
  }
  return sqlite;
}

function found(sqlite, match) {
  if (match === null) return [];
  return mergeHits(sqlite.prepare(searchSql("notes_team_fts")).all(...searchParams(match))).map((hit) => hit.path);
}

const NOTES = {
  "projects/llc-formation.md": "# Setting up the company\n\nArticles filed with the state.",
  "areas/team/weekly.md": "# Weekly\n\nThe meeting is on Mondays and we planned the agenda.",
  "resources/stories.md": "# Reading\n\nA story about a running river.",
};

test("a note is found by its file name, whatever its first heading says", () => {
  const sqlite = db(NOTES);
  assert.deepEqual(found(sqlite, toMatchExpression("llc formation")), ["projects/llc-formation.md"]);
  assert.equal(fileNameWords("a/b/plan.page.md"), "plan");
  assert.equal(fileNameWords("a/sketch.excalidraw.md"), "sketch");
});

test("another form of a word finds the note: meetings, planning, stories, rivers", () => {
  const sqlite = db(NOTES);
  assert.deepEqual(found(sqlite, toMatchExpression("meetings")), ["areas/team/weekly.md"]);
  assert.deepEqual(found(sqlite, toMatchExpression("planning")), ["areas/team/weekly.md"]);
  assert.deepEqual(found(sqlite, toMatchExpression("stories")), ["resources/stories.md"]);
  assert.deepEqual(found(sqlite, toMatchExpression("rivers")), ["resources/stories.md"]);
});

test("still typing: the last word matches as the start of a longer one", () => {
  const sqlite = db(NOTES);
  assert.deepEqual(found(sqlite, toTypingMatchExpression("weekly meet")), ["areas/team/weekly.md"]);
  assert.deepEqual(found(sqlite, toTypingMatchExpression("llc formati")), ["projects/llc-formation.md"]);
});

test("a short root never stands as a word of its own", () => {
  assert.equal(wordForms("this").includes("thing"), false);
  assert.equal(wordForms("news").includes("new"), false);
  assert.equal(wordForms("notes").includes("not"), false);
  assert.deepEqual(wordForms("2024"), ["2024"]);
  assert.deepEqual(wordForms("café"), ["café"]);
  assert.ok(wordForms("making").includes("make"));
  assert.ok(wordForms("running").includes("run"));
});

test("running records rank below the notes they mention", () => {
  assert.equal(notePrior("@context-lc/areas/tex-reviews/2026-11-01 goal.md"), LOG_PRIOR);
  assert.equal(notePrior("ai/setups/retired/texting-assistant/live.md"), LOG_PRIOR);
  assert.equal(notePrior("areas/team/retired-notes.md"), 1);
  assert.equal(notePrior("projects/plan.md"), 1);
});

test("a pasted paragraph asks its words as written, inside what the object takes", () => {
  const paragraph = Array.from({ length: 120 }, (_, index) => `meetings${index} planning`).join(" ");
  for (const build of [toMatchExpression, toTypingMatchExpression, toRelaxedMatchExpression]) {
    const expression = build(paragraph);
    assert.ok(expression.length <= 4096, `${build.name} ${expression.length}`);
  }
  assert.equal(toMatchExpression('NEAR(a b)').includes("NEAR("), false);
});
