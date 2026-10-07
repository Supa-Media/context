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
 *   graphPassFloor ignores the logical floors (back to 11 and 15)          3 (floors, markers, skip)
 *
 * Results (measured): on a charged best-effort logical-delete store a
 * one-link note first converges at B=15 (it was 11 before, but the cursor
 * then froze once ready); the audit restores a dropped membership from B=13
 * and GC empties the collected generation at every B from 11; conditional
 * converges a one-link note at GRAPH_PASS_FLOOR (11). The pass floors on these
 * stores are higher (18 best-effort, 26 conditional): the deleted-note markers
 * scenario plateaus below them (search/pacing.js has the measured cells).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { readPostings } from "../src/graph/postings.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey, nodeKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { BUDGET_EXHAUSTED } from "../src/search/budget.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { GRAPH_PASS_FLOOR, GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT, GRAPH_PASS_FLOOR_LOGICAL_CONDITIONAL, graphPassFloor } from "../src/search/pacing.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { cursorPagedBucket, memoryBucket } from "./store/fixtures.mjs";

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

test("one-link floors on charged logical-delete stores: best-effort converges at 15 and not one below; conditional at GRAPH_PASS_FLOOR", async () => {
  const bestEffort = { conditionalDelete: true };
  assert.ok((await oneLinkReady(bestEffort, 15, 10)) !== null);
  assert.equal(await oneLinkReady(bestEffort, 14, 40), null);
  const conditional = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
  assert.ok((await oneLinkReady(conditional, GRAPH_PASS_FLOOR, 10)) !== null);
  // maintainNow asks graphPassFloor: logical-delete stores take the markers floors, others 11.
  assert.equal(GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT, 18);
  assert.equal(GRAPH_PASS_FLOOR_LOGICAL_CONDITIONAL, 26);
  const wrapped = (caps) => withLogicalDelete(Object.assign(memoryBucket(), { capabilities: caps }));
  assert.equal(graphPassFloor(wrapped(bestEffort)), GRAPH_PASS_FLOOR_LOGICAL_BEST_EFFORT);
  assert.equal(graphPassFloor(wrapped(conditional)), GRAPH_PASS_FLOOR_LOGICAL_CONDITIONAL);
  assert.equal(graphPassFloor(Object.assign(memoryBucket(), { capabilities: bestEffort })), GRAPH_PASS_FLOOR);
});

const CONDITIONAL = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
const BEST_EFFORT = { conditionalWrite: false, conditionalCreate: false, conditionalDelete: false };

/** A cursor-paged bucket behind the real withLogicalDelete, as the gateway builds it. */
function pagedGateway(caps) {
  const raw = memoryBucket();
  raw.capabilities = caps;
  const paged = cursorPagedBucket(raw);
  paged.objects = raw.objects;
  return { raw, paged, store: withLogicalDelete(paged) };
}

/** Logical census, as the sync would hand it over (deleted notes absent). */
async function logicalCensus(store, raw) {
  const c = new Map();
  for (const [k] of raw.objects) {
    if (!defaultIsIndexable(k)) continue;
    const got = await store.get(k);
    if (got) c.set(k, got.etag);
  }
  return c;
}

/**
 * Deleted notes whose node is neither gone nor a terminal tombstone. Both arms
 * count: the wrapper exposes conditionalDelete, so a conditional store deletes
 * the node; a best-effort one leaves an excluded tombstone with no repair.
 */
async function unremoved(store, keys) {
  let left = 0;
  for (const k of keys) {
    const got = await store.get(k);
    if (!got) continue;
    const n = JSON.parse(await got.text());
    if (!(n.coverage === "excluded" && Array.isArray(n.reverseRepair) && n.reverseRepair.length === 0)) left += 1;
  }
  return left;
}

// Measured worst at the floor: 840 (conditional at 26), 1,238 (best-effort at 18).
const MARKERS_BOUND = { conditional: 1200, "best-effort": 1600 };

test("markers scenario: at the logical-delete floor, 150 deleted of 300 notes are all removed within the stated bound", async () => {
  for (const [mode, caps] of [["conditional", CONDITIONAL], ["best-effort", BEST_EFFORT]]) {
    const { raw, store } = pagedGateway(caps);
    const B = graphPassFloor(store);
    const pass = async (budget) => {
      const restoreCensus = await logicalCensus(store, raw);
      const b = createSearchBudget(budget);
      const restore = store.setExtraOperationCharge(() => {
        if (b.take(0)) return;
        const error = new Error("search budget exhausted");
        error[BUDGET_EXHAUSTED] = true;
        throw error;
      });
      try {
        await reconcileGraph(store, b, { census: restoreCensus, censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });
      } finally {
        restore();
      }
    };
    for (let i = 0; i < 300; i += 1) await store.put(`n${i}.md`, "[t](./t.md)");
    for (let i = 0; i < 40; i += 1) await pass(100000);
    const keys = [];
    for (let i = 0; i < 300; i += 2) {
      keys.push(nodeKey("1", await pathHash(`n${i}.md`)));
      await store.delete(`n${i}.md`);
    }
    assert.equal(await unremoved(store, keys), 150, `${mode}: built before the deletes`);
    let done = null;
    for (let p = 1; p <= MARKERS_BOUND[mode]; p += 1) {
      await pass(B);
      if (p % 50 === 0 && (await unremoved(store, keys)) === 0) {
        done = p;
        break;
      }
    }
    assert.ok(done !== null, `${mode} at B=${B}: ${await unremoved(store, keys)} deleted notes still in the graph after ${MARKERS_BOUND[mode]} passes`);
  }
});

test("maintainNow on a logical-delete store: below its floor the graph pass is skipped and the manifest is not written", async () => {
  for (const caps of [CONDITIONAL, BEST_EFFORT]) {
    const skippedBetween = [];
    for (let total = 14; total <= 70; total += 1) {
      const { raw, paged, store } = pagedGateway(caps);
      const deferred = [];
      store.defer = (p) => deferred.push(p);
      for (let i = 0; i < 5; i += 1) await store.put(`n${i}.md`, `[t](./t.md) n${i}`);
      for (let i = 0; i < 4; i += 1) {
        await maintainIndexAfter(store, createSearchBudget(600), defaultIsIndexable, null);
        await Promise.all(deferred.splice(0));
      }
      await store.delete("n0.md");
      const manifestBefore = raw.objects.get(graphManifestKey())?.body;
      assert.ok(manifestBefore, "graph built");
      let graphOps = 0;
      for (const m of ["get", "put", "delete", "list"]) {
        const inner = paged[m].bind(paged);
        paged[m] = (k, ...rest) => {
          const key = typeof k === "string" ? k : (k?.prefix ?? "");
          if (key.startsWith(".context/graph/")) graphOps += 1;
          return inner(k, ...rest);
        };
      }
      const budget = createSearchBudget(total);
      await maintainIndexAfter(store, budget, defaultIsIndexable, null);
      await Promise.all(deferred.splice(0));
      if (graphOps > 0) continue;
      // The brief expected health "behind" here; the pass does not run, so the
      // manifest (and the health it carries) stays as last published.
      assert.ok(budget.remaining < graphPassFloor(store), `total ${total}: skipped with ${budget.remaining} left`);
      assert.equal(raw.objects.get(graphManifestKey())?.body, manifestBefore);
      if (budget.remaining >= GRAPH_PASS_FLOOR) skippedBetween.push(budget.remaining);
    }
    assert.ok(skippedBetween.length > 0, `${caps.conditionalWrite ? "conditional" : "best-effort"}: no skip observed between the old and new floor`);
  }
});
