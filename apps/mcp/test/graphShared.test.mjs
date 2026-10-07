/**
 * Graph work on a shared gateway store (Phase 2 fix round 3). Every gateway
 * store is one withLogicalDelete instance per request, and its
 * extra-operation charge is store-wide: whoever installs it bills every
 * caller's wrapper reads while it is in place. Graph work therefore runs on
 * its own logical view of the same raw store, billed to the graph budget, and
 * neither installs nor inherits a charge on the shared one. Also: the audit
 * sizes its listing to the budget (marker reads are charged), and GC keeps
 * the ops that end a traversal.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts over this file,
 * graphGuards.test.mjs and graphCharged.test.mjs. RED first at f7f44780: the
 * write-then-search, markers liveness and scenario A tests.
 *
 *   graphView returns the shared store                                    1 (write path raw ops)
 *   graph view without its own charge                                     1 (write path raw ops)
 *   graph charge installed on the shared store                            2 (write-then-search, raw ops)
 *   maintainNow reconciles on the shared store                            1 (shared charge billed)
 *   audit list fixed at 100                                               1 (markers liveness)
 *   audit cursor reset on a budget-exhausted listing                      1 (keeps auditCursor)
 *   gcCursor cleared whether or not collect:null landed                   1 (retried on last page)
 *   no ops kept back for the end of a clean GC traversal                  1 (GC, 248 keys charged)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { reconcileGraph } from "../src/graph/reconcile.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey, nodeKey, pathHash } from "../src/graph/keys.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { BUDGET_EXHAUSTED } from "../src/search/budget.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { cursorPagedBucket, memoryBucket } from "./store/fixtures.mjs";

const now = 1_700_000_000_000;
const CAPS = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };

/** A paged R2-like bucket behind the real withLogicalDelete, as the gateway builds it. */
function gatewayStore() {
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  const paged = cursorPagedBucket(raw);
  return { raw, store: withLogicalDelete(paged) };
}

test("a write's graph hook never bills the write's own search indexing: the new note is indexed at every write budget", async () => {
  for (let budget = 1; budget <= 20; budget += 1) {
    const { raw, store } = gatewayStore();
    store.actor = { workspaceId: "w_shared", userId: "u_owner" };
    const deferred = [];
    store.defer = (p) => deferred.push(p);
    store.writeEnrichBudget = budget;
    for (let i = 0; i < 5; i += 1) await store.put(`n${i}.md`, `hello n${i}`);
    await maintainIndexAfter(store, createSearchBudget(600), defaultIsIndexable, null);
    await Promise.all(deferred.splice(0));
    const links = Array.from({ length: 20 }, (_, i) => `[t${i}](./t${i}.md)`).join(" ");
    await toolWriteNote(store, "private", [], new Map(), { path: "fresh.md", content: `zebra ${links}` });
    await Promise.all(deferred.splice(0));
    const index = [...raw.objects.keys()].filter((k) => k.startsWith(".context/search/")).map((k) => raw.objects.get(k).body).join("\n");
    assert.ok(index.includes("fresh.md"), `write budget ${budget}: fresh.md missing from the search index`);
  }
});

test("maintenance runs the graph pass on its own view: a charge left on the shared store never bills graph work", async () => {
  const raw = memoryBucket();
  raw.capabilities = CAPS;
  // Which physical key the wrapper is about to touch when it bills a charge.
  let lastKey = "";
  for (const m of ["get", "put", "list"]) {
    const inner = raw[m].bind(raw);
    raw[m] = (k, ...rest) => {
      lastKey = typeof k === "string" ? k : k?.prefix ?? "";
      return inner(k, ...rest);
    };
  }
  const shared = withLogicalDelete(cursorPagedBucket(raw));
  const deferred = [];
  shared.defer = (p) => deferred.push(p);
  for (let i = 0; i < 5; i += 1) await shared.put(`n${i}.md`, `[t](./t.md) n${i}`);
  // A charge left on the shared store, as visibleNotes.js leaves its own.
  let billedGraph = 0;
  shared.setExtraOperationCharge(() => {
    if (lastKey.startsWith(".context/graph/")) billedGraph += 1;
  });
  for (let i = 0; i < 4; i += 1) {
    await maintainIndexAfter(shared, createSearchBudget(600), defaultIsIndexable, null);
    await Promise.all(deferred.splice(0));
  }
  assert.ok(raw.objects.has(graphManifestKey()), "the graph pass ran");
  assert.equal(billedGraph, 0, "graph wrapper reads were billed by the shared store's charge");
});

/** One reconcile pass with the outer search charge installed exactly as visibleNotes.js leaves it. */
async function searchPass(store, census, B) {
  const budget = createSearchBudget(B);
  store.setExtraOperationCharge(() => {
    if (budget.take(0)) return;
    const error = new Error("search budget exhausted");
    error[BUDGET_EXHAUSTED] = true;
    throw error;
  });
  try {
    await reconcileGraph(store, budget, { census, censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });
  } catch (error) {
    if (!error?.[BUDGET_EXHAUSTED]) throw error;
  }
  return budget;
}
const censusOf = (raw, live) => new Map([...live].map((p) => [p, raw.objects.get(p).etag]));
const rawCursor = (raw, gen = "1") => raw.objects.get(maintenanceCursorKey(gen))?.body ?? null;

test("markers liveness: 150 deleted notes' nodes are removed and the cursor never freezes, on a conditional paged store behind the real wrapper", async () => {
  // Measured (checked every 10 passes): all gone by about 890 passes at B=30
  // and 300 at B=60. B=15 does not converge, before or after this round: see
  // phase-2-final-fix-r3-report.md (a removal mid-page after earlier entries
  // became markers costs more than one pass; not patched, per the stop rule).
  for (const [B, MAX] of [[30, 1100], [60, 450]]) {
    const { raw, store } = gatewayStore();
    const live = new Set();
    for (let i = 0; i < 300; i += 1) {
      await store.put(`n${i}.md`, "[t](./t.md)");
      live.add(`n${i}.md`);
    }
    for (let i = 0; i < 20; i += 1) await searchPass(store, censusOf(raw, live), 100000);
    for (let i = 0; i < 300; i += 2) {
      await store.delete(`n${i}.md`);
      live.delete(`n${i}.md`);
    }
    const gone = async () => {
      for (let i = 0; i < 300; i += 2) if (await store.get(nodeKey("1", await pathHash(`n${i}.md`)))) return false;
      return true;
    };
    let at = null;
    for (let p = 1; p <= MAX && at === null; p += 1) {
      const before = rawCursor(raw);
      const budget = await searchPass(store, censusOf(raw, live), B);
      assert.ok(budget.spent <= B, `B=${B} pass ${p}: spent ${budget.spent}`);
      assert.notEqual(rawCursor(raw), before, `B=${B} pass ${p}: cursor frozen`);
      if (p % 10 === 0 && (await gone())) at = p;
    }
    assert.ok(at !== null, `B=${B}: deleted nodes still visible after ${MAX} passes`);
  }
});

test("markers scenario A: collect over 300 junk keys clears at B=30", async () => {
  const { raw, store } = gatewayStore();
  await store.put("a.md", "[t](./t.md)");
  await store.put("t.md", "x");
  const live = new Set(["a.md", "t.md"]);
  for (let i = 0; i < 40; i += 1) await searchPass(store, censusOf(raw, live), 200);
  for (let i = 0; i < 300; i += 1) await raw.put(`${generationPrefix("9")}nodes/${i.toString(16).padStart(64, "0")}.json`, "{}");
  const manifest = JSON.parse(raw.objects.get(graphManifestKey()).body);
  await raw.put(graphManifestKey(), JSON.stringify({ ...manifest, collect: "9" }));
  let at = null;
  for (let p = 1; p <= 400 && at === null; p += 1) {
    await searchPass(store, censusOf(raw, live), 30);
    if (JSON.parse(raw.objects.get(graphManifestKey()).body).collect === null) at = p;
  }
  assert.ok(at !== null, "collect never cleared at B=30");
});
