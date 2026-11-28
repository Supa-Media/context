// The meaning index read from the copy packed beside each row (src/workspaceStore/meaningIndex.js `fromHeld`), the
// read an object just woken does before its first query: one row read a note instead of one a passage. Every answer is
// the one the passages' own table gives, an index from before the packed copy is read the old way until a build has
// packed it, and every write keeps the copy level.
//
// Sabotage record (temporary local edits, reverted; each one fails the named test):
//   `keep` writing the row without its packed copy        -> "a woken object reads ... one row a note" fails
//   `fromHeld` not sorting by passage id                   -> "... every answer the passages' own table gives" fails
//   `fromHeld` taking a row with no copy as empty          -> "an index from before the packed copy ..." fails
//   `packOld` not run by a build                           -> "an index from before the packed copy ..." fails
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMarks } from "../src/workspaceStore/marks.js";
import { workspaceSearch } from "../src/workspaceStore/searchIndex.js";
import { workspaceMeaning } from "../src/workspaceStore/meaningIndex.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { HOMES } from "../src/workspaceStore/api.js";
import { MEANING_DIMENSIONS } from "../src/search/meaning/embed.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const MEMBER = (folders, accessVersion = 1) => ({ etag: `m.${accessVersion}`, accessVersion, folders, notes: [] });
const FOLDERS = [{ prefix: "plans", visibility: "team" }, { prefix: "archive", visibility: "team" }];

/** SQLite in memory, with every statement it is handed recorded while `seen` is an array. */
function durableSql() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    seen: null,
    exec(query, ...binds) {
      sql.seen?.push(query);
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
  return sql;
}

/** A fingerprint from words; a passage holding "blank" has none (no number set), so the index keeps no passage for it. */
function fingerprint(text) {
  const vector = new Array(MEANING_DIMENSIONS).fill(0);
  if (/\bblank\b/.test(text)) return vector;
  for (const word of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    for (let k = 0; k < 8; k += 1) vector[(hash + k * 131) % MEANING_DIMENSIONS] += k % 2 === 0 ? 1 : -1;
  }
  vector[0] += 0.01;
  return vector;
}

function workspace() {
  const sql = durableSql();
  const objects = texObjects(sql, { now: () => 1_000 });
  const rows = workspaceRows(sql);
  const embed = async (texts) => texts.map(fingerprint);
  const store = { objects, rows, marks: workspaceMarks(sql, { now: () => 1_000 }), search: workspaceSearch(sql, { rows, objects }), meaning: workspaceMeaning(sql, { rows, objects, embed }), sql };
  const send = async (op, fields = {}, body = JSON.stringify({ ...fields, workspaceId: "w1" }), call = { op }) => {
    const response = await serveWorkspaceStore(store, new Request("https://ws/call", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify(call)) }, body }));
    assert.equal(response.status, 200, op);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const put = (n, text) => send("put", {}, text, { op: "put", key: `notes/${ID(n)}.md`, options: {} });
  const row = (n, path, at) => send("ws.apply", { rows: [{ id: `r${n}`, noteId: ID(n), path, kind: "file", storageKey: `notes/${ID(n)}.md`, at }], at });
  const build = async () => {
    for (let pass = 0; pass < 20; pass += 1) if (!((await send("ws.meaning.build")).waiting > 0)) return;
    assert.fail("the build never finished");
  };
  /** The same workspace in an object just woken: a new index over the same storage, holding nothing in memory. */
  const woken = () => workspaceMeaning(sql, { rows, objects, embed });
  /** The object started again (a deploy, or code rolled back and forward): what it answers from now on. */
  const restart = () => {
    store.meaning = woken();
  };
  return { sql, store, send, put, row, build, woken, restart };
}

// A fixed workspace: long notes of several passages, a passage with no fingerprint in the middle of one, a note with
// none at all, private and team notes, the archive, and notes of the same text.
const WORDS = ["willow", "lantern", "harbor", "cedar", "quartz", "ember", "tundra", "saffron", "meadow", "copper", "falcon", "orchid"];
let seed = 20261128;
const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const sentence = (n) => Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)]).join(" ");
const NOTES = [];
for (let n = 1; n <= 40; n += 1) {
  const folder = n % 4 === 0 ? "archive" : n % 4 === 1 ? "plans" : n % 4 === 2 ? "notes" : "plans/deep";
  const lines = Array.from({ length: n % 5 === 0 ? 160 : 4 }, () => sentence(8));
  if (n % 7 === 0) lines.splice(Math.floor(lines.length / 2), 0, ...Array.from({ length: 60 }, () => "blank"));
  NOTES.push({ n, path: `${folder}/note-${n}.md`, text: n === 13 ? "blank" : `# ${sentence(2)}\n\n${lines.join("\n")}` });
}
// More notes of one text than a query scores by their bytes (`CANDIDATES`): which of them it scores is the order read.
for (let n = 41; n <= 490; n += 1) NOTES.push({ n, path: `plans/copy-${n}.md`, text: "# Same\n\nwillow harbor lantern" });
const QUERIES = ["willow", "lantern harbor", "quartz ember tundra", "saffron meadow", "copper falcon orchid", "cedar"];
const ASKS = [];
for (const words of QUERIES) for (const tiers of [null, ["team"], ["private"]]) for (const prefix of ["", "plans/", "archive/"]) for (const topK of [1, 5, 50]) ASKS.push({ words, tiers, prefix, topK });

async function seeded() {
  const ws = workspace();
  await ws.send("ws.home", { home: HOMES.OBJECT });
  await ws.send("ws.apply", { rules: { member: MEMBER(FOLDERS) } });
  for (const { n, path, text } of NOTES) {
    await ws.put(n, text);
    await ws.row(n, path, 10);
  }
  await ws.build();
  // Then changes on an index held in memory: moves, a change of rules, a rewrite, a removal.
  ws.store.meaning.query(fingerprint("willow"));
  await ws.row(2, "plans/moved-2.md", 20);
  await ws.row(5, "archive/moved-5.md", 20);
  await ws.put(9, "# Rewritten\n\ncopper falcon orchid meadow");
  await ws.send("ws.rows.remove", { ids: ["r10"], at: 20 });
  await ws.send("ws.apply", { rules: { member: MEMBER([...FOLDERS, { prefix: "notes", visibility: "team" }], 2) } });
  await ws.build();
  return ws;
}

const answersOf = (meaning) => ASKS.map(({ words, tiers, prefix, topK }) => {
  const { served, matches } = meaning.query(fingerprint(words), { tiers, prefix, topK });
  assert.equal(served, true);
  return matches;
});

test("a woken object reads its index one row a note, and gives every answer the passages' own table gives", { skip }, async () => {
  const ws = await seeded();
  const warm = answersOf(ws.store.meaning);

  // Rows stored in another order than their passages' ids: the copy is read back in passage id order all the same.
  const heldRows = ws.sql.exec("SELECT row_id, path, etag, tier, ids, bits FROM ws_meaning_held ORDER BY row_id DESC").toArray();
  ws.sql.exec("DELETE FROM ws_meaning_held");
  for (const row of heldRows) ws.sql.exec("INSERT INTO ws_meaning_held (row_id, path, etag, tier, ids, bits) VALUES (?, ?, ?, ?, ?, ?)", row.row_id, row.path, row.etag, row.tier, row.ids, row.bits);
  ws.sql.seen = [];
  const packedRead = answersOf(ws.woken());
  const statements = ws.sql.seen;
  ws.sql.seen = null;
  assert.equal(statements.some((query) => /FROM ws_meaning_passages(?!\s+WHERE)/.test(query)), false, "no read of every passage");
  assert.ok(statements.some((query) => /SELECT path, tier, ids, bits FROM ws_meaning_held/.test(query)));

  // The same storage read the old way: no row has a packed copy.
  ws.sql.exec("UPDATE ws_meaning_held SET ids = NULL, bits = NULL");
  const passageRead = answersOf(ws.woken());

  assert.ok(warm.flat().length > 1_000, `${warm.flat().length} matches compared`);
  assert.deepEqual(packedRead, passageRead);
  assert.deepEqual(packedRead, warm, "and what the object held in memory before it slept");
  // The note with no fingerprint at all is held with no passages, and the one with a blank run keeps its chunk numbers.
  assert.equal(ws.sql.exec("SELECT COUNT(*) AS n FROM ws_meaning_passages WHERE row_id = 'r13'").toArray()[0].n, 0);
  assert.ok(ws.sql.exec("SELECT row_id FROM ws_meaning_held WHERE row_id = 'r13'").toArray().length === 1);
});

test("an index from before the packed copy is read the old way until a build packs it, then the new way", { skip }, async () => {
  const ws = await seeded();
  const before = answersOf(ws.woken());
  // As code from before this wrote it: every row with no copy, and one row half done is not taken as packed.
  ws.sql.exec("UPDATE ws_meaning_held SET ids = NULL, bits = NULL");
  ws.restart();
  ws.sql.seen = [];
  assert.deepEqual(answersOf(ws.woken()), before);
  assert.ok(ws.sql.seen.some((query) => /SELECT id, path, chunk, tier, bits FROM ws_meaning_passages$/.test(query.trim())), "read passage by passage");

  const answer = await ws.send("ws.meaning.build");
  assert.equal(answer.served, true);
  assert.equal(ws.sql.exec("SELECT COUNT(*) AS n FROM ws_meaning_held WHERE ids IS NULL").toArray()[0].n, 0, "one build packed every row");
  ws.sql.seen = [];
  assert.deepEqual(answersOf(ws.woken()), before);
  assert.equal(ws.sql.seen.some((query) => /FROM ws_meaning_passages(?!\s+WHERE)/.test(query)), false, "read from the packed copy");
  ws.sql.seen = null;
});

test("a copy that does not add up is not trusted", { skip }, async () => {
  const ws = await seeded();
  const before = answersOf(ws.woken());
  ws.sql.exec("UPDATE ws_meaning_held SET bits = X'00' WHERE row_id = 'r1'");
  ws.sql.seen = [];
  assert.deepEqual(answersOf(ws.woken()), before);
  assert.ok(ws.sql.seen.some((query) => /SELECT id, path, chunk, tier, bits FROM ws_meaning_passages$/.test(query.trim())), "read passage by passage");
  ws.sql.seen = null;
});
