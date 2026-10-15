/**
 * THE TREE'S LINKS, PARSED: WHICH NOTE POINTS AT WHICH.
 *
 * The Convex control plane keeps these as its tree's link facts, parsed by
 * `linkRowsOf`, and a move asks it which notes to read (`tree/facts.js`). The
 * search database's link table that kept them first was retired in phase 7
 * (`tree/retired.js`). What is asked:
 *
 *  1. Does a note's text become the rows a rewrite would act on — paths
 *     resolved against its folder, bare names kept as names, code ignored?
 *  2. Is a bare link's name what a note is called without `.md`?
 *  3. Does a rewrite handed candidates read only those notes, while still
 *     resolving bare names against every note?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bareNameOf, linkRowsOf } from "../src/tree/links.js";

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

test("2. a bare link names a note without its folder or `.md`", () => {
  assert.equal(bareNameOf("1-projects/x/overview.md"), "overview");
  assert.equal(bareNameOf("top.md"), "top");
  assert.equal(bareNameOf("3-resources/diagram.png"), "diagram.png");
});

test("3. a rewrite handed candidates reads only those, and still resolves names across every note", async () => {
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
