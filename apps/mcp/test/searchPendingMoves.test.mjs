/**
 * Search answers at the names the tree draws while a queued folder move is
 * still copying (phase 4 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * The indexes hold notes at their bucket keys, and a queued move leaves those
 * keys in place until its copy lands. Before this, `search_notes` answered at
 * the old names: a path no screen shows any more, and, for a move into a
 * narrower folder, a hit judged by the old folder's rules.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `atTreeNames` call in `searchBothWays` and every case fails;
 *  - skip the visibility check at the new name and the narrowing case fails;
 *  - skip the prefix check and the folder case fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { atTreeNames, searchBothWays } from "../src/search/meaning/serve.js";

function storeWith(pendingMoves) {
  const store = {};
  Object.defineProperty(store, "pendingMoves", { value: pendingMoves, enumerable: false });
  return store;
}

const hit = (key) => ({ key, title: key, snippets: ["line"] });

test("a hit inside a moving folder is shown at the folder's new name", async () => {
  const store = storeWith([{ from: "1-projects/a", to: "4-archive/a" }]);
  const found = await searchBothWays(
    store,
    async () => ({ hits: [hit("1-projects/a/x.md"), hit("2-areas/y.md")], matchCount: 2 }),
    { query: "line", scope: "team", isVisible: () => true },
  );
  assert.deepEqual(found.hits.map((h) => h.key), ["4-archive/a/x.md", "2-areas/y.md"]);
  assert.deepEqual(Object.keys(found.evidence).sort(), ["2-areas/y.md", "4-archive/a/x.md"]);
});

test("a hit moving somewhere the caller may not see is dropped, and not counted", async () => {
  const store = storeWith([{ from: "1-projects/a", to: "private/a" }]);
  const found = await searchBothWays(
    store,
    async () => ({ hits: [hit("1-projects/a/x.md"), hit("2-areas/y.md")], matchCount: 2 }),
    { query: "line", scope: "team", isVisible: (path) => !path.startsWith("private/") },
  );
  assert.deepEqual(found.hits.map((h) => h.key), ["2-areas/y.md"]);
  assert.equal(found.matchCount, 1);
  assert.ok(!JSON.stringify(found).includes("1-projects/a/x.md"));
});

test("a note found at both names, the index behind and the copy landed, is listed once", async () => {
  const store = storeWith([{ from: "1-projects/a", to: "2-areas/a" }]);
  const found = await searchBothWays(
    store,
    async () => ({ hits: [hit("1-projects/a/x.md"), hit("2-areas/a/x.md")], matchCount: 2 }),
    { query: "line", scope: "private", isVisible: () => true },
  );
  assert.deepEqual(found.hits.map((h) => h.key), ["2-areas/a/x.md"]);
  assert.equal(found.matchCount, 1);
});

test("a folder search leaves out what is moving out of the folder", async () => {
  const store = storeWith([{ from: "1-projects/a", to: "2-areas/a" }]);
  const found = await searchBothWays(
    store,
    async () => ({ hits: [hit("1-projects/a/x.md"), hit("1-projects/b.md")], matchCount: 2 }),
    { query: "line", scope: "private", prefix: "1-projects/", isVisible: () => true },
  );
  assert.deepEqual(found.hits.map((h) => h.key), ["1-projects/b.md"]);
});

test("no pending moves answers exactly as before", () => {
  const found = { hits: [hit("a.md")], matchCount: 1, evidence: { "a.md": {} } };
  assert.equal(atTreeNames(found, [], { isVisible: () => true }), found);
});
