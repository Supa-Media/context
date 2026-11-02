/**
 * A check-in's listing of what changed (`src/agent/lookTree.js`): it waits
 * longer than an interactive tool, asks twice, and says why it could not list
 * as a code the texting Worker logs (2026-10-28: a large tree built from
 * parents passed the 6 second wait at most check-ins, and each read nothing,
 * with nothing in any log to say why).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `lookTreeEntries` reusing one listing for both tries: "a slow first page
 *    is asked again" fails (the first refusal is remembered).
 * 2. `servedListingStore` dropping its `timeoutMs`: "a check-in waits longer
 *    than a tool" fails.
 * 3. `lookChangedEntries` walking the whole tree first: "a look asks only for
 *    what changed" fails on the requests made.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LOOK_TREE_TIMEOUT_MS, LOOK_TREE_TRIES, lookChangedEntries, lookTreeEntries } from "../src/agent/lookTree.js";
import { servedListingStore, TreeUnavailable } from "../src/tree/served.js";
import { ControlPlaneError } from "../src/controlPlane/client.js";

/** A store whose tree answers from `answers` in turn, recording the options each request carried. */
function treeStore(answers) {
  const asked = [];
  const store = {};
  store.treeManifest = async (page, options) => {
    asked.push({ page, options });
    const next = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { store, asked };
}

const SERVED = { served: true, entries: [{ path: "notes/a.md", etag: "e1", updatedAt: 1 }], cursor: null };

test("a check-in waits longer than a tool for the tree", async () => {
  const { store, asked } = treeStore([SERVED]);
  const listed = await lookTreeEntries(store);
  assert.deepEqual(listed.entries.map((entry) => entry.key), ["notes/a.md"]);
  assert.equal(asked[0].options.timeoutMs, LOOK_TREE_TIMEOUT_MS);
  assert.ok(LOOK_TREE_TIMEOUT_MS > 6_000);
  // A tool's own listing passes no wait of its own: the control plane client's 6 seconds hold.
  const tool = treeStore([SERVED]);
  await servedListingStore(tool.store).treeEntries();
  assert.equal(tool.asked[0].options, undefined);
});

test("a slow first page is asked again, and the second answer is the look's", async () => {
  const { store, asked } = treeStore([new ControlPlaneError("timed out"), SERVED]);
  const listed = await lookTreeEntries(store);
  assert.equal(asked.length, 2);
  assert.equal(listed.tries, 2);
  assert.deepEqual(listed.entries.map((entry) => entry.key), ["notes/a.md"]);
});

test("a tree that cannot be listed says why as a code, after every try", async () => {
  const slow = treeStore([new ControlPlaneError("timed out")]);
  assert.deepEqual(await lookTreeEntries(slow.store), { code: "timed_out", tries: LOOK_TREE_TRIES });
  assert.equal(slow.asked.length, LOOK_TREE_TRIES);
  assert.deepEqual(await lookTreeEntries(treeStore([{ served: false }]).store), { code: "not_served", tries: LOOK_TREE_TRIES });
  assert.deepEqual(await lookTreeEntries(treeStore([new ControlPlaneError("request failed")]).store), {
    code: "failed",
    tries: LOOK_TREE_TRIES,
  });
  assert.deepEqual(await lookTreeEntries(treeStore([{ served: true, entries: [], cursor: "same" }]).store), {
    code: "endless",
    tries: LOOK_TREE_TRIES,
  });
  // No control plane at all is refused, never listed from the bucket.
  assert.equal((await lookTreeEntries({ list: async () => assert.fail("listed the bucket") })).code, "unreachable");
});

test("every refusal is still the one TreeUnavailable a tool tells the agent about", async () => {
  const { store } = treeStore([new ControlPlaneError("timed out")]);
  await assert.rejects(servedListingStore(store).treeEntries(), (error) => error instanceof TreeUnavailable && error.code === "timed_out");
});

test("a look asks only for what changed, and walks nothing else when the index answers", async () => {
  const { store, asked } = treeStore([SERVED]);
  const listed = await lookChangedEntries(store, 1_000);
  assert.equal(listed.changedOnly, true);
  assert.deepEqual(listed.entries.map((entry) => entry.key), ["notes/a.md"]);
  assert.deepEqual(asked.map((request) => request.page), [{ changedSince: 1_000 }]);
  assert.equal(asked[0].options.timeoutMs, LOOK_TREE_TIMEOUT_MS);
});

test("when the index will not answer, a look walks the whole tree as before", async () => {
  for (const first of [{ served: false }, new ControlPlaneError("timed out"), { served: true, entries: [], cursor: "more" }]) {
    const { store, asked } = treeStore([first, SERVED]);
    const listed = await lookChangedEntries(store, 1_000);
    assert.equal(listed.changedOnly, undefined);
    assert.deepEqual(listed.entries.map((entry) => entry.key), ["notes/a.md"]);
    assert.deepEqual(asked.map((request) => request.page), [{ changedSince: 1_000 }, {}]);
  }
  // A store with no control plane is still refused, never listed from the bucket.
  assert.equal((await lookChangedEntries({ list: async () => assert.fail("listed the bucket") }, 1_000)).code, "unreachable");
});
