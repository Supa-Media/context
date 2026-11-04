/**
 * The word search leaves out the words a question is built from (`src/search/functionWords.js`).
 *
 * Production, 2026-11-04: "how should I work with Seyi" did not show resources/working-with-seyi.md in the first
 * twelve, because a chat log holding every one of those words was a full match and the note was not. Bench gh-161
 * (main) against gh-162 (this rule), 67 questions: first 68.2% to 71.2%, found 100% both.
 *
 * Sabotage, 2026-11-04: with `tokensOf` returning the raw tokens, the first two tests fail; with "this" in
 * FUNCTION_WORDS, the third fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { projectNote, upsertStatements } from "../src/search/d1/project.js";
import { mergeHits, searchParams, searchSql, toMatchExpression, toRelaxedMatchExpression } from "../src/search/d1/query.js";
import { contentTokens, FUNCTION_WORDS } from "../src/search/functionWords.js";

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

const found = (sqlite, match) => (match === null ? [] : mergeHits(sqlite.prepare(searchSql("notes_team_fts")).all(...searchParams(match))).map((hit) => hit.path));

const NOTES = {
  "resources/working-with-sam.md": "# Working with Sam\n\nSam likes short drafts and plain words.",
  "inbox/sessions/2026-10-01-chat.md": "# Saved chat\n\n**You:** How should I work with the new hire? I think Sam said so.\n**Assistant:** Work it out with Sam.",
};

test("a question's filler words do not keep the note that answers it out of a full match", () => {
  const sqlite = db(NOTES);
  assert.ok(found(sqlite, toMatchExpression("how should I work with Sam")).includes("resources/working-with-sam.md"));
});

test("the same question without filler words asks the same match", () => {
  assert.equal(toMatchExpression("how should I work with Sam"), toMatchExpression("work Sam"));
  assert.equal(toRelaxedMatchExpression("how should I work with Sam"), toRelaxedMatchExpression("work Sam"));
});

test("a query of only filler words still asks for them, and time words stay", () => {
  assert.notEqual(toMatchExpression("who is it"), null);
  assert.deepEqual(contentTokens(["the", "who"]), ["the", "who"]);
  assert.deepEqual(contentTokens(["book", "club", "this", "month"]), ["book", "club", "this", "month"]);
  for (const kept of ["may", "will", "us", "can", "next", "last", "still", "left", "this", "these"]) assert.equal(FUNCTION_WORDS.has(kept), false, kept);
});
