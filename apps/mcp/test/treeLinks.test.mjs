/**
 * THE TREE'S LINKS: WHICH NOTE POINTS AT WHICH, BESIDE THE TREE TABLE.
 *
 * Run against real SQL (`node:sqlite`, the engine D1 runs). What is asked:
 *
 *  1. Does a note's text become the rows a rewrite would act on — paths
 *     resolved against its folder, bare names kept as names, code ignored?
 *  2. Does a fill pass read only notes not yet parsed at their version, and
 *     mark the table ready once none are left, pruning notes that left?
 *  3. Does "who links here" find a moved note's referrers by path and by bare
 *     name, the moved notes themselves, and every note changed since parsed?
 *  4. Is a table that is not ready, dirty, or too far behind refused, so a
 *     move walks the bucket as before?
 *  5. Does a rewrite handed candidates read only those notes, while still
 *     resolving bare names against every note?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, sqliteClient } from "./treeFixtures.mjs";
import { sweepTreePass } from "../src/tree/sweep.js";
import { ensureTreeTables, setStateStatements, TREE_STATE } from "../src/tree/table.js";
import {
  LINKS_READY,
  MOVE_UNPARSED_CAP,
  linkCandidates,
  linkFillPass,
  linkRowsOf,
  linkWriteStatements,
  readLinkState,
  treeLinkRows,
  treeNotePaths,
} from "../src/tree/links.js";

/** A bucket that also answers `get` with each note's text. */
function notes(given) {
  const texts = { ...given };
  const store = bucket(Object.keys(texts));
  const reads = [];
  store.get = async (key) => {
    reads.push(key);
    if (!store.objects.has(key)) return null;
    return { key, etag: store.objects.get(key).etag, text: async () => texts[key] ?? "" };
  };
  store.reads = reads;
  store.texts = texts;
  return store;
}

async function filled(texts) {
  const store = notes(texts);
  const client = sqliteClient();
  while (!(await sweepTreePass(store, client)).complete);
  for (let pass = 0; pass < 20; pass += 1) {
    if ((await linkFillPass(store, client)).ready) break;
  }
  return { store, client };
}

const WORKSPACE = {
  "1-projects/launch/overview.md": "# Launch\n\nSee [[plan]] and [budget](../../2-areas/budget.md).\n",
  "1-projects/launch/plan.md": "Back to [[overview]]. Rooted: [[2-areas/budget]]. ![[diagram.png]]\n",
  "2-areas/budget.md": "Nothing here links out. `[[not-a-link]]`\n\n```\n[[also-not]]\n```\n",
  "2-areas/notes.md": "About [[budget|the budget]] and [x](https://example.com) and [[#heading]].\n",
  "3-resources/unrelated.md": "Plain text.\n",
};

test("1. a note's text becomes the rows a rewrite would act on", () => {
  assert.deepEqual(linkRowsOf("1-projects/launch/overview.md", WORKSPACE["1-projects/launch/overview.md"]), [
    ["name", "plan"],
    ["path", "2-areas/budget.md"],
  ]);
  assert.deepEqual(linkRowsOf("1-projects/launch/plan.md", WORKSPACE["1-projects/launch/plan.md"]), [
    ["name", "overview"],
    ["path", "2-areas/budget.md"],
    ["name", "diagram.png"],
  ]);
  // Code is documentation about a link, not a link; nor is a URL or a heading.
  assert.deepEqual(linkRowsOf("2-areas/budget.md", WORKSPACE["2-areas/budget.md"]), []);
  assert.deepEqual(linkRowsOf("2-areas/notes.md", WORKSPACE["2-areas/notes.md"]), [["name", "budget"]]);
  // The same link twice is one row.
  assert.deepEqual(linkRowsOf("a.md", "[[b]] [[b]] [[b|again]]"), [["name", "b"]]);
});

test("2. a fill reads each note once, at its version, then marks the table ready", async () => {
  const { store, client } = await filled(WORKSPACE);
  assert.equal(store.reads.length, Object.keys(WORKSPACE).length);
  const state = await readLinkState(client);
  assert.equal(state.ready, true);
  assert.equal(state.unparsed, 0);
  assert.deepEqual(await treeNotePaths(client), Object.keys(WORKSPACE).sort());
  assert.equal((await treeLinkRows(client)).length, 6);

  // A note changed in the bucket, and seen changed by the tree, is unparsed again.
  store.texts["3-resources/unrelated.md"] = "Now it points at [[budget]].\n";
  store.put("3-resources/unrelated.md");
  while (!(await sweepTreePass(store, client)).complete);
  assert.equal((await readLinkState(client)).unparsed, 1);
  store.reads.length = 0;
  await linkFillPass(store, client);
  assert.deepEqual(store.reads, ["3-resources/unrelated.md"]);
  assert.ok((await treeLinkRows(client)).some(([source, kind, target]) =>
    source === "3-resources/unrelated.md" && kind === "name" && target === "budget"));

  // A note that left: its rows are never read back, and the next empty pass prunes them.
  store.remove("1-projects/launch/plan.md");
  while (!(await sweepTreePass(store, client)).complete);
  assert.ok(!(await treeLinkRows(client)).some(([source]) => source === "1-projects/launch/plan.md"));
  await linkFillPass(store, client);
  const [left] = await client.query("SELECT count(*) AS n FROM tree_links WHERE source = '1-projects/launch/plan.md'");
  assert.equal(left.n, 0);
});

test("2b. an editor save records its links at the version the tree row has", async () => {
  const { client } = await filled(WORKSPACE);
  await client.runAll(linkWriteStatements("2-areas/notes.md", '"2-areas/notes.md-v1"', "Now [[plan]] only.\n"));
  assert.equal((await readLinkState(client)).unparsed, 0);
  const rows = (await treeLinkRows(client)).filter(([source]) => source === "2-areas/notes.md");
  assert.deepEqual(rows, [["2-areas/notes.md", "name", "plan"]]);
});

test("3. who links here: by path, by bare name, the moved notes, and anything unparsed", async () => {
  const { store, client } = await filled(WORKSPACE);
  const renames = new Map([["2-areas/budget.md", "4-archive/budget.md"]]);
  const found = await linkCandidates(client, renames);
  assert.notEqual(found, null);
  assert.deepEqual([...found.candidates].sort(), [
    "1-projects/launch/overview.md", // a relative path to it
    "1-projects/launch/plan.md", // a rooted path to it
    "2-areas/notes.md", // a bare [[budget]]
    "4-archive/budget.md", // the note itself: its own relative links change depth
  ]);
  // Every note, with the move applied: bare names resolve against all of them.
  assert.deepEqual(found.inventory.sort(), [
    "1-projects/launch/overview.md",
    "1-projects/launch/plan.md",
    "2-areas/notes.md",
    "3-resources/unrelated.md",
    "4-archive/budget.md",
  ]);

  // A note edited since it was parsed may now link to it: it is read too.
  store.texts["3-resources/unrelated.md"] = "[[budget]]";
  store.put("3-resources/unrelated.md");
  while (!(await sweepTreePass(store, client)).complete);
  const again = await linkCandidates(client, renames);
  assert.ok(again.candidates.has("3-resources/unrelated.md"));
});

test("4. a table that cannot be trusted is refused, and the move walks", async () => {
  const renames = new Map([["2-areas/budget.md", "4-archive/budget.md"]]);

  // Never filled.
  const store = notes(WORKSPACE);
  const client = sqliteClient();
  assert.equal(await linkCandidates(client, renames), null);
  while (!(await sweepTreePass(store, client)).complete);
  assert.equal(await linkCandidates(client, renames), null, "tree whole, links never read");

  // Filled, then marked dirty by a change too big to re-check.
  const ready = await filled(WORKSPACE);
  assert.notEqual(await linkCandidates(ready.client, renames), null);
  await ready.client.runAll(setStateStatements({ [TREE_STATE.dirty]: 1 }));
  assert.equal(await linkCandidates(ready.client, renames), null, "dirty");

  // Filled, but too many notes changed since.
  const behind = await filled(WORKSPACE);
  const rows = [];
  for (let index = 0; index <= MOVE_UNPARSED_CAP; index += 1) rows.push([`9-bulk/n${index}.md`, `"v${index}"`, 1, 1]);
  await behind.client.runAll([{
    sql: `INSERT INTO tree (path, etag, size, uploaded, at) SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), 1, 1, 1 FROM json_each(?1) AS j WHERE true`,
    params: [JSON.stringify(rows)],
  }]);
  assert.equal(await linkCandidates(behind.client, renames), null, "too far behind");

  // A ready flag alone does not make a table: one with no tree is refused.
  const bare = sqliteClient();
  await ensureTreeTables(bare);
  await bare.runAll(setStateStatements({ [LINKS_READY]: 1 }));
  assert.equal(await linkCandidates(bare, renames), null);
});

test("5. a rewrite handed candidates reads only those, and still resolves names across every note", async () => {
  const { R2Store } = await import("../src/store/r2.js");
  const { memoryBucket } = await import("./store/fixtures.mjs");
  const { loadPrivacyState } = await import("../src/privacy/state.js");
  const { rewriteReferences } = await import("../src/tools/moves/references.js");
  const raw = memoryBucket();
  const texts = {
    "1-projects/a.md": "Points at [[budget]].\n",
    "1-projects/b.md": "Points at [[other]].\n",
    "4-archive/budget-2025.md": "# Budget\n",
    // Two notes named `other`: a bare [[other]] is ambiguous across the bucket,
    // and must stay so even when only a few notes are read.
    "2-areas/other.md": "# Other\n",
    "3-resources/other.md": "# Other too\n",
  };
  for (const [key, text] of Object.entries(texts)) await raw.put(key, text);
  const reads = [];
  const get = raw.get.bind(raw);
  raw.get = async (key) => {
    if (key.endsWith(".md") && !key.startsWith(".") && key !== "privacy.md") reads.push(key);
    return get(key);
  };
  const store = new R2Store(raw);
  const state = await loadPrivacyState(store);
  const renames = new Map([["2-areas/budget.md", "4-archive/budget-2025.md"]]);
  const inventoryKeys = Object.keys(texts);
  const result = await rewriteReferences(store, "private", state.rules, state.overrides, renames, {
    write: false,
    inventoryKeys,
    candidates: new Set(["1-projects/a.md", "4-archive/budget-2025.md"]),
  });
  assert.deepEqual([...new Set(reads)].sort(), ["1-projects/a.md", "4-archive/budget-2025.md"]);
  assert.equal(result.notes, 1, "a.md's [[budget]] follows the move");
  assert.equal(result.links, 1);

  // The ambiguity is the whole bucket's: handed only b.md, [[other]] is still not rewritten.
  const renamed = new Map([["2-areas/other.md", "4-archive/other-old.md"]]);
  const ambiguous = await rewriteReferences(store, "private", state.rules, state.overrides, renamed, {
    write: false,
    inventoryKeys,
    candidates: new Set(["1-projects/b.md"]),
  });
  assert.equal(ambiguous.links, 0);
});
