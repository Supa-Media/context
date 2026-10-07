/**
 * Phase 2 final review guards: the graph kill switch, the GC list cursor on
 * logical-delete stores, health on a manifest from newer code, the write
 * path's wrapper-probe charge, and byte caps before any record is read or
 * parsed.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file unless noted.
 *
 *   kill switch removed from maintainNow                                  1 (kill switch)
 *   GC list ignores its cursor                                            1 (GC)
 *   GC deletes keep no headroom for the marker write                      1 (GC: cursor not written)
 *   GC clears on a truncated page with no cursor                          1 (no cursor)
 *   GC clears collect without the confirming traversal                    0 here (key cursors skip
 *                                                                           nothing); 3 in graphRebuild
 *                                                                           (offset-paged physical deletes)
 *   graphHealth ignores isNewer                                           1 (health)
 *   write path charge not installed                                       1 (write path)
 *   write path charge not restored                                        1 (write path)
 *   recordText size check removed                                         2 (recordText, caps)
 *   recordText text cap removed                                           2 (recordText, caps)
 *   readCursor, auditNode or the manifest read back to text()             1 each (caps)
 *   size pre-check without RECORD_STORAGE_OVERHEAD (fix round 2)          1 (overhead; RED first)
 *
 * Process note: tests written first; RED was all six (recordText stubbed to
 * text() so the file loaded).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphHealth, initGraphManifest, publishHealth, readGraphManifest } from "../src/graph/manifest.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey } from "../src/graph/keys.js";
import { GRAPH_RECORD_BYTE_CAP, RECORD_STORAGE_OVERHEAD, recordText } from "../src/graph/records.js";
import { withManagedEncryption } from "../src/store/managedEncryption.js";
import { stampGeneration } from "../src/store/generationStamp.js";
import { PARSER_VERSION, RESOLVER_VERSION } from "../src/graph/facts.js";
import { URL_KEY_VERSION } from "../src/graph/urlKey.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";
import { BUDGET_EXHAUSTED } from "../src/search/budget.js";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { cursorPagedBucket, memoryBucket } from "./store/fixtures.mjs";

const now = 1_700_000_000_000;
const CAPS = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
const links = (n) => Array.from({ length: n }, (_, i) => `[t${i}](./t${i}.md)`).join(" ");
const isGraph = (k) => typeof k === "string" && k.startsWith(GRAPH_PREFIX);
const census = (b) => {
  const c = new Map();
  for (const [k, { etag }] of b.objects) if (defaultIsIndexable(k)) c.set(k, etag);
  return c;
};
const pass = (store, b, budget) =>
  reconcileGraph(store, budget, { census: census(b), censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });

/** The search budget's charge for wrapper probes, exactly as visibleNotes.js installs it. */
const chargeTo = (budget) => () => {
  if (budget.take(0)) return;
  const error = new Error("search budget exhausted");
  error[BUDGET_EXHAUSTED] = true;
  throw error;
};

// 1. Kill switch

/** A gateway-like store with waitUntil, counting every graph op. */
function gatewayStore(writeEnrichBudget) {
  const b = memoryBucket();
  const s = { b, graphOps: 0, deferred: [] };
  const t = (k) => {
    if (isGraph(k)) s.graphOps += 1;
  };
  s.store = {
    capabilities: CAPS,
    actor: { workspaceId: "w_guards", userId: "u_owner" },
    get: async (k) => (t(k), b.get(k)),
    put: async (k, v, o) => (t(k), b.put(k, v, o)),
    delete: async (k, o) => (t(k), b.delete(k, o)),
    async list(o = {}) {
      t(o.prefix);
      const page = await b.list(o);
      return { ...page, objects: page.objects.map((x) => ({ ...x, etag: b.objects.get(x.key)?.etag })) };
    },
    defer: (p) => s.deferred.push(p),
  };
  if (writeEnrichBudget !== undefined) s.store.writeEnrichBudget = writeEnrichBudget;
  s.write = async (path, content) => {
    await toolWriteNote(s.store, "private", [], new Map(), { path, content });
    await Promise.all(s.deferred.splice(0));
  };
  s.maintain = async () => {
    await maintainIndexAfter(s.store, createSearchBudget(600), defaultIsIndexable, null);
    await Promise.all(s.deferred.splice(0));
  };
  return s;
}

async function driveGateway(writeEnrichBudget) {
  const s = gatewayStore(writeEnrichBudget);
  await s.write("a.md", "see [b](./b.md) and [[c]]");
  for (let i = 0; i < 3; i += 1) await s.maintain();
  await s.write("d.md", "links [a](./a.md) [b](./b.md) https://example.com/x");
  await s.b.put("f.md", "new [a](./a.md)");
  for (let i = 0; i < 3; i += 1) await s.maintain();
  return s;
}

test("kill switch: WRITE_ENRICH budget 0 makes zero graph store ops across writes and deferred passes", async () => {
  const off = await driveGateway(0);
  assert.equal(off.graphOps, 0);
  assert.deepEqual([...off.b.objects.keys()].filter(isGraph), []);
  assert.ok([...off.b.objects.keys()].some((k) => k.startsWith(".context/search/")), "search maintenance still ran");
  for (const budget of [undefined, 80]) {
    const on = await driveGateway(budget);
    assert.ok(on.graphOps > 0, `budget ${budget}: graph work runs`);
    assert.ok(on.b.objects.has(graphManifestKey()), `budget ${budget}: manifest created`);
  }
});

// 2. GC list cursor on logical-delete stores

/**
 * Generation 3 serving, `collect` naming 1, and `keys` objects under g/1/, on
 * a cursor-paged bucket wrapped with the real withLogicalDelete (as every
 * gateway store is). `raw` counts physical calls.
 */
async function wrappedCollecting(keys) {
  const b = memoryBucket();
  b.capabilities = CAPS;
  const paged = cursorPagedBucket(b);
  const counter = { raw: 0 };
  const counted = {
    capabilities: CAPS,
    get: (k) => ((counter.raw += 1), paged.get(k)),
    put: (k, v, o) => ((counter.raw += 1), paged.put(k, v, o)),
    delete: (k, o) => ((counter.raw += 1), paged.delete(k, o)),
    list: (o) => ((counter.raw += 1), paged.list(o)),
  };
  const store = withLogicalDelete(counted);
  assert.equal(store.capabilities.conditionalDelete, true);
  const prefix = generationPrefix("1");
  for (let i = 0; i < keys; i += 1) await b.put(`${prefix}nodes/${i.toString(16).padStart(64, "0")}.json`, "{}");
  await initGraphManifest(store, createSearchBudget(100), { mode: "conditional", now });
  let { manifest, etag } = await readGraphManifest(store, createSearchBudget(100));
  assert.ok(await publishHealth(store, createSearchBudget(100), manifest, etag, { generation: "3", previous: "2" }));
  // Generation 3 has been reconciled before its predecessor's GC: its cursor exists.
  await pass(store, b, createSearchBudget(100));
  ({ manifest, etag } = await readGraphManifest(store, createSearchBudget(100)));
  assert.ok(await publishHealth(store, createSearchBudget(100), manifest, etag, { collect: "1" }));
  const visible = async () => {
    let n = 0;
    let cursor;
    do {
      const page = await store.list({ prefix, cursor, limit: 1000 });
      n += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return n;
  };
  const collect = async () => JSON.parse(b.objects.get(graphManifestKey()).body).collect;
  return { b, store, counter, visible, collect };
}

/** Passes at budget B until g/1/ lists empty and collect is cleared; the pass count or null. */
async function gcPasses(env, B, max, { charge = false } = {}) {
  const gcCursor = () => JSON.parse(env.b.objects.get(maintenanceCursorKey("3"))?.body ?? "{}").gcCursor;
  for (let p = 1; p <= max; p += 1) {
    const gcBefore = gcCursor();
    const budget = createSearchBudget(B);
    const restore = charge ? env.store.setExtraOperationCharge(chargeTo(budget)) : () => {};
    const before = env.counter.raw;
    const cursorBefore = env.b.objects.get(maintenanceCursorKey("3"))?.body;
    try {
      await pass(env.store, env.b, budget);
    } finally {
      restore();
    }
    assert.ok(budget.spent <= B, `spent ${budget.spent} > ${B}`);
    if (charge) assert.ok(env.counter.raw - before <= B, `pass ${p}: ${env.counter.raw - before} raw ops > ${B}`);
    // The turn advances every pass, so the cursor is written every pass: GC
    // deletes never eat the wrap reserve, even with each marker write charged.
    assert.notEqual(env.b.objects.get(maintenanceCursorKey("3"))?.body, cursorBefore, `pass ${p}: cursor not written`);
    if ((await env.collect()) === null) {
      assert.equal(await env.visible(), 0, "collect cleared only once g/1/ lists empty");
      return p;
    }
    // A page of a traversal that has found nothing deletes nothing, so it
    // completes in one pass; a repeated one is a publish that did not fit at
    // the end of a clean traversal (fix round 3).
    if (gcBefore && JSON.parse(gcBefore)[2] === false) assert.notEqual(gcCursor(), gcBefore, `pass ${p}: GC page repeated`);
  }
  return null;
}

test("GC progresses past logical-delete markers: 250 keys collected and collect cleared within the bound", async () => {
  // Bound: two traversals (one deleting, one confirming) of ceil(keys / page)
  // pages, one GC page per pass. At B=600 a page is GC_LIST_LIMIT (100).
  const big = await wrappedCollecting(250);
  const p600 = await gcPasses(big, 600, 50);
  assert.ok(p600 !== null && p600 <= 6, `B=600: ${p600} passes (bound 6)`);
  // At B=15 the GC gets 15 - 2 reads - 3 reserved = 10 ops: a page of 8
  // (the list, and one op of headroom kept by the deletes for the wrapper's
  // marker write), or 6 on a page of a traversal that has found nothing yet,
  // which keeps the manifest read and publish that end it (fix round 3).
  // Bound: 1 + ceil(244 / 8) deleting pages, ceil(250 / 6) confirming pages,
  // plus 2: 77, measured exactly.
  const p15 = await gcPasses(await wrappedCollecting(250), 15, 400);
  assert.ok(p15 !== null && p15 <= 77, `B=15: ${p15} passes (bound 77)`);
  // With the search budget's charge installed (as in maintenance), each
  // marker write and each marker read while listing costs one more op, so a
  // page takes several passes; measured 158, bound 170. Raw calls per pass
  // never exceed B.
  const charged = await gcPasses(await wrappedCollecting(250), 15, 400, { charge: true });
  // 248 keys end on a full page of charged marker reads: the ending publish
  // must still fit in that pass (no repeated clean page, checked in gcPasses).
  assert.ok((await gcPasses(await wrappedCollecting(248), 15, 400, { charge: true })) !== null);
  assert.ok(charged !== null && charged <= 170, `B=15 charged: ${charged} passes (bound 170)`);
});

test("GC never clears collect on a truncated page that gives no cursor", async () => {
  const env = await wrappedCollecting(5);
  const store = Object.assign(Object.create(env.store), { list: async () => ({ objects: [], truncated: true }) });
  for (let i = 0; i < 12; i += 1) await pass(store, env.b, createSearchBudget(600));
  assert.equal(await env.collect(), "1");
});

// 3. Health on a manifest from newer code

test("graphHealth is unavailable (never complete) on a manifest labelled with any newer version", async () => {
  const current = { parserVersion: PARSER_VERSION, resolverVersion: RESOLVER_VERSION, urlKeyVersion: URL_KEY_VERSION };
  const manifest = (over) => ({
    formatVersion: 1, generation: "2", building: null, ...current, ...over, mode: "conditional",
    health: { state: "ready", sweepComplete: true, lastSweepAt: "2026-01-01T00:00:00.000Z" },
  });
  const b = memoryBucket();
  b.capabilities = CAPS;
  await b.put(graphManifestKey(), JSON.stringify(manifest({})));
  const control = await graphHealth(b, createSearchBudget(5));
  assert.equal(control.state, "ready");
  assert.equal(control.complete, true);
  for (const field of Object.keys(current)) {
    await b.put(graphManifestKey(), JSON.stringify(manifest({ [field]: current[field] + 1 })));
    const health = await graphHealth(b, createSearchBudget(5));
    assert.equal(health.state, "unavailable", field);
    assert.equal(health.complete, false, field);
    assert.equal(health.possiblyIncomplete, true, field);
  }
});

// 4. Write path charges wrapper probes against WRITE_ENRICH

test("write path: raw graph subrequests on a logical-delete store never exceed the WRITE_ENRICH budget", async () => {
  for (const budget of [8, 20, 80]) {
    const b = memoryBucket();
    let graphRaw = 0;
    const g = (k) => {
      if (isGraph(k)) graphRaw += 1;
    };
    const store = withLogicalDelete({
      capabilities: CAPS,
      get: (k) => (g(k), b.get(k)),
      put: (k, v, o) => (g(k), b.put(k, v, o)),
      delete: (k, o) => (g(k), b.delete(k, o)),
      list: (o) => b.list(o),
    });
    store.actor = { workspaceId: "w_guards", userId: "u_owner" };
    store.writeEnrichBudget = budget;
    await initGraphManifest(store, createSearchBudget(10), { mode: "conditional", now });
    let sentinel = 0;
    store.setExtraOperationCharge(() => {
      sentinel += 1;
    });
    graphRaw = 0;
    await toolWriteNote(store, "private", [], new Map(), { path: "big.md", content: links(60) });
    assert.ok(graphRaw > 0, `budget ${budget}: the hook ran`);
    assert.ok(graphRaw <= budget, `budget ${budget}: ${graphRaw} raw graph subrequests`);
    // The charge in place before the write is restored after it.
    sentinel = 0;
    await store.delete("big.md");
    assert.ok(sentinel > 0, "the previous charge is back");
  }
});

// 5. Byte caps before text() and JSON.parse

const huge = () => JSON.stringify({ pad: "x".repeat(GRAPH_RECORD_BYTE_CAP + 10) });

/** Counts JSON.parse calls on over-cap strings during `fn`. */
async function bigParses(fn) {
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = (text, ...rest) => {
    if (typeof text === "string" && text.length > GRAPH_RECORD_BYTE_CAP) calls += 1;
    return parse(text, ...rest);
  };
  try {
    await fn();
  } finally {
    JSON.parse = parse;
  }
  return calls;
}

test("recordText: a reported size over the cap is never read; an unsized over-cap body is never returned", async () => {
  let reads = 0;
  const sized = { size: GRAPH_RECORD_BYTE_CAP + RECORD_STORAGE_OVERHEAD + 1, text: async () => ((reads += 1), huge()) };
  assert.ok((await recordText(sized)) === null);
  assert.equal(reads, 0);
  assert.ok((await recordText({ text: async () => huge() })) === null);
  assert.equal(await recordText({ size: 2, text: async () => "{}" }), "{}");
  assert.equal(await recordText({ text: async () => "{}" }), "{}");
});

/** A converged bucket whose `oversized` keys read as over-cap objects, sized or not. */
async function withOversized(oversized, sized) {
  const b = memoryBucket();
  b.capabilities = CAPS;
  await b.put("a.md", "[t](./t.md)");
  await b.put("t.md", "plain");
  for (let i = 0; i < 6; i += 1) await pass(b, b, createSearchBudget(1000));
  const reads = { text: 0 };
  const store = {
    ...b,
    capabilities: CAPS,
    async get(k) {
      if (!oversized(k)) return b.get(k);
      const etag = b.objects.get(k)?.etag ?? "big";
      const text = async () => ((reads.text += 1), huge());
      return sized ? { etag, size: GRAPH_RECORD_BYTE_CAP + RECORD_STORAGE_OVERHEAD + 1, text } : { etag, text };
    },
  };
  return { b, store, reads };
}

test("readCursor and auditNode never read a sized over-cap object and never parse an unsized one", async () => {
  const strayNode = `${generationPrefix("1")}nodes/${"e".repeat(64)}.json`;
  const cases = {
    cursor: (k) => k === maintenanceCursorKey("1"),
    node: (k) => k === strayNode,
    manifest: (k) => k === graphManifestKey(),
  };
  for (const [name, oversized] of Object.entries(cases)) {
    for (const sized of [true, false]) {
      const env = await withOversized(oversized, sized);
      await env.b.put(strayNode, "{}");
      const parses = await bigParses(async () => {
        for (let i = 0; i < 8; i += 1) await pass(env.store, env.b, createSearchBudget(1000));
        await graphHealth(env.store, createSearchBudget(5));
      });
      assert.equal(parses, 0, `${name} sized=${sized}: over-cap JSON.parse`);
      if (sized) assert.equal(env.reads.text, 0, `${name}: text() read despite size`);
      else assert.ok(env.reads.text > 0, `${name}: the object was reached`);
    }
  }
});

/** A byte-exact store whose objects report their stored size, like R2 and S3. */
function byteStore() {
  const objects = new Map();
  let n = 0;
  return {
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        etag: hit.etag,
        size: hit.bytes.byteLength,
        text: async () => new TextDecoder().decode(hit.bytes),
        arrayBuffer: async () => hit.bytes.slice().buffer,
      };
    },
    async put(key, value) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, { bytes, etag: `e${++n}` });
      return { etag: `e${n}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list() {
      return { objects: [...objects.keys()].map((key) => ({ key, size: objects.get(key).bytes.byteLength })), truncated: false };
    },
  };
}

test("size pre-check allows encryption and stamp overhead; the exact cap still applies to the text", async () => {
  // A record whose text is 10 bytes under the cap.
  const record = JSON.stringify({ pad: "x".repeat(GRAPH_RECORD_BYTE_CAP - 20) });
  assert.equal(GRAPH_RECORD_BYTE_CAP - new TextEncoder().encode(record).byteLength, 10);
  // The longest generation a managed key may have (KEY_ID_PATTERN: 32 characters).
  const generation = "k".repeat(32);
  const config = { workspaceId: "ws_guards", mode: "encrypted", current: generation, keys: { [generation]: Buffer.alloc(32, 7).toString("base64") } };
  const raw = byteStore();
  const sealedStore = withManagedEncryption(raw, config);
  const key = `${generationPrefix("1")}nodes/${"a".repeat(64)}.json`;
  await sealedStore.put(key, record);
  // The gateway stack (logical delete over encryption) reports the plain size: read.
  assert.equal(await recordText(await withLogicalDelete(sealedStore).get(key)), record);
  // A view reporting the stored (sealed) size, with the decoded text: still read.
  const stored = await raw.get(key);
  const overhead = stored.size - new TextEncoder().encode(record).byteLength;
  const footer = stampGeneration("").length;
  assert.ok(overhead + footer <= RECORD_STORAGE_OVERHEAD, `envelope ${overhead} + stamp ${footer} > ${RECORD_STORAGE_OVERHEAD}`);
  assert.equal(await recordText({ size: stored.size + footer, text: async () => record }), record);
  // Over the cap by one byte of text: never returned, whatever the size says.
  const over = JSON.stringify({ pad: "x".repeat(GRAPH_RECORD_BYTE_CAP - 9) });
  assert.ok((await recordText({ size: GRAPH_RECORD_BYTE_CAP + 1, text: async () => over })) === null);
});

test("a collect:null publish that does not land is retried on the last page, never by a fresh traversal", async () => {
  const env = await wrappedCollecting(250);
  // Delete everything (B=600: pages of 100), then refuse the one publish that
  // ends the confirming traversal.
  let refuse = false;
  let refused = 0;
  const store = Object.assign(Object.create(env.store), {
    async put(key, value, options) {
      if (refuse && key === graphManifestKey() && JSON.parse(value).collect === null) {
        refused += 1;
        refuse = false;
        return null;
      }
      return env.store.put(key, value, options);
    },
  });
  for (let p = 0; p < 3; p += 1) await pass(store, env.b, createSearchBudget(600));
  assert.equal(await env.visible(), 0);
  refuse = true;
  for (let p = 0; p < 3 && refused === 0; p += 1) await pass(store, env.b, createSearchBudget(600));
  assert.equal(refused, 1, "the ending publish was refused once");
  assert.equal(await env.collect(), "1");
  await pass(store, env.b, createSearchBudget(600));
  assert.equal(await env.collect(), null, "cleared on the very next pass");
});

test("an audit listing that throws for budget keeps auditCursor", async () => {
  const b = memoryBucket();
  b.capabilities = CAPS;
  await b.put("a.md", "[t](./t.md)");
  await b.put("t.md", "x");
  for (let i = 0; i < 6; i += 1) await pass(b, b, createSearchBudget(1000));
  const key = maintenanceCursorKey("1");
  const held = JSON.stringify([".context/graph/v1/g/1/nodes/x.json", 1, 0]);
  await b.put(key, JSON.stringify({ ...JSON.parse(b.objects.get(key).body), auditCursor: held }));
  const throwing = Object.assign(Object.create(b), {
    async list() {
      const error = new Error("search budget exhausted");
      error[BUDGET_EXHAUSTED] = true;
      throw error;
    },
  });
  await pass(throwing, b, createSearchBudget(1000));
  assert.equal(JSON.parse(b.objects.get(key).body).auditCursor, held);
});
