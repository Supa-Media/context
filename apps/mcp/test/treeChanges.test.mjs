/**
 * THE TREE LOG: WHAT CHANGED SINCE A DEVICE LAST SYNCED.
 *
 * A device back online asks for the keys that changed since its last sync
 * rather than walking the whole tree. What is asked, against real SQL:
 *
 *  1. Does a note that appears, changes version, or leaves get logged — and
 *     does a sweep that finds nothing new log nothing?
 *  2. Does a key that left keep the audiences its writer said could see it,
 *     and one the writer knew nothing about keep none?
 *  3. Can a slow observation from before a newer one log a change that did
 *     not happen?
 *  4. Is the log paged without skipping or repeating a row?
 *  5. Is a catch-up refused when the log does not reach back far enough?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, sqliteClient } from "./treeFixtures.mjs";
import { readTreeState, observeStatements, TOMBSTONE_MS } from "../src/tree/table.js";
import { sweepTreePass } from "../src/tree/sweep.js";
import { touchTree } from "../src/tree/touch.js";
import {
  CHANGE_OVERLAP_MS,
  changesReachBack,
  foldersStillHeld,
  listTreeChanges,
} from "../src/tree/changes.js";

async function swept(keys) {
  const store = bucket(keys);
  const client = sqliteClient();
  assert.equal((await sweepTreePass(store, client)).complete, true);
  return { store, client };
}

/** Everything logged after `cursor`, and the cursor after it. */
async function changesAfter(client, cursor = { since: 0, after: "" }) {
  const rows = await listTreeChanges(client, cursor);
  const last = rows[rows.length - 1];
  // The log's clock is in milliseconds, and a write in the same millisecond as
  // the last row but sorting before it would land behind this cursor. A real
  // catch-up rewinds by `CHANGE_OVERLAP_MS` for that; these tests wait for the
  // database's own clock to move on instead.
  if (last) while ((await readTreeState(client)).now <= last.at) await new Promise((resolve) => setImmediate(resolve));
  return { rows, next: last ? { since: last.at, after: last.path } : cursor };
}

test("a first sweep logs every key, and a sweep that finds nothing new logs nothing", async () => {
  const { store, client } = await swept(["1-projects/a.md", "2-areas/b.md", ".context/x.json"]);
  const first = await changesAfter(client);
  assert.deepEqual(first.rows.map((row) => [row.path, row.gone]), [["1-projects/a.md", false], ["2-areas/b.md", false]]);
  assert.equal(first.rows[0].etag, '"1-projects/a.md-v1"');

  await client.runAll([{ sql: "DELETE FROM index_state WHERE key = 'tree_ready'", params: [] }]);
  assert.equal((await sweepTreePass(store, client)).complete, true);
  assert.deepEqual((await changesAfter(client, first.next)).rows, []);
});

test("a new version and a new note are logged; the same version observed again is not", async () => {
  const { store, client } = await swept(["1-projects/a.md", "2-areas/b.md"]);
  const { next } = await changesAfter(client);
  store.put("1-projects/a.md");
  store.put("1-projects/c.md");
  await touchTree(store, client, { files: ["1-projects/a.md", "1-projects/c.md", "2-areas/b.md"] });
  const { rows } = await changesAfter(client, next);
  assert.deepEqual(rows.map((row) => [row.path, row.etag]), [
    ["1-projects/a.md", '"1-projects/a.md-v2"'],
    ["1-projects/c.md", '"1-projects/c.md-v2"'],
  ]);
});

test("a key that left keeps the audiences its writer gave, and a key nobody described keeps none", async () => {
  const { store, client } = await swept(["1-projects/a.md", "1-projects/held.md", "2-areas/b.md"]);
  const { next } = await changesAfter(client);
  store.remove("1-projects/held.md");
  store.remove("2-areas/b.md");
  await touchTree(store, client, {
    files: ["1-projects/held.md", "2-areas/b.md"],
    left: [{ path: "1-projects/held.md", audiences: ["private"] }],
  });
  const { rows } = await changesAfter(client, next);
  assert.deepEqual(rows.map((row) => [row.path, row.gone, row.audiences]), [
    ["1-projects/held.md", true, ["private"]],
    ["2-areas/b.md", true, null],
  ]);
});

test("a key deleted outside the product leaves the log through the sweep, with no audiences", async () => {
  const { store, client } = await swept(["1-projects/a.md", "2-areas/b.md"]);
  const { next } = await changesAfter(client);
  store.remove("2-areas/b.md");
  // A sweep removes rows observed before it began, and the first one's are
  // only before it once the millisecond has turned.
  const turned = Date.now();
  while (Date.now() <= turned) await new Promise((resolve) => setImmediate(resolve));
  await client.runAll([{ sql: "DELETE FROM index_state WHERE key = 'tree_ready'", params: [] }]);
  assert.equal((await sweepTreePass(store, client)).complete, true);
  const { rows } = await changesAfter(client, next);
  assert.deepEqual(rows.map((row) => [row.path, row.gone, row.audiences]), [["2-areas/b.md", true, null]]);
});

test("a key that comes back after leaving is logged as present again", async () => {
  const { store, client } = await swept(["1-projects/a.md"]);
  store.remove("1-projects/a.md");
  await touchTree(store, client, { files: ["1-projects/a.md"] });
  const { next } = await changesAfter(client);
  store.put("1-projects/a.md");
  await touchTree(store, client, { files: ["1-projects/a.md"] });
  const { rows } = await changesAfter(client, next);
  assert.deepEqual(rows.map((row) => [row.path, row.gone]), [["1-projects/a.md", false]]);
});

test("an observation older than the row it would change logs nothing", async () => {
  const { client } = await swept(["1-projects/a.md"]);
  const { next } = await changesAfter(client);
  // The sweep observed at real time; this listing was taken long before.
  await client.runAll(observeStatements([["1-projects/a.md", '"older"', 1, null]], 1));
  assert.deepEqual((await changesAfter(client, next)).rows, []);
  const [row] = await client.query("SELECT etag FROM tree WHERE path = '1-projects/a.md'");
  assert.equal(row.etag, '"1-projects/a.md-v1"');
});

test("the log pages in (time, path) order without skipping or repeating a row", async () => {
  const keys = Array.from({ length: 25 }, (_, index) => `3-resources/r${String(index).padStart(2, "0")}.md`);
  const { client } = await swept(keys);
  const seen = [];
  let cursor = { since: 0, after: "" };
  for (let page = 0; page < 20; page += 1) {
    const rows = await listTreeChanges(client, { ...cursor, limit: 7 });
    if (rows.length === 0) break;
    seen.push(...rows.map((row) => row.path));
    cursor = { since: rows[rows.length - 1].at, after: rows[rows.length - 1].path };
  }
  assert.deepEqual(seen, keys);
});

test("a catch-up is answered only from a log that reaches back to it", async () => {
  const { client } = await swept(["1-projects/a.md"]);
  const state = await readTreeState(client);
  assert.ok(state.logFrom !== null && state.now !== null && state.now >= state.logFrom);
  assert.equal(changesReachBack(state, state.logFrom), true);
  assert.equal(changesReachBack(state, state.logFrom - 1), false, "before the log began");
  const old = { ...state, logFrom: 0 };
  assert.equal(changesReachBack(old, state.now - TOMBSTONE_MS + CHANGE_OVERLAP_MS + 1), true);
  assert.equal(changesReachBack(old, state.now - TOMBSTONE_MS), false, "past pruning");
  assert.equal(changesReachBack({ ...state, ready: false }, state.now), false);
  assert.equal(changesReachBack({ ...state, unsupported: true }, state.now), false);
  assert.equal(changesReachBack(state, Number.NaN), false);
});

test("a database made before the log gains it from the first change after", async () => {
  const { store, client } = await swept(["1-projects/a.md"]);
  client.db.exec("DROP TABLE tree_log");
  store.put("1-projects/a.md");
  const touched = await touchTree(store, client, { files: ["1-projects/a.md"] });
  assert.equal(touched.dirty, false);
  assert.deepEqual((await changesAfter(client)).rows.map((row) => row.path), ["1-projects/a.md"]);
});

test("a folder is still held while any key, or its own marker, is under it", async () => {
  const { client } = await swept(["1-projects/a.md", "2-areas/", "2-areasX/c.md"]);
  const held = await foldersStillHeld(client, ["1-projects", "2-areas", "3-resources", "2-area"]);
  assert.deepEqual([...held].sort(), ["1-projects", "2-areas"]);
});
