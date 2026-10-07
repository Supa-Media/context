/**
 * Graph liveness on gateway stores: every store is wrapped by withLogicalDelete,
 * and search maintenance installs the visibleNotes.js charge, so the wrapper's
 * read before an unconditional or absent put (and before any delete) is billed
 * to the same budget. Those puts must fit inside the wrap reserve, or the
 * cursor never lands and the turn cycle freezes (Phase 2 fix round 2).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. RED first: the best-effort and
 * conditional tests both failed at 410fc610 (turn frozen at B=11 pass 3; the
 * absent cursor put threw at pass 1).
 *
 *   writeHeadroom always 0                                                3
 *   wrap reserve without any headroom                                     3
 *   wrap reserve without the cursor's headroom                            3
 *   publishHealth put takes no headroom                                   1 (best-effort)
 *   projectNote keep-back without the final write's headroom              1 (floors)
 *   posting pre-check counts pages, not pages plus wrapper reads          1 (floors)
 *   graphPassFloor ignores the logical best-effort floor                  1 (floors)
 *
 * Results (measured): on a charged best-effort logical-delete store a
 * one-link note first converges at B=15 (it was 11 before, but the cursor
 * then froze once ready); the audit restores a dropped membership from B=13
 * and GC empties the collected generation at every B from 11; conditional
 * stays at GRAPH_PASS_FLOOR (11).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { readPostings } from "../src/graph/postings.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { BUDGET_EXHAUSTED } from "../src/search/budget.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { GRAPH_PASS_FLOOR, GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT, graphPassFloor } from "../src/search/pacing.js";
import { memoryBucket } from "./store/fixtures.mjs";

const now = 1_700_000_000_000;
const N = 6;
const census = (b) => {
  const c = new Map();
  for (const [k, { etag }] of b.objects) if (defaultIsIndexable(k)) c.set(k, etag);
  return c;
};

/** One pass with the search budget's charge installed exactly as visibleNotes.js does. */
async function chargedPass(store, b, B) {
  const budget = createSearchBudget(B);
  const restore = store.setExtraOperationCharge(() => {
    if (budget.take(0)) return;
    const error = new Error("search budget exhausted");
    error[BUDGET_EXHAUSTED] = true;
    throw error;
  });
  try {
    await reconcileGraph(store, budget, { census: census(b), censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });
  } finally {
    restore();
  }
  return budget;
}

const rawCursor = (b) => {
  const body = b.objects.get(maintenanceCursorKey("1"))?.body;
  return body ? JSON.parse(body) : null;
};

/**
 * A best-effort bucket (no conditional write or create, physical
 * conditionalDelete) behind the real withLogicalDelete: N notes link t.md,
 * converged to ready; then `collect` names a junk generation 9 and t.md's
 * incoming head page is dropped.
 */
async function bestEffortCell() {
  const b = memoryBucket();
  b.capabilities = { conditionalDelete: true };
  const store = withLogicalDelete(b);
  await b.put("t.md", "x");
  for (let i = 0; i < N; i += 1) await b.put(`n${i}.md`, "[t](./t.md)");
  for (let i = 0; i < 10; i += 1) await chargedPass(store, b, 100000);
  const manifest = JSON.parse(b.objects.get(graphManifestKey()).body);
  assert.equal(manifest.health.state, "ready");
  const junk = generationPrefix("9");
  for (let i = 0; i < 30; i += 1) await b.put(`${junk}j${i}.json`, "{}");
  await b.put(graphManifestKey(), JSON.stringify({ ...manifest, collect: "9" }));
  const hash = await pathHash("t.md");
  b.objects.delete(postingPageKey("1", "incoming", hash, 0));
  const gcDone = () => ![...b.objects.keys()].some((k) => k.startsWith(junk));
  const restored = async () =>
    (await readPostings(b, createSearchBudget(100000), { gen: "1", family: "incoming", hash, canSee: () => true, validate: () => true })).entries.length >= N;
  return { b, store, gcDone, restored };
}

test("best-effort behind withLogicalDelete with the search charge: the cursor lands every pass and GC and audit turns run", async () => {
  for (const B of [11, 12, 13, 14, 15, 17, 20]) {
    const cell = await bestEffortCell();
    let gcAt = null;
    let auditAt = null;
    for (let p = 1; p <= 200; p += 1) {
      const before = rawCursor(cell.b);
      const budget = await chargedPass(cell.store, cell.b, B);
      assert.ok(budget.spent <= B, `B=${B} pass ${p}: spent ${budget.spent}`);
      const after = rawCursor(cell.b);
      assert.ok(after, `B=${B} pass ${p}: no cursor`);
      assert.equal(after.turn, (before.turn + 1) % 4, `B=${B} pass ${p}: turn did not advance (cursor not written)`);
      if (gcAt === null && cell.gcDone()) gcAt = p;
      if (auditAt === null && (await cell.restored())) auditAt = p;
    }
    assert.ok(gcAt !== null, `B=${B}: GC never emptied the collected generation`);
    // Below 13 the pass leaves the audit 3 or 4 ops (B less the manifest and
    // cursor reads and the 6-op best-effort wrap reserve), under its smallest
    // unit here: list, node read, page read, page put with its wrapper read.
    // maintainNow does not run the graph there on such a store (floor 15).
    if (B >= 13) assert.ok(auditAt !== null, `B=${B}: the audit never restored the dropped membership`);
  }
});

test("conditional behind withLogicalDelete with the search charge at B=11: a generation's first (absent) cursor put does not throw", async () => {
  // Generation 3 serving with no cursor yet and its predecessor's predecessor
  // to collect, so GC spends the pass down to the wrap reserve and the wrap
  // then needs the absent cursor put (the wrapper reads before it).
  const b = memoryBucket();
  b.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
  const store = withLogicalDelete(b);
  await chargedPass(store, b, 100); // creates the manifest at generation 1
  const manifest = JSON.parse(b.objects.get(graphManifestKey()).body);
  await b.put(graphManifestKey(), JSON.stringify({ ...manifest, generation: "3", previous: "2", collect: "1" }));
  for (let i = 0; i < 50; i += 1) await b.put(`${generationPrefix("1")}nodes/${String(i).padStart(64, "0")}.json`, "{}");
  const cursor3 = () => b.objects.get(maintenanceCursorKey("3"))?.body;
  assert.equal(cursor3(), undefined);
  for (let p = 1; p <= 5; p += 1) {
    const before = cursor3();
    await assert.doesNotReject(chargedPass(store, b, 11), `pass ${p}`);
    assert.ok(cursor3() !== undefined && cursor3() !== before, `pass ${p}: cursor not written`);
  }
});

/** Passes until a one-link note's graph is ready, or null after `max`. */
async function oneLinkReady(caps, B, max) {
  const b = memoryBucket();
  b.capabilities = caps;
  const store = withLogicalDelete(b);
  await b.put("a.md", "[t](./t.md)");
  for (let p = 1; p <= max; p += 1) {
    await chargedPass(store, b, B);
    const m = b.objects.get(graphManifestKey());
    if (m && JSON.parse(m.body).health.state === "ready") return p;
  }
  return null;
}

test("floors on charged logical-delete stores: best-effort converges at GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT and not one below; conditional keeps GRAPH_PASS_FLOOR", async () => {
  assert.equal(GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT, 15);
  const bestEffort = { conditionalDelete: true };
  assert.ok((await oneLinkReady(bestEffort, GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT, 10)) !== null);
  assert.equal(await oneLinkReady(bestEffort, GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT - 1, 40), null);
  const conditional = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
  assert.ok((await oneLinkReady(conditional, GRAPH_PASS_FLOOR, 10)) !== null);
  // maintainNow asks graphPassFloor: only a best-effort logical-delete store gets the higher floor.
  const wrapped = (caps) => withLogicalDelete(Object.assign(memoryBucket(), { capabilities: caps }));
  assert.equal(graphPassFloor(wrapped(bestEffort)), GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT);
  assert.equal(graphPassFloor(wrapped(conditional)), GRAPH_PASS_FLOOR);
  assert.equal(graphPassFloor(Object.assign(memoryBucket(), { capabilities: bestEffort })), GRAPH_PASS_FLOOR);
});
