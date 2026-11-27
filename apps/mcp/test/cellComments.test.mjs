/**
 * Comments and Tex on a sheet's cell (Dev, 2026-11-27): the comments column's format
 * (`packages/shared/src/cellComments.cjs`), how a sheet's readers treat that column (`sheets/csv.js`,
 * `tools/readSheet.js`), and the note run's sheet half (`packages/tex/gateway/agent/noteRunSheet.js`, the `cell` field
 * of `POST /tex/note-run`).
 *
 * Sabotage record (run 2026-11-27, each break reverted before the next):
 *   1. `querySheet` kept the comments column in its default columns: "a read leaves the comments column out" failed.
 *   2. `renameColumn` no longer renamed thread headers: "a rename carries the column's threads" failed.
 *   3. The route accepted a `cell` on a `.md` path: "a cell is refused on a note" failed.
 *   4. `sheetChangesOf` kept a row numbered 0: "changes are checked" failed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import cellComments from "../../../packages/shared/src/cellComments.cjs";
import { parseSheet, querySheet, renameColumn, serializeSheet, commentsColumnOf, COLUMN_TYPES } from "../src/sheets/csv.js";
import { cellWords, parseSheetRun, sheetChangesOf, sheetRunParts, sheetStepLabel, sheetTable } from "../../../packages/tex/gateway/agent/noteRunSheet.js";
import { noteRunQuestion } from "../../../packages/tex/gateway/agent/noteRun.js";
import { handleNoteRun, NOTE_RUN_PATH, parseRunBody } from "../../../packages/tex/gateway/agent/noteRunRoute.js";

const AT = "2026-11-27T07:30:12Z";

function threadCell() {
  const first = cellComments.addCellThread("", { id: "k7f2", column: "In a group", author: "@seyi", body: "@Tex can Tex read files in an SMS group?", at: AT });
  return cellComments.appendCellEvent(first.cell, { thread: "k7f2", kind: "comment", author: "Tex", body: "No.", at: AT }).cell;
}

const SHEET = serializeSheet({
  columns: [
    { name: "What Tex does", type: "text" },
    { name: "In a group", type: "text" },
    { name: "comments", type: "comments" },
  ],
  rows: [
    { "What Tex does": "Reads an email's attachment", "In a group": "✅ when tagged", comments: "" },
    { "What Tex does": "Reads photos, PDFs", "In a group": "✅ when tagged", comments: threadCell() },
  ],
});

describe("the comments column's format", () => {
  it("is a note's comments log, one thread per header line, with the column as its quote", () => {
    const cell = threadCell();
    assert.equal(cell, `k7f2 "In a group"\n- ${AT} @seyi: @Tex can Tex read files in an SMS group?\n- ${AT} Tex: No.`);
    const [thread] = cellComments.cellThreads(cell);
    assert.equal(thread.quote, "In a group");
    assert.equal(thread.events.length, 2);
    assert.equal(thread.status, "open");
  });

  it("resolves, reopens and deletes as a note's threads do, and an emptied cell is empty", () => {
    const resolved = cellComments.appendCellEvent(threadCell(), { thread: "k7f2", kind: "resolved", author: "@seyi", at: AT }).cell;
    assert.equal(cellComments.cellThreads(resolved)[0].status, "resolved");
    assert.match(cellComments.appendCellEvent(resolved, { thread: "k7f2", kind: "resolved", author: "@seyi" }).error, /already resolved/);
    const two = cellComments.addCellThread(resolved, { id: "ab12", column: "Status", author: "@seyi", body: "Is this live?", at: AT }).cell;
    assert.deepEqual(cellComments.cellThreads(two).map((t) => t.id), ["k7f2", "ab12"]);
    const one = cellComments.deleteCellComment(two, { thread: "k7f2", index: 0 }).cell;
    assert.deepEqual(cellComments.cellThreads(one).map((t) => t.id), ["ab12"]);
    assert.equal(cellComments.deleteCellComment(one, { thread: "ab12", index: 0 }).cell, "");
  });

  it("refuses a thread with no words, no column, or an id already used", () => {
    assert.ok(cellComments.addCellThread("", { id: "k7f2", column: "A", author: "@a", body: "  " }).error);
    assert.ok(cellComments.addCellThread("", { id: "k7f2", column: "", author: "@a", body: "hi" }).error);
    assert.ok(cellComments.addCellThread(threadCell(), { id: "k7f2", column: "A", author: "@a", body: "hi" }).error);
  });

  it("chooses an id no cell of the sheet uses", () => {
    const ids = new Set();
    for (let i = 0; i < 20; i += 1) ids.add(cellComments.newCellThreadId([threadCell()]));
    assert.ok(!ids.has("k7f2"));
  });

  it("keeps a comment's later lines indented, so a line of backticks cannot end the log", () => {
    const cell = cellComments.addCellThread("", { id: "q1w2", column: "A", author: "@a", body: "one\n```\nthree", at: AT }).cell;
    assert.equal(cellComments.cellThreads(cell)[0].events[0].text, "one\n```\nthree");
  });
});

describe("a sheet's readers and the comments column", () => {
  it("parses the comments type from the header and keeps it on a round trip", () => {
    assert.ok(COLUMN_TYPES.includes("comments"));
    const sheet = parseSheet(SHEET);
    assert.equal(commentsColumnOf(sheet)?.name, "comments");
    assert.equal(serializeSheet(sheet), SHEET);
  });

  it("a read leaves the comments column out unless it is asked for by name", () => {
    const sheet = parseSheet(SHEET);
    assert.deepEqual(querySheet(sheet, {}).columns.map((c) => c.name), ["What Tex does", "In a group"]);
    assert.deepEqual(querySheet(sheet, { columns: ["comments"] }).columns.map((c) => c.name), ["comments"]);
  });

  it("a rename carries the column's threads to its new name", () => {
    const renamed = renameColumn(parseSheet(SHEET), "In a group", "In a group chat");
    assert.equal(cellComments.cellThreads(renamed.rows[1].comments)[0].quote, "In a group chat");
    assert.equal(renamed.rows[1]["In a group chat"], "✅ when tagged");
  });
});

describe("Tex on a cell: the question and the answer", () => {
  it("shows the sheet numbered from 1, never its comments", () => {
    const { table, rows, columns } = sheetTable(SHEET);
    assert.equal(rows, 2);
    assert.deepEqual(columns, ["What Tex does", "In a group"]);
    assert.match(table, /\| 2 \| Reads photos, PDFs \| ✅ when tagged \|/);
    assert.doesNotMatch(table, /Tex can Tex read/);
  });

  it("names the cell by its row, column and value", () => {
    assert.deepEqual(cellWords(SHEET, { row: 1, column: "In a group" }), { row: 2, column: "In a group", value: "✅ when tagged", exists: true });
    assert.equal(cellWords(SHEET, { row: 9, column: "In a group" }).exists, false);
    assert.match(sheetRunParts({ path: "p/files.csv", noteText: SHEET, cell: { row: 1, column: "In a group" } }).anchor, /Cell row: 2\nCell column: "In a group"/);
  });

  it("a cell's question is the sheet's, a note's is unchanged", () => {
    const base = { path: "p/files.csv", noteText: SHEET, anchor: { text: "", before: "", after: "" }, ask: "fix it", history: [], pending: null, chatHistory: "", audience: "team" };
    assert.match(noteRunQuestion({ ...base, cell: { row: 1, column: "In a group" } }), /one cell of a sheet/);
    assert.match(noteRunQuestion({ ...base, cell: { row: 1, column: "In a group" } }), /you may change any cell/);
    assert.doesNotMatch(noteRunQuestion(base), /one cell of a sheet/);
  });

  it("changes are checked: whole rows from 1, known shapes, nothing else", () => {
    assert.equal(sheetChangesOf({ cells: [], append: [], delete: [] }), null);
    const changes = sheetChangesOf({
      cells: [{ row: 2, column: "In a group", value: "✅ not in SMS groups" }, { row: 0, column: "A", value: "x" }, { row: 1, column: "A" }, { row: 1.5, column: "A", value: "x" }],
      append: [{ A: "new", B: 3 }, "not a row", {}],
      delete: [3, 3, 0, -1, "2"],
    });
    assert.deepEqual(changes, { cells: [{ row: 2, column: "In a group", value: "✅ not in SMS groups" }], append: [{ A: "new", B: "3" }], delete: [3] });
  });

  it("reads the model's JSON, and posts its words as they are when there is none", () => {
    const parsed = parseSheetRun('Sure. {"answer": "Changed row 2.", "cells": [{"row": 2, "column": "In a group", "value": "no"}]}', 1500);
    assert.equal(parsed.answer, "Changed row 2.");
    assert.equal(parsed.changes.cells.length, 1);
    assert.deepEqual(parseSheetRun("no json here", 1500), { answer: "no json here", changes: null });
    assert.equal(sheetStepLabel(parsed.changes), "Writing row 2 · In a group");
    assert.equal(sheetStepLabel({ cells: [], append: [{ A: "x" }], delete: [] }), "Editing the sheet");
  });
});

describe("the note-run route's cell", () => {
  const body = (over = {}) => ({
    workspace: "@team",
    noteId: "",
    path: "p/files.csv",
    thread: "k7f2",
    anchor: { text: "✅ when tagged", before: "", after: "" },
    ask: "can Tex read files in an SMS group?",
    history: [],
    pending: null,
    cell: { row: 1, column: "In a group" },
    ...over,
  });

  it("takes a cell on a sheet, and none on a note", () => {
    assert.deepEqual(parseRunBody(body()).cell, { row: 1, column: "In a group" });
    assert.equal(parseRunBody(body({ cell: undefined })).cell, null);
  });

  it("a cell is refused on a note, and a cell of the wrong shape anywhere", () => {
    assert.match(parseRunBody(body({ path: "p/a.md" })).error, /cell is not right/);
    assert.match(parseRunBody(body({ cell: { row: -1, column: "A" } })).error, /cell is not right/);
    assert.match(parseRunBody(body({ cell: { row: 1, column: "" } })).error, /cell is not right/);
    assert.match(parseRunBody(body({ cell: { row: "1", column: "A" } })).error, /cell is not right/);
  });

  it("streams the sheet's changes after the answer, and hands the run its cell", async () => {
    const seen = [];
    const changes = { cells: [{ row: 2, column: "In a group", value: "no" }], append: [], delete: [] };
    const session = {
      actorClientId: "context_console",
      workspaceKind: "personal",
      role: "owner",
      actorUserId: "k7m2q9x4b8n3c6v1",
      workspaceId: "wsA",
      workspaces: [{ workspaceId: "wsA", slug: "ana", kind: "personal", role: "owner" }, { workspaceId: "wsT", slug: "team", kind: "shared", role: "member" }],
    };
    const storage = new Map();
    const env = {
      TEX_CHAT: {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => { storage.set("hit", true); return Response.json({ ok: true }); } }),
      },
    };
    const deps = {
      runNoteRun: async (args) => {
        seen.push(args.cell);
        return { outcome: "answered", answer: "Changed row 2.", replace: null, changes, sources: [], calls: [], model: "m", usage: {}, ms: 1 };
      },
      noteRunNode: () => ({ id: "noteRun", on: true }),
      dispatchFor: () => async () => ({ content: [{ type: "text", text: `etag: @team/n1:e1\npath: p/files.csv\nvisibility: team\n\n${SHEET}` }] }),
      offeredFor: async () => [],
      ledgerOf: () => null,
      controlPlane: {},
      now: () => 1,
      runId: () => "nr_0123456789abcdef",
    };
    const request = new Request(`https://gw${NOTE_RUN_PATH}`, { method: "POST", body: JSON.stringify(body()), headers: { "content-type": "application/json" } });
    const response = await handleNoteRun(request, {}, session, NOTE_RUN_PATH, env, null, deps);
    const lines = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(seen, [{ row: 1, column: "In a group" }]);
    assert.deepEqual(lines.map((line) => line.type), ["answer", "sheet", "done"]);
    assert.deepEqual(lines[1].changes, changes);
  });
});
