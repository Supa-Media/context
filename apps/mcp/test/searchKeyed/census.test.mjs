/**
 * The search census in a keyed workspace (`docs/decisions/storage-and-credentials/notes-by-id.md`,
 * `docs/decisions/search.md`).
 *
 * Once a workspace is keyed, a note's bytes live only at `notes/<noteId>.md`,
 * and the bucket lists uuid keys, not names. The census the index is built from
 * must therefore be the tree's names and row etags, and body reads go by name
 * through the id layer. Sabotage, each confirmed to fail a case here (local edits, reverted):
 *
 *  - the census lists the bucket again (`namesOf` returns the store): the names,
 *    no-bucket-list and loading cases fail;
 *  - the fallback scan lists the bucket again (`scan.js` without `namesOf`): the scan case fails.
 *
 * The body-by-name case holds before and after the fix: it guards the id layer's
 * routing, which `idLayoutKeys.test.mjs` proves case by case.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withIdLayout } from "../../src/store/idLayout.js";
import { idKeyFor } from "../../src/store/noteIdKeys.js";
import { defaultIsIndexable } from "../../src/search/maintain.js";
import { scanVisibleNotes } from "../../src/search/scan.js";
import { R2Store } from "../../src/store/r2.js";
import { createBucket, createSearchBudget, storedManifest, syncShardedIndex } from "../searchShards/fixtures.mjs";

const NOTES = [
  { path: "1-projects/alpha.md", noteId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51", body: "# Alpha\n\nA PANGOLIN sighting in alpha.\n" },
  { path: "2-areas/beta.md", noteId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52", body: "# Beta\n\nA quiet note about beta.\n" },
];

/** A keyed workspace: every note's bytes at its id key only, and a tree whose rows say so. */
function keyedWorkspace({ served = true } = {}) {
  const bucket = createBucket();
  const rows = new Map();
  for (const { path, noteId, body } of NOTES) {
    const key = idKeyFor(noteId, path);
    bucket.seed(key, body);
    rows.set(path, { path, noteId, key, etag: bucket.etagOf(key), size: body.length });
  }
  const raw = new R2Store(bucket);
  Object.defineProperty(raw, "treeManifest", {
    enumerable: false,
    value: async ({ folder } = {}) => {
      if (!served) return { served: false };
      const entries = [...rows.values()]
        .filter((row) => folder === undefined || row.path.startsWith(`${folder}/`))
        .map(({ path, etag, size }) => ({ path, etag, size, updatedAt: Date.UTC(2026, 9, 1) }));
      return { served: true, entries, cursor: null };
    },
  });
  const lookup = async (paths) => {
    const notes = {};
    for (const path of paths) {
      const row = rows.get(path);
      if (row) notes[path] = { path, state: "keyed", noteId: row.noteId, key: row.key, etag: row.etag };
    }
    return { keyed: true, notes };
  };
  const store = withIdLayout(raw, {
    lookup,
    wrote: async () => {},
    adopt: async () => ({ adopted: false, taken: null }),
    removed: async () => {},
    mode: "keys",
  });
  return { bucket, store, rows };
}

test("a keyed workspace's census is the tree's names, with the row etags, never the bucket's uuid keys", async () => {
  const { bucket, store, rows } = keyedWorkspace();
  await syncShardedIndex(store, { budget: createSearchBudget(200), isIndexable: defaultIsIndexable });

  const manifest = storedManifest(bucket);
  assert.ok(manifest, "the pass wrote a manifest");
  const docs = new Map();
  for (const shard of manifest.docsByShard) for (const [path, version] of shard) docs.set(path, version);

  assert.deepEqual([...docs.keys()].sort(), NOTES.map((note) => note.path).sort(), "the index names the notes by their path");
  for (const row of rows.values()) {
    assert.equal(docs.get(row.path), row.etag, `${row.path} is versioned by its row's etag, which for a keyed row is the key's`);
  }
});

test("a keyed workspace's census never lists the bucket", async () => {
  const { bucket, store } = keyedWorkspace();
  await syncShardedIndex(store, { budget: createSearchBudget(200), isIndexable: defaultIsIndexable });
  assert.equal(bucket.counts.list, 0, "no listing of the bucket: its keys are uuids, not names");
});

test("a keyed body is read by name, through the id key, never at a census key", async () => {
  const { bucket, store } = keyedWorkspace();
  await syncShardedIndex(store, { budget: createSearchBudget(200), isIndexable: defaultIsIndexable });
  for (const { path, noteId } of NOTES) {
    assert.equal(bucket.counts.gets.includes(idKeyFor(noteId, path)), true, `${path} is read at its id key`);
    assert.equal(bucket.counts.gets.includes(path), false, `${path} is not read at its name`);
  }
});

test("the fallback scan of a keyed workspace names its hits by the tree's names, and reads them by name", async () => {
  const { bucket, store } = keyedWorkspace();
  const found = await scanVisibleNotes(store, "private", [], {}, "pangolin", "", createSearchBudget(200));
  assert.deepEqual(found.hits.map((hit) => hit.key), ["1-projects/alpha.md"], "a hit is named by its path, never by its uuid key");
  assert.equal(bucket.counts.list, 0, "the scan lists the tree, not the bucket");
  assert.equal(bucket.counts.gets.includes(idKeyFor(NOTES[0].noteId, NOTES[0].path)), true, "the body is read at its id key");
});

test("a keyed workspace whose tree is still loading gets no census, and the bucket is not listed instead", async () => {
  const { bucket, store } = keyedWorkspace({ served: false });
  await assert.rejects(syncShardedIndex(store, { budget: createSearchBudget(200), isIndexable: defaultIsIndexable }));
  assert.equal(bucket.counts.list, 0, "no bucket listing while the tree is loading");
  assert.equal(storedManifest(bucket), null, "no index is written from a census nobody has");
});
