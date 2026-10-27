/**
 * A meeting's claimed note path is checked for a free name against the Convex
 * tree, never by opening the bucket (owner, 2026-10-14: "names, existence
 * checks and front matter come only from the Convex tree; storage is read only
 * to open a note's body"). `unclaimedNotePath` (`src/meetings/ingest.js`) is
 * the claim that finalize makes; it used to `store.get` the candidate, which
 * is an existence check against the bucket.
 *
 * The bucket below counts every GET **by key**, so "the claim never opened the
 * candidate" is a number. The tree is a fake that answers names from an
 * explicit set, so the bucket and the tree can disagree on purpose.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `unclaimedNotePath` back to `if (!(await store.get(candidate)))`: all
 *    three checks fail. The name the tree holds is GET from the bucket, and
 *    the bucket-only object blocks the name it should not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { R2Store, createBucket } from "./searchShards/fixtures.mjs";
import { unclaimedNotePath } from "../src/meetings/notes.js";
import { TreeUnavailable } from "../src/tree/served.js";

const CANDIDATE = "0-inbox/meetings/2026-10-05-weekly-sync-mtg-abc.md";
const NOTE_BODY = "---\nmeeting-id: mtg_claim_a\n---\n# Weekly sync\n\nThe discussion.\n";

/**
 * A store whose bucket holds `objects` and whose control plane names exactly
 * `treeNames` (files) — the two are set independently, as they are in life
 * while the tree catches up with the bucket.
 */
function claimStore({ objects = {}, treeNames = [], treeServed = true } = {}) {
  const bucket = createBucket();
  for (const [key, body] of Object.entries(objects)) bucket.seed(key, body);
  const store = new R2Store(bucket);
  Object.defineProperty(store, "treeFacts", {
    configurable: true,
    value: async (request) => {
      assert.equal(request.ask, "names", "the claim asks the tree for names only");
      if (!treeServed) return { served: false };
      const names = new Set(treeNames);
      return { served: true, files: request.paths.filter((path) => names.has(path)), folders: [] };
    },
  });
  return { store, bucket };
}

/** The GETs spent on `keys`, which must be none. */
function getsOf(bucket, keys) {
  return bucket.counts.gets.filter((key) => keys.includes(key));
}

test("a name the tree holds is skipped, and the candidate is never opened", async () => {
  const { store, bucket } = claimStore({
    objects: { [CANDIDATE]: NOTE_BODY },
    treeNames: [CANDIDATE],
  });

  const claimed = await unclaimedNotePath(store, CANDIDATE);
  assert.notEqual(claimed, CANDIDATE, "a taken name is not handed out again");
  assert.match(claimed, /^0-inbox\/meetings\/2026-10-05-weekly-sync-mtg-abc-[0-9a-f]{8}\.md$/);
  assert.deepEqual(getsOf(bucket, [CANDIDATE]), [], "the taken candidate was not GET from the bucket");
});

test("an object the bucket holds but the tree does not name does not block the name", async () => {
  // Storage-only: an object no tree row describes. The tree is the truth for
  // names, so this name is free.
  const { store, bucket } = claimStore({
    objects: { [CANDIDATE]: NOTE_BODY },
    treeNames: [],
  });

  assert.equal(await unclaimedNotePath(store, CANDIDATE), CANDIDATE);
  assert.deepEqual(getsOf(bucket, [CANDIDATE]), [], "the bucket-only object was not opened to decide");
});

test("a tree that does not serve names fails the claim, and reads nothing from the bucket", async () => {
  const { store, bucket } = claimStore({
    objects: { [CANDIDATE]: NOTE_BODY },
    treeServed: false,
  });

  await assert.rejects(unclaimedNotePath(store, CANDIDATE), (error) => error instanceof TreeUnavailable);
  assert.deepEqual(getsOf(bucket, [CANDIDATE]), [], "no bucket GET stands in for the tree");
});
