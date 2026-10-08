/**
 * THE TREE TABLE: A CONTEXT'S KEYS IN ITS OWN DATABASE, KEPT TRUE.
 *
 * Run against real SQL (`node:sqlite`, the engine D1 runs) and a bucket that
 * lists the way S3 does — byte order, pages, `startAfter`. What is asked:
 *
 *  1. Does a sweep make the table match the bucket, plumbing left out?
 *  2. Does it resume where it stopped, rather than starting over?
 *  3. Does a finished sweep remove what the bucket no longer holds, without
 *     removing what the write path observed while it ran?
 *  4. Can a sweep that listed a key just before it was deleted bring it back?
 *  5. Does the write path's re-check follow a move, of a note and a folder?
 *  6. Does a change too big to re-check ask for a sweep instead?
 *  7. Is a store that cannot resume in order refused, rather than served?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, sqliteClient } from "./treeFixtures.mjs";
import { readTreeState, listTreePage, TREE_STATE } from "../src/tree/table.js";
import { sweepTreePass, sweepDue, compareKeys, SWEEP_LEASE_MS, SWEEP_STALE_MS } from "../src/tree/sweep.js";
import { touchTree, writtenStatements, TOUCH_PATHS } from "../src/tree/touch.js";
import { treeListingStore } from "../src/tree/source.js";

async function paths(client) {
  return (await client.query("SELECT path FROM tree ORDER BY path")).map((row) => row.path);
}

function clock(start = 10_000) {
  let now = start;
  const tick = () => {
    now += 1;
    return now;
  };
  tick.advance = (ms) => {
    now += ms;
  };
  return tick;
}

const NOTES = [
  "0-inbox/a.md",
  "1-projects/plan.md",
  "1-projects/plan/attachment.png",
  "2-areas/ü.md",
  "2-areas/z.md",
  "privacy.md",
];

test("a sweep makes the table match the bucket, top-level dot folders left out", async () => {
  const store = bucket([...NOTES, ".context/reads/1.json", ".context/reads/2.json", ".obsidian/app.json"]);
  const client = sqliteClient();
  const result = await sweepTreePass(store, client, { now: clock() });
  assert.equal(result.complete, true);
  assert.deepEqual(await paths(client), [...NOTES].sort(compareKeys));
  const state = await readTreeState(client);
  assert.equal(state.ready, true);
  assert.equal(state.cursor, null);
});

test("table order is the bucket's byte order, so a walk of one resumes like the other", async () => {
  const keys = ["a/ä.md", "a/z.md", "a-b/x.md", "a/b.md", "A.md", "a.md"];
  const store = bucket(keys);
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: clock() });
  assert.deepEqual(await paths(client), [...keys].sort(compareKeys));
  const page = await listTreePage(client, { prefix: "a/", after: "a/b.md" });
  assert.deepEqual(page.map((row) => row.path), ["a/z.md", "a/ä.md"]);
});

test("a sweep resumes from where the last pass stopped", async () => {
  const store = bucket(NOTES, { pageSize: 2 });
  const client = sqliteClient();
  const now = clock();
  const first = await sweepTreePass(store, client, { now, maxPages: 1 });
  assert.equal(first.complete, false);
  assert.equal((await readTreeState(client)).ready, false);
  assert.equal((await paths(client)).length, 2);
  const listsBefore = store.lists;
  const rest = await sweepTreePass(store, client, { now, maxPages: 10 });
  assert.equal(rest.complete, true);
  // Two more pages of two, then the last: never the first page again.
  assert.equal(store.lists - listsBefore, 2);
  assert.deepEqual(await paths(client), [...NOTES].sort(compareKeys));
});

test("a plumbing folder in the middle of a page is jumped, not walked", async () => {
  const reads = Array.from({ length: 50 }, (_, index) => `.context/reads/${String(index).padStart(3, "0")}.json`);
  const store = bucket([".a.md", ...reads, "note.md"], { pageSize: 5 });
  const client = sqliteClient();
  const result = await sweepTreePass(store, client, { now: clock() });
  assert.equal(result.complete, true);
  assert.deepEqual(await paths(client), [".a.md", "note.md"]);
  assert.ok(store.lists <= 3, `walked ${store.lists} pages`);
});

test("a finished sweep removes keys the bucket lost, and keeps what was observed while it ran", async () => {
  const store = bucket(NOTES, { pageSize: 2 });
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });
  // Deleted outside the product: nothing told the table.
  store.remove("2-areas/z.md");
  // The next sweep stops part-way, a note is created behind its position and
  // re-checked by the write path, then the sweep finishes.
  await sweepTreePass(store, client, { now, maxPages: 2 });
  store.put("0-inbox/new.md");
  await touchTree(store, client, { files: ["0-inbox/new.md"], now });
  await sweepTreePass(store, client, { now });
  const after = await paths(client);
  assert.ok(!after.includes("2-areas/z.md"), "a key the bucket lost stays");
  assert.ok(after.includes("0-inbox/new.md"), "a key observed during the sweep was removed");
});

test("a key listed just before it was deleted is not brought back", async () => {
  const store = bucket(NOTES, { pageSize: 1000 });
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });
  // A slow sweep page: listed at t, its write lands after a delete seen at t+5.
  const listedAt = now();
  const listing = await store.list({});
  store.remove("1-projects/plan.md");
  now.advance(5);
  await touchTree(store, client, { files: ["1-projects/plan.md"], now });
  const { observeStatements, rowOf } = await import("../src/tree/table.js");
  await client.runAll(observeStatements(listing.objects.map(rowOf), listedAt));
  assert.ok(!(await paths(client)).includes("1-projects/plan.md"));
  // And a later observation that it exists again does bring it back.
  store.put("1-projects/plan.md");
  await touchTree(store, client, { files: ["1-projects/plan.md"], now });
  assert.ok((await paths(client)).includes("1-projects/plan.md"));
});

test("an older observation never overwrites a newer version", async () => {
  const store = bucket(NOTES);
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });
  const stale = now();
  store.put("0-inbox/a.md", '"newer"');
  await touchTree(store, client, { files: ["0-inbox/a.md"], now });
  const { observeStatements } = await import("../src/tree/table.js");
  await client.runAll(observeStatements([["0-inbox/a.md", '"older"', 1, null]], stale));
  const [row] = await client.query("SELECT etag FROM tree WHERE path = ?", ["0-inbox/a.md"]);
  assert.equal(row.etag, '"newer"');
});

test("the write path follows a note's move and a folder's", async () => {
  const store = bucket(NOTES);
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });

  store.remove("0-inbox/a.md");
  store.put("2-areas/a.md");
  await touchTree(store, client, { paths: ["0-inbox/a.md", "2-areas/a.md"], now });
  let listed = await paths(client);
  assert.ok(!listed.includes("0-inbox/a.md"));
  assert.ok(listed.includes("2-areas/a.md"));

  for (const key of ["1-projects/plan.md", "1-projects/plan/attachment.png"]) {
    store.remove(key);
    store.put(key.replace("1-projects/", "4-archive/"));
  }
  await touchTree(store, client, { paths: ["1-projects/", "4-archive"], now });
  listed = await paths(client);
  assert.ok(!listed.some((path) => path.startsWith("1-projects/")), listed.join(","));
  assert.ok(listed.includes("4-archive/plan.md"));
  assert.ok(listed.includes("4-archive/plan/attachment.png"));
  // A sibling whose name only starts the same is not part of the folder.
  assert.ok(listed.includes("2-areas/ü.md"));
});

test("a change too big to re-check marks the table for a sweep", async () => {
  const store = bucket(NOTES);
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });
  const many = Array.from({ length: TOUCH_PATHS + 1 }, (_, index) => `x/${index}.md`);
  const result = await touchTree(store, client, { paths: many, now });
  assert.equal(result.dirty, true);
  const state = await readTreeState(client);
  assert.equal(state.dirty, true);
  assert.equal(sweepDue({ ...state, leaseAt: null }, now()), true);
  await sweepTreePass(store, client, { now });
  assert.equal((await readTreeState(client)).dirty, false);
});

test("a sweep is due when never finished, stale, or asked for, and not while a pass holds it", () => {
  const base = { ready: true, sweptAt: 1_000, cursor: null, startedAt: null, leaseAt: null, dirty: false, unsupported: false };
  assert.equal(sweepDue(base, 1_000 + SWEEP_STALE_MS - 1), false);
  assert.equal(sweepDue(base, 1_000 + SWEEP_STALE_MS), true);
  assert.equal(sweepDue({ ...base, ready: false }, 2_000), true);
  assert.equal(sweepDue({ ...base, cursor: "a" }, 2_000), true);
  assert.equal(sweepDue({ ...base, cursor: "a", leaseAt: 2_000 }, 2_000 + SWEEP_LEASE_MS - 1), false);
  assert.equal(sweepDue({ ...base, unsupported: true, ready: false }, 2_000), false);
});

test("a store that ignores the resume position is marked unsupported, never served", async () => {
  const store = bucket(NOTES, { pageSize: 2, honoursStartAfter: false });
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now, maxPages: 1 });
  const result = await sweepTreePass(store, client, { now });
  assert.equal(result.unsupported, true);
  const state = await readTreeState(client);
  assert.equal(state.unsupported, true);
  assert.equal(state.ready, false);
  assert.equal(sweepDue(state, now()), false);
});

test("the table reads back as a listing: same keys, versions and pages as the bucket", async () => {
  const keys = Array.from({ length: 4_500 }, (_, index) => `f/${String(index).padStart(5, "0")}.md`);
  const store = bucket(keys);
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: clock() });
  const listing = treeListingStore(store, client);
  const seen = [];
  let request = {};
  for (;;) {
    const page = await listing.list({ prefix: "f/", limit: 1000, ...request });
    seen.push(...page.objects);
    if (!page.truncated) break;
    request = { cursor: page.cursor };
  }
  assert.deepEqual(seen.map((object) => object.key), keys);
  assert.equal(seen[0].etag, `"${keys[0]}-v1"`);
  // Everything else is still the bucket's own.
  assert.equal(await listing.get("privacy.md"), null);
});

test("a writer's own record costs no listing and keeps an unknown version unknown", async () => {
  const store = bucket(NOTES);
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now });
  const lists = store.lists;
  await client.runAll(writtenStatements([{ path: "0-inbox/b.md", etag: '"w1"' }, { path: "0-inbox/a.md" }, { path: ".context/x" }], now()));
  assert.equal(store.lists, lists);
  const rows = await client.query("SELECT path, etag FROM tree WHERE path LIKE '0-inbox/%' ORDER BY path");
  assert.deepEqual(rows.map((row) => [row.path, row.etag]), [["0-inbox/a.md", null], ["0-inbox/b.md", '"w1"']]);
});

test("no state key the search backfill uses is touched", async () => {
  const client = sqliteClient();
  await sweepTreePass(bucket(NOTES), client, { now: clock() });
  const keys = (await client.query("SELECT key FROM index_state")).map((row) => row.key);
  assert.ok(keys.every((key) => key.startsWith("tree_")), keys.join(","));
  assert.ok(Object.values(TREE_STATE).every((key) => key.startsWith("tree_")));
});

test("two passes starting one sweep keep the earlier start, so neither removes the other's rows", async () => {
  const store = bucket(NOTES, { pageSize: 2 });
  const client = sqliteClient();
  const now = clock(50_000);
  const { ensureTreeTables, setStateStatements } = await import("../src/tree/table.js");
  await ensureTreeTables(client);
  // Another pass started this sweep a moment earlier and has not written its cursor yet.
  await client.runAll(setStateStatements({ [TREE_STATE.startedAt]: 40_000 }));
  await sweepTreePass(store, client, { now, maxPages: 1 });
  assert.equal((await readTreeState(client)).startedAt, 40_000);
  // A row the other pass observed after its own start survives this pass's finish.
  await client.runAll((await import("../src/tree/table.js")).observeStatements([["0-inbox/seen-by-the-other.md", null, 1, null]], 45_000));
  store.put("0-inbox/seen-by-the-other.md");
  const done = await sweepTreePass(store, client, { now });
  assert.equal(done.complete, true);
  assert.ok((await paths(client)).includes("0-inbox/seen-by-the-other.md"));
});

test("a table that cannot answer a page hands the walk to the bucket, not an error", async () => {
  const store = bucket(NOTES);
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: clock() });
  const broken = { ...client, query: async () => { throw new Error("D1 unavailable"); } };
  const listing = treeListingStore(store, broken);
  const page = await listing.list({ prefix: "", startAfter: "1-projects/plan.md" });
  assert.deepEqual(page.objects.map((object) => object.key), ["1-projects/plan/attachment.png", "2-areas/z.md", "2-areas/ü.md", "privacy.md"]);
});

test("a pass that fails says why, and the next one that moves on clears it", async () => {
  const store = bucket(NOTES, { pageSize: 2 });
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now, maxPages: 1 });
  const list = store.list;
  store.list = async () => {
    throw new Error("S3 LIST failed: 403 AccessDenied");
  };
  await assert.rejects(sweepTreePass(store, client, { now }), /AccessDenied/);
  const stuck = await readTreeState(client);
  assert.match(stuck.error, /AccessDenied/);
  assert.equal(typeof stuck.errorAt, "number");
  // The failed pass did not move the sweep.
  assert.equal(stuck.cursor, "1-projects/plan.md");
  store.list = list;
  const rest = await sweepTreePass(store, client, { now, maxPages: 1 });
  assert.equal(rest.complete, false);
  const moving = await readTreeState(client);
  assert.equal(moving.error, null);
  assert.equal(moving.errorAt, null);
});

test("a listing that says there is more but returns nothing new is recorded as stuck", async () => {
  const store = bucket(NOTES, { pageSize: 2 });
  const client = sqliteClient();
  const now = clock();
  await sweepTreePass(store, client, { now, maxPages: 1 });
  store.list = async () => ({ objects: [], truncated: true });
  const result = await sweepTreePass(store, client, { now });
  assert.equal(result.complete, false);
  assert.match((await readTreeState(client)).error, /returned nothing new/);
});
