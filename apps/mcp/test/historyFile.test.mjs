/**
 * A CHAT'S HISTORY FILE: `history.ledger.json` in a person's `tex/` and in each group chat's home (the owner,
 * 2026-11-02: "that ledger ... be like a history file. Instead of a folder"; `src/texStore/historyView.js`,
 * `src/agent/historyFile.js`).
 *
 * The object keeps a marker under the file's key and answers a read of it with the chat's ledger as it is then: one
 * copy, the ledger. Nothing writes it: the object refuses a write over the marker, and every tool that changes
 * something refuses the path. The row is made once, when the lookup behind a kept exchange finds none.
 *
 * Sabotage record (2026-11-02), each fails a test here:
 *  - `withHistoryView.get` answering the stored bytes → "a read answers the chat's ledger as it is now";
 *  - `withHistoryView.put` without its marker check → "nothing writes over it";
 *  - `callTool` without the history guard → "every tool that changes something refuses the path";
 *  - `ensureHistoryFile` writing whatever the lookup said → "the row is made once".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { texLedger } from "../src/texStore/ledger.js";
import { TexObjectRefused, texObjects } from "../src/texStore/objects.js";
import { HISTORY_VIEW_MARKER, withHistoryView } from "../src/texStore/historyView.js";
import { HISTORY_PATH, ensureHistoryFile, historyWriteRefusal, homeHistoryPath } from "../src/agent/historyFile.js";
import { callTool } from "../src/tools/dispatch.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "notes/01890000-0000-7000-8000-000000000001.json";
const OTHER = "notes/01890000-0000-7000-8000-000000000002.md";
const entry = (id, kind = "text", extra = {}) => ({ id, kind, at: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0), ...extra });
const text = (body) => new TextDecoder().decode(body);

function object() {
  const sql = durableSql();
  return { ...texObjects(sql), ledger: texLedger(sql) };
}

test("a read answers the chat's ledger as it is now, and keeps no copy of it", async () => {
  const stored = object();
  const objects = withHistoryView(stored);
  await objects.put(KEY, HISTORY_VIEW_MARKER);
  stored.ledger.append("texts", [entry("a1", "text", { text: "hi" }), entry("a2", "reply", { text: "Hey!" })]);
  const first = objects.get(KEY);
  const shown = JSON.parse(text(first.body));
  assert.equal(shown.manifest.chat, "texts");
  assert.deepEqual(shown.entries.map((e) => e.id), ["a1", "a2"], "oldest first");
  assert.equal(shown.view.older, false);
  assert.equal(objects.head(KEY).etag, first.etag);
  // What the object keeps is the marker alone.
  assert.equal(text(stored.get(KEY).body), HISTORY_VIEW_MARKER);
  // A later entry is in the next read, under a new etag; asking with the old one while nothing changed answers no body.
  assert.equal(objects.get(KEY, { onlyIf: { etagDoesNotMatch: first.etag } }).body, undefined);
  stored.ledger.append("texts", [entry("a3", "thinking", { text: "ok" })]);
  const second = objects.get(KEY, { onlyIf: { etagDoesNotMatch: first.etag } });
  assert.notEqual(second.etag, first.etag);
  assert.deepEqual(JSON.parse(text(second.body)).entries.map((e) => e.id), ["a1", "a2", "a3"]);
});

test("a group chat's object shows its one chat", async () => {
  const stored = object();
  const objects = withHistoryView(stored);
  await objects.put(KEY, HISTORY_VIEW_MARKER);
  stored.ledger.append("ab".repeat(32), [entry("g1", "text", { text: "hey all" })]);
  assert.deepEqual(JSON.parse(text(objects.get(KEY).body)).entries.map((e) => e.id), ["g1"]);
});

test("nothing writes over it, and every other key is as it was", async () => {
  const objects = withHistoryView(object());
  await objects.put(KEY, HISTORY_VIEW_MARKER);
  await assert.rejects(() => objects.put(KEY, "{}"), TexObjectRefused);
  assert.ok(await objects.put(KEY, HISTORY_VIEW_MARKER), "the marker again is the same file");
  await objects.put(OTHER, HISTORY_VIEW_MARKER.slice(0, -1));
  await objects.put(OTHER, "# a note");
  assert.equal(text(objects.get(OTHER).body), "# a note");
});

test("every tool that changes something refuses the path, however it is spelled; reading it is not refused", async () => {
  const store = { contexts: [] };
  for (const [name, args] of [
    ["write_note", { path: "tex/history.ledger.json", content: "{}" }],
    ["write_note", { path: "@seyi/tex/History.Ledger.JSON", content: "{}" }],
    ["archive_note", { path: "/tex/history.ledger.json" }],
    ["write_note", { path: "tex/groups/orbit-lamp-river/history.ledger.json", content: "{}" }],
  ]) {
    const answer = await callTool(name, args, store, "private");
    assert.equal(answer.isError, true, `${name} ${args.path}`);
    assert.match(answer.content[0].text, /history/);
  }
  assert.equal(historyWriteRefusal("tex/history.md"), null);
  assert.equal(historyWriteRefusal("notes/history.ledger.json"), null);
  assert.equal(historyWriteRefusal(HISTORY_PATH) !== null, true);
  assert.equal(historyWriteRefusal(homeHistoryPath({ folder: "tex/groups/orbit-lamp-river" })) !== null, true);
});

test("the row is made once, when the lookup found none", async () => {
  const puts = [];
  const store = { put: async (path, body, options) => puts.push({ path, body, options }) };
  await ensureHistoryFile(store, HISTORY_PATH, { [HISTORY_PATH]: "tex/person:ws/notes/x.json" });
  await ensureHistoryFile(store, HISTORY_PATH, {});
  assert.equal(puts.length, 0);
  await ensureHistoryFile(store, HISTORY_PATH, { [HISTORY_PATH]: false });
  assert.deepEqual(puts.map((put) => [put.path, put.body, put.options.onlyIf]), [[HISTORY_PATH, HISTORY_VIEW_MARKER, { absent: true }]]);
  // A store that throws is a miss, made on a later exchange.
  await ensureHistoryFile({ put: async () => { throw new Error("down"); } }, HISTORY_PATH, { [HISTORY_PATH]: false });
});
