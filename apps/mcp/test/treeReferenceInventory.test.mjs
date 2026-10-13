/**
 * A move's link rewrite lists which notes exist from the Convex tree where
 * it serves (`tools/moves/references.js`, `tree/served.js`), phase 4 B2 of
 * `docs/decisions/app-and-console/convex-tree.md`: one request instead of a
 * walk of the bucket. The tree may not have heard of the move yet, so the
 * move's own renames are applied to what it lists.
 *
 * Sabotage-checked: listing the bucket in `noteInventory` fails the
 * no-bucket-walk check; dropping `withRenames` leaves the moved note's own
 * link pointing nowhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { R2Store } from "../src/store/r2.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { loadPrivacyState } from "../src/privacy/state.js";
import { rewriteReferences } from "../src/tools/moves/references.js";

test("a rewrite's note inventory comes from the tree, with the move applied", async () => {
  const raw = memoryBucket();
  // The bucket has moved the note; the tree still lists it at its old name.
  await raw.put("3-resources/plan.md", "# Plan\n\nSee [the brief](./brief.md).\n");
  await raw.put("1-projects/launch/brief.md", "# Brief\n");
  const listed = [];
  const list = raw.list.bind(raw);
  raw.list = async (options = {}) => {
    const prefix = options.prefix ?? "";
    if (!prefix.startsWith(".")) listed.push(prefix);
    return list(options);
  };
  const store = Object.create(new R2Store(raw));
  const asked = [];
  Object.defineProperty(store, "treeManifest", {
    value: async (request = {}) => {
      asked.push(request);
      return {
        served: true,
        entries: [{ path: "1-projects/launch/brief.md" }, { path: "1-projects/launch/plan.md" }],
        cursor: null,
      };
    },
    enumerable: false,
  });
  const state = await loadPrivacyState(store);
  listed.length = 0;
  const result = await rewriteReferences(
    store,
    "private",
    state.rules,
    state.overrides,
    new Map([["1-projects/launch/plan.md", "3-resources/plan.md"]]),
  );
  assert.ok(asked.length > 0, "the tree was asked");
  assert.deepEqual(listed, [], "no note listing of the bucket");
  assert.equal(result.notes, 1);
  const moved = await (await raw.get("3-resources/plan.md")).text();
  assert.match(moved, /\]\(\.\.\/1-projects\/launch\/brief\.md\)/);
});
