/**
 * Graph reconciliation on the shared search census (`src/graph/reconcile.js`,
 * arch 10.1, 10.3) and its one call inside `maintainNow`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   audit (node removal) runs on an incomplete census                     1 (incomplete census)
 *   removal without the confirming note read                              2 (absent but present, hints)
 *   GRAPH_PASS_FLOOR ignored in maintainNow (>= 1)                        1 (floor)
 *   posting audit removes entries validateEntry accepts                   3 (audit, starvation, absent)
 *   posting audit clear by source instead of exact entry                  1 (audit, at every write)
 *   state "ready" published while the wrap found pending work             1 (ready only when clean)
 *   sweep skips the reverseRepair check                                   3 (interrupted cleanup, fresh, ready)
 *   node audit does not re-assert memberships                             2 (lost membership, starvation)
 *   sweep advances past a note the budget stopped                         1 (fresh workspace)
 *   no audit share once ready (superseded in fix round 1 by turns)        1 (starvation)
 *   wrap reserve 0 (now wrapReserve(mode))                                2 (fresh workspace, starvation)
 *   graph try/catch in maintainNow removed                                2 (failure, sync unchanged)
 *   a throwing confirming read treated as not-found                       1 (throwing read)
 *   a throwing body read escapes the sweep                                1 (throwing read)
 *   tombstones not skipped by the audit                                   1 (tombstone; measured 0
 *                                                                           before that test existed)
 *
 * Fix round 1 (liveness; red first: the five tests below and the graphProject
 * durability test). Counts over this file plus graphProject.test.mjs:
 *   projectNote: no checkpoint on a budget stop                           3 (hub, floor, durable)
 *   projectNote: resume disabled, full union re-put every call            3 (hub, floor, durable)
 *   projectNote: membership loop keeps no op back                         2 (hub, durable)
 *   sweep re-reads the node instead of handing it to projectNote          1 (floor)
 *   GRAPH_PASS_FLOOR back to 9                                            1 (floor)
 *   audit half-share instead of alternating turns                         2 (paging at 15, starvation)
 *   audit never takes the first turn                                      2 (paging at 15, starvation)
 *   audit mid-page resume ignores earlier removals                        1 (mid-page; measured 0
 *                                                                           before that test existed)
 *   graph pass on the inline maintenance path                             1 (inline)
 *   sweep node read unguarded                                             1 (throwing node read)
 *
 * Fix round 2 (red first: the grid test and seven graphProject assertions on
 * the explicit "budget" state):
 *   sweep stop test inferred from budget.remaining again                  1 (layout grid)
 *
 * Measured zero, then fixed: the exact-entry clear was masked by the node
 * audit re-adding the entry on a later pass, so the audit test now checks the
 * accepted entries at every page write; the audit share had no test with a
 * census larger than the budget, so the starvation test was added.
 *
 * Process note: tests written first; RED was the missing module. Two of my own
 * test bugs were fixed on the way (a census taken before a delete; a floor test
 * that assumed the sync spends the same at every budget).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphHealth, loadGraphManifest } from "../src/graph/manifest.js";
import { projectNote } from "../src/graph/project.js";
import { readPostings } from "../src/graph/postings.js";
import { nodeKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { parseNode, serializePage } from "../src/graph/records.js";
import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { maintainIndexAfter } from "../src/search/maintenance.js";
import { GRAPH_PASS_FLOOR } from "../src/search/pacing.js";
import { memoryBucket } from "./store/fixtures.mjs";

const gen = "1";
const now = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
// Passes of 24 ops to restore 60 lost memberships. Measured: 38 with sweep
// and audit alternating once ready (46 with the old half-share), 172 with the
// audit only getting what the sweep leaves.
const AUDIT_STARVATION_BOUND = 60;
// Measured: 200 passes at budget 15 (before fix round 1: 0/80 in 2,000).
const AUDIT_PAGING_BOUND = 400;
// Measured: 28 passes; 52 when the resume ignores earlier removals.
const MIDPAGE_BOUND = 40;
const links = (...targets) => targets.map((t) => `[${t}](./${t})`).join(" ");

function bucket({ conditional = true } = {}) {
  const b = memoryBucket();
  if (conditional) b.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
  return b;
}
/** The census the search docmap would hold: every indexable note and its etag. */
function censusOf(b) {
  const census = new Map();
  for (const [key, { etag }] of b.objects) if (defaultIsIndexable(key)) census.set(key, etag);
  return census;
}
const pass = (b, budget = big(), extra = {}) =>
  reconcileGraph(b, budget, {
    census: censusOf(b),
    censusComplete: true,
    removedHints: [],
    isIndexable: defaultIsIndexable,
    now,
    ...extra,
  });
const node = async (b, path) => {
  const got = await b.get(nodeKey(gen, await pathHash(path)));
  return got ? parseNode(await got.text(), path) : null;
};
/** Raw sources in the target's `incoming/` posting, no validation. */
const incoming = async (b, target) => {
  const { entries } = await readPostings(b, big(), {
    gen, family: "incoming", hash: await pathHash(target), canSee: () => true, validate: () => true,
  });
  return entries.map((e) => `${e.source}`).sort();
};
const rawEntries = async (b, target) => {
  const got = await b.get(postingPageKey(gen, "incoming", await pathHash(target), 0));
  return got ? JSON.parse(await got.text()).entries : [];
};
const state = async (b) => (await loadGraphManifest(b, big()))?.health;
const graphKeys = (b) => [...b.objects.keys()].filter((k) => k.startsWith(GRAPH_PREFIX));

async function seed(b) {
  await b.put("a.md", links("t.md", "u.md"));
  await b.put("b.md", links("t.md"));
  await b.put("c.md", "no links");
  await b.put("t.md", links("a.md"));
  await b.put("u.md", "plain");
}

test("a fresh workspace gets a manifest on the first pass and converges over budgeted passes", async () => {
  const b = bucket();
  await seed(b);
  const first = createSearchBudget(15);
  await pass(b, first);
  assert.ok(first.spent <= 15);
  assert.ok(await loadGraphManifest(b, big()), "manifest created on the first pass");
  let passes = 1;
  while ((await state(b)).state !== "ready") {
    passes += 1;
    assert.ok(passes <= 60, "converges within a bounded number of passes");
    const budget = createSearchBudget(15);
    await pass(b, budget);
    assert.ok(budget.spent <= 15, `pass ${passes} spent ${budget.spent}`);
  }
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
  assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
  assert.deepEqual(await incoming(b, "a.md"), ["t.md"]);
  for (const p of ["a.md", "b.md", "c.md", "t.md", "u.md"]) {
    const n = await node(b, p);
    assert.equal(n.observedSourceVersion, b.objects.get(p).etag);
    assert.deepEqual(n.reverseRepair, []);
  }
  const health = await graphHealth(b, big());
  assert.equal(health.complete, true);
});

test("a pass never exceeds the budget it was given, at every size", async () => {
  for (let n = 0; n <= 60; n += 1) {
    const b = bucket();
    await seed(b);
    const budget = createSearchBudget(n);
    await pass(b, budget);
    assert.ok(budget.spent <= n, `budget ${n} spent ${budget.spent}`);
  }
});

test("best-effort store converges too and never reports complete", async () => {
  const b = bucket({ conditional: false });
  await seed(b);
  for (let i = 0; i < 5; i += 1) await pass(b);
  assert.equal((await state(b)).state, "ready");
  assert.equal((await graphHealth(b, big())).complete, false);
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("state becomes ready only when the wrap found nothing pending", async () => {
  const b = bucket();
  await seed(b);
  // An unparseable posting page: every projection that touches it is pending.
  const key = postingPageKey(gen, "incoming", await pathHash("t.md"), 0);
  await b.put(key, "{not json");
  for (let i = 0; i < 4; i += 1) await pass(b);
  const health = await state(b);
  assert.equal(health.sweepComplete, true);
  assert.notEqual(health.state, "ready");
  await b.delete(key);
  for (let i = 0; i < 4 && (await state(b)).state !== "ready"; i += 1) await pass(b);
  assert.equal((await state(b)).state, "ready");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("a truncated census never sets sweepComplete or ready", async () => {
  const b = bucket();
  await seed(b);
  for (let i = 0; i < 4; i += 1) await pass(b, big(), { censusComplete: false });
  const health = await state(b);
  assert.notEqual(health.sweepComplete, true);
  assert.notEqual(health.state, "ready");
});

test("a node with pending reverseRepair is re-projected with no note edit (interrupted cleanup)", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const version = b.objects.get("a.md").etag;
  // A projection of the same version stopped mid-repair: obligations recorded.
  await b.put(postingPageKey(gen, "incoming", await pathHash("u.md"), 0), serializePage({
    key: postingPageKey(gen, "incoming", await pathHash("u.md"), 0), entries: [],
  }));
  const before = await node(b, "a.md");
  const k = nodeKey(gen, await pathHash("a.md"));
  await b.put(k, JSON.stringify({ ...before, reverseRepair: [{ family: "incoming", hash: await pathHash("u.md") }] }));
  assert.equal((await node(b, "a.md")).observedSourceVersion, version);
  assert.deepEqual(await incoming(b, "u.md"), []);
  // Audit off (incomplete census), so only the sweep can repair it.
  for (let i = 0; i < 2; i += 1) await pass(b, big(), { censusComplete: false });
  assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
  assert.deepEqual((await node(b, "a.md")).reverseRepair, []);
});

test("a note deleted from a complete census loses its node and memberships after a direct not-found", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
  await b.delete("b.md");
  for (let i = 0; i < 3; i += 1) await pass(b);
  assert.equal(await node(b, "b.md"), null);
  assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
});

test("a path absent from a complete census but present in the bucket is never removed", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const census = censusOf(b);
  census.delete("b.md"); // the docmap lags a note that still exists
  const reads = [];
  const store = { ...b, capabilities: b.capabilities, get: (k) => (reads.push(k), b.get(k)) };
  for (let i = 0; i < 3; i += 1) await reconcileGraph(store, big(), {
    census, censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now,
  });
  assert.ok(reads.includes("b.md"), "the confirming read happened");
  assert.ok(await node(b, "b.md"));
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("removedHints are confirmed by a direct read before removal", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  // Hint for a note that still exists (and the census lags it): kept.
  const lagging = censusOf(b);
  lagging.delete("b.md");
  await pass(b, big(), { census: lagging, removedHints: ["b.md"], censusComplete: false });
  assert.ok(await node(b, "b.md"));
  // Hint for a note that is gone: removed even on an incomplete census.
  await b.delete("b.md");
  await pass(b, big(), { removedHints: ["b.md"], censusComplete: false });
  assert.equal(await node(b, "b.md"), null);
  assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
});

test("a note read that throws neither stalls the sweep nor counts as not-found", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const census = censusOf(b);
  census.set("a.md", "changed"); // a.md needs a body read
  census.delete("b.md"); // b.md needs a confirming read
  const store = {
    ...b,
    capabilities: b.capabilities,
    get: async (k) => {
      if (k === "a.md" || k === "b.md") throw new Error("storage 500");
      return b.get(k);
    },
  };
  const out = await reconcileGraph(store, big(), { census, censusComplete: true, removedHints: ["b.md"], isIndexable: defaultIsIndexable, now });
  assert.equal(out.sweepComplete, true, "the sweep wrapped past the unreadable note");
  assert.notEqual((await state(b)).state, "ready");
  assert.ok(await node(b, "b.md"), "a failed read never removes");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("a tombstone (no conditional delete) costs no confirming read on later audits", async () => {
  const b = bucket();
  b.capabilities = { conditionalWrite: true, conditionalCreate: true };
  await seed(b);
  await pass(b);
  await b.delete("b.md");
  for (let i = 0; i < 3; i += 1) await pass(b);
  assert.equal((await node(b, "b.md")).coverage, "excluded", "tombstone left");
  const reads = [];
  const store = { ...b, capabilities: b.capabilities, get: (k) => (reads.push(k), b.get(k)) };
  await reconcileGraph(store, big(), { census: censusOf(b), censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });
  assert.ok(!reads.includes("b.md"));
});

test("an incomplete census never removes anything", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const census = censusOf(b);
  census.delete("b.md");
  await b.delete("b.md"); // gone from the bucket and missing from a truncated listing
  for (let i = 0; i < 4; i += 1) await pass(b, big(), { census, censusComplete: false });
  assert.ok(await node(b, "b.md"), "node kept");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("lost membership (posting emptied while the node is current) is restored by the audit", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  await b.delete(postingPageKey(gen, "incoming", await pathHash("t.md"), 0));
  assert.deepEqual(await incoming(b, "t.md"), []);
  let passes = 0;
  while ((await incoming(b, "t.md")).length < 2) {
    passes += 1;
    assert.ok(passes <= 20, "restored within a bounded number of passes");
    await pass(b, createSearchBudget(40));
  }
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
});

test("a converged sweep over a census larger than the budget does not starve the audit", async () => {
  const b = bucket();
  for (let i = 0; i < 60; i += 1) await b.put(`n${String(i).padStart(2, "0")}.md`, links("t.md"));
  await b.put("t.md", "x");
  await pass(b);
  assert.equal((await state(b)).state, "ready");
  await b.delete(postingPageKey(gen, "incoming", await pathHash("t.md"), 0));
  let passes = 0;
  while ((await incoming(b, "t.md")).length < 60) {
    passes += 1;
    assert.ok(passes <= AUDIT_STARVATION_BOUND, `restored within ${AUDIT_STARVATION_BOUND} passes`);
    await pass(b, createSearchBudget(24));
  }
});

test("the posting audit removes entries validateEntry rejects and never an accepted one", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const key = postingPageKey(gen, "incoming", await pathHash("t.md"), 0);
  const valid = await rawEntries(b, "t.md");
  assert.equal(valid.length, 2);
  const stale = [
    { source: "a.md", referenceSetVersion: "0".repeat(64) }, // old version of a live source
    { source: "ghost.md", referenceSetVersion: "1".repeat(64) }, // no node at all
    { source: "c.md", referenceSetVersion: "2".repeat(64) }, // node exists, does not link
  ];
  await b.put(key, serializePage({ key, entries: [...stale.slice(0, 1), ...valid, ...stale.slice(1)] }));
  // Checked at every write, not just at the end: a later pass re-adding a
  // wrongly removed entry would hide the removal.
  const want = valid.map((e) => `${e.source}:${e.referenceSetVersion}`);
  const store = {
    ...b,
    capabilities: b.capabilities,
    async put(k, v, o) {
      if (k === key) {
        const have = JSON.parse(v).entries.map((e) => `${e.source}:${e.referenceSetVersion}`);
        for (const w of want) assert.ok(have.includes(w), `accepted entry ${w} kept at every write`);
      }
      return b.put(k, v, o);
    },
  };
  for (let i = 0; i < 6; i += 1) await reconcileGraph(store, createSearchBudget(40), {
    census: censusOf(b), censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now,
  });
  const after = await rawEntries(b, "t.md");
  assert.deepEqual(
    after.map((e) => `${e.source}:${e.referenceSetVersion}`).sort(),
    valid.map((e) => `${e.source}:${e.referenceSetVersion}`).sort()
  );
});

// Liveness (fix round 1). Bounds are about twice the measured passes; see the
// report for the measured table.
const hubBody = (n) => Array.from({ length: n }, (_, i) => `[t${i}](./t${i}.md)`).join(" ");
const settled = async (b, path) => {
  const n = await node(b, path);
  return n !== null && n.observedSourceVersion === b.objects.get(path).etag && n.reverseRepair.length === 0;
};
// Measured passes (fix round 1): 23, 15, 6, 2.
const HUB_BOUNDS = { 12: 50, 15: 30, 24: 12, 80: 4 };

test("a note with more memberships than a pass's budget converges at fixed budgets, and a later note too", async () => {
  for (const [B, bound] of Object.entries(HUB_BOUNDS).map(([k, v]) => [Number(k), v])) {
    const b = bucket();
    await b.put("a-hub.md", hubBody(40)); // 41 memberships, sorted first
    await b.put("b.md", "[a](./a-hub.md)"); // after the hub: no head-of-line block
    let passes = 0;
    while (!((await state(b))?.state === "ready" && (await settled(b, "a-hub.md")) && (await settled(b, "b.md")))) {
      passes += 1;
      assert.ok(passes <= bound, `budget ${B}: converged within ${bound} passes`);
      const budget = createSearchBudget(B);
      await pass(b, budget);
      assert.ok(budget.spent <= B);
    }
    assert.equal((await incoming(b, "t39.md")).length, 1, `budget ${B}`);
    assert.deepEqual(await incoming(b, "a-hub.md"), ["b.md"], `budget ${B}`);
  }
});

async function oneLinkPasses(conditional, B, max) {
  const b = bucket({ conditional });
  await b.put("a.md", links("t.md"));
  for (let passes = 1; passes <= max; passes += 1) {
    await pass(b, createSearchBudget(B));
    if ((await state(b))?.state === "ready" && (await settled(b, "a.md"))) {
      assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
      return passes;
    }
  }
  return null;
}

// Fix round 2: the reviewer's grid. K plain notes, one linking note `m.md`
// with L links, J plain notes after it. Bound: proportional to total work.
async function gridPasses(conditional, B, K, L, J, max) {
  const b = bucket({ conditional });
  const pad = (i) => String(i).padStart(3, "0");
  const paths = [];
  for (let i = 0; i < K; i += 1) paths.push(`a${pad(i)}.md`);
  paths.push("m.md");
  for (let i = 0; i < J; i += 1) paths.push(`z${pad(i)}.md`);
  for (const p of paths) await b.put(p, p === "m.md" ? hubBody(L) : "plain");
  for (let passes = 1; passes <= max; passes += 1) {
    const budget = createSearchBudget(B);
    await pass(b, budget);
    assert.ok(budget.spent <= B);
    if ((await state(b))?.state !== "ready") continue;
    let ok = true;
    for (const p of paths) if (!(await settled(b, p))) { ok = false; break; }
    if (ok) return passes;
  }
  return null;
}
// Ops per note: node read, body, publish, names walk and write, clear (6),
// plus two per link; a pass has about B - 10 ops for that after its overhead.
const gridBound = (B, K, L, J) => 10 + GRID_FACTOR * Math.ceil((6 * (K + J + 1) + 2 * L) / Math.max(1, B - 10));
// Measured: every layout converges within the bound at factor 1.
const GRID_FACTOR = 2;
const GRID_LAYOUTS = [
  [0, 1, 6], [6, 1, 0], [6, 1, 6], [20, 1, 30], [70, 1, 3], [12, 1, 10], [4, 1, 30],
  [0, 40, 6], [0, 40, 8], [0, 40, 10],
];

test("the layout grid converges in both modes at every budget (no wrap-forever livelock)", async () => {
  const failures = [];
  for (const conditional of [true, false]) {
    for (const B of [11, 12, 13, 15, 18, 24, 30, 40, 80]) {
      for (const [K, L, J] of GRID_LAYOUTS) {
        const bound = gridBound(B, K, L, J);
        const passes = await gridPasses(conditional, B, K, L, J, bound);
        if (passes === null) failures.push(`${conditional ? "cond" : "best"} B=${B} K=${K} L=${L} J=${J} (bound ${bound})`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("a pass at exactly GRAPH_PASS_FLOOR converges a one-link note, and the floor is the measured minimum", async () => {
  assert.equal(GRAPH_PASS_FLOOR, 11);
  for (const conditional of [true, false]) {
    const passes = await oneLinkPasses(conditional, GRAPH_PASS_FLOOR, 10);
    assert.ok(passes !== null, `conditional=${conditional}: converged at the floor within 10 passes`);
  }
  // One below: a best-effort store lands nothing.
  assert.equal(await oneLinkPasses(false, GRAPH_PASS_FLOOR - 1, 20), null);
});

test("the posting audit progresses at budget 15: 80 sabotaged pages are repaired", async () => {
  const b = bucket();
  // A paging listing (the memory fixture ignores cursor and limit).
  const inner = b.list.bind(b);
  b.list = async ({ prefix, cursor, limit } = {}) => {
    const all = (await inner({ prefix })).objects;
    const off = cursor ? Number(cursor) : 0;
    const n = limit ?? 1000;
    const more = off + n < all.length;
    return { objects: all.slice(off, off + n), truncated: more, ...(more && { cursor: String(off + n) }) };
  };
  const name = (i) => `n${String(i).padStart(3, "0")}.md`;
  for (let i = 0; i < 80; i += 1) await b.put(name(i), `[x](./${name((i + 1) % 80)})`);
  for (let i = 0; i < 3; i += 1) await pass(b);
  assert.equal((await state(b)).state, "ready");
  // Every incoming page loses its real entry and gains a stale one.
  const victims = [];
  for (let i = 0; i < 80; i += 1) {
    const key = postingPageKey(gen, "incoming", await pathHash(name(i)), 0);
    victims.push(key);
    await b.put(key, serializePage({ key, entries: [{ source: "ghost.md", referenceSetVersion: "z".repeat(64) }] }));
  }
  const repaired = () =>
    victims.filter((k) => {
      const e = JSON.parse(b.objects.get(k).body).entries;
      return e.length === 1 && e[0].source !== "ghost.md";
    }).length;
  let passes = 0;
  while (repaired() < 80) {
    passes += 1;
    assert.ok(passes <= AUDIT_PAGING_BOUND, `repaired ${repaired()}/80 within ${AUDIT_PAGING_BOUND} passes`);
    const budget = createSearchBudget(15);
    await pass(b, budget);
    assert.ok(budget.spent <= 15);
  }
});

test("the audit resumes mid-page at the right entry after removals shift the page", async () => {
  const b = bucket();
  await seed(b);
  await pass(b);
  const key = postingPageKey(gen, "incoming", await pathHash("t.md"), 0);
  const valid = await rawEntries(b, "t.md");
  const ghosts = Array.from({ length: 40 }, (_, i) => ({ source: `ghost${i}.md`, referenceSetVersion: "z".repeat(64) }));
  await b.put(key, serializePage({ key, entries: [...ghosts, ...valid] }));
  let passes = 0;
  while ((await rawEntries(b, "t.md")).length > valid.length) {
    passes += 1;
    assert.ok(passes <= MIDPAGE_BOUND, `40 stale entries removed within ${MIDPAGE_BOUND} passes`);
    await pass(b, createSearchBudget(15));
  }
  assert.deepEqual(await rawEntries(b, "t.md"), valid);
});

test("a node record read that keeps throwing skips that note, counted pending, without stalling", async () => {
  const b = bucket();
  await seed(b);
  const bad = nodeKey(gen, await pathHash("a.md"));
  const store = {
    ...b,
    capabilities: b.capabilities,
    get: async (k) => {
      if (k === bad) throw new Error("storage 500");
      return b.get(k);
    },
  };
  let out;
  for (let i = 0; i < 4; i += 1) {
    out = await reconcileGraph(store, big(), { census: censusOf(b), censusComplete: false, removedHints: [], isIndexable: defaultIsIndexable, now });
  }
  assert.ok(await settled(b, "b.md"), "later notes still projected");
  assert.ok(await settled(b, "u.md"));
  assert.ok(out.pending >= 1, "the unreadable note is counted pending");
});

test("an encrypted note in the census yields an excluded node with no memberships", async () => {
  const b = bucket();
  await b.put("secret.md", "---\ncontext_encryption: v1\n---\n[[./t]] [t](./t.md)");
  await b.put("t.md", "x");
  await pass(b);
  const n = await node(b, "secret.md");
  assert.equal(n.coverage, "excluded");
  assert.deepEqual(await incoming(b, "t.md"), []);
});

test("nothing outside .context/graph/ is ever written or deleted", async () => {
  const b = bucket();
  await seed(b);
  const notes = new Map([...b.objects].filter(([k]) => !k.startsWith(GRAPH_PREFIX)).map(([k, v]) => [k, v.body]));
  const store = {
    ...b,
    capabilities: b.capabilities,
    put: (k, v, o) => { assert.ok(k.startsWith(GRAPH_PREFIX), k); return b.put(k, v, o); },
    delete: (k, o) => { assert.ok(k.startsWith(GRAPH_PREFIX), k); return b.delete(k, o); },
  };
  await b.delete("b.md");
  notes.delete("b.md");
  for (let i = 0; i < 4; i += 1) await reconcileGraph(store, big(), {
    census: censusOf(b), censusComplete: true, removedHints: ["b.md"], isIndexable: defaultIsIndexable, now,
  });
  for (const [k, body] of notes) assert.equal(b.objects.get(k).body, body);
});

// maintainNow wiring

/**
 * A bucket whose listing reports each object's etag (stable versions), that
 * records `budget.spent` at the first graph op, and that can refuse every
 * graph op (graph disabled: the first graph call throws).
 */
function maintained({ disableGraph = false, defer = true } = {}) {
  const b = memoryBucket();
  const s = { b, budget: null, spentAtGraph: null, remainingAtGraph: null, afterSearch: null, graphOps: 0, deferred: [] };
  const touch = (k) => {
    if (typeof k !== "string" || !k.startsWith(GRAPH_PREFIX)) {
      s.afterSearch = s.budget.remaining;
      return;
    }
    // The graph pass took one op for this call already.
    if (s.spentAtGraph === null) [s.spentAtGraph, s.remainingAtGraph] = [s.budget.spent - 1, s.budget.remaining + 1];
    s.graphOps += 1;
    if (disableGraph) throw new Error("graph disabled");
  };
  s.store = {
    get: async (k) => (touch(k), b.get(k)),
    put: async (k, v, o) => (touch(k), b.put(k, v, o)),
    delete: async (k, o) => (touch(k), b.delete(k, o)),
    async list(options = {}) {
      touch(options.prefix);
      const page = await b.list(options);
      return { ...page, objects: page.objects.map((o) => ({ ...o, etag: b.objects.get(o.key)?.etag })) };
    },
  };
  // A host with `waitUntil`: maintenance runs behind the response.
  if (defer) s.store.defer = (promise) => s.deferred.push(promise);
  return s;
}

async function maintainedRun({ disableGraph, total, defer = true }) {
  const s = maintained({ disableGraph, defer });
  await seed(s.b);
  s.budget = createSearchBudget(total);
  await maintainIndexAfter(s.store, s.budget, defaultIsIndexable, null);
  await Promise.all(s.deferred);
  return s;
}
const searchState = (b) =>
  [...b.objects].filter(([k]) => k.startsWith(".context/search/")).map(([k]) => k).sort();

test("maintainNow: the search sync's results and budget use are unchanged when graph work runs", async () => {
  const on = await maintainedRun({ disableGraph: false, total: 200 });
  const off = await maintainedRun({ disableGraph: true, total: 200 });
  assert.ok(on.graphOps > 1, "graph work ran");
  assert.equal(off.graphOps, 1, "disabled graph stopped at its first op");
  assert.equal(on.spentAtGraph, off.spentAtGraph, "the sync spent the same before the graph started");
  assert.deepEqual(searchState(on.b), searchState(off.b));
  const docmap = (s) => s.b.objects.get(".context/search/v2/docmap.json")?.body;
  assert.ok(docmap(on));
  assert.equal(docmap(on), docmap(off));
});

test("maintainNow: the graph pass runs only with GRAPH_PASS_FLOOR left after search", async () => {
  let ran = 0;
  let skipped = 0;
  for (let total = 14; total <= 80; total += 1) {
    const s = await maintainedRun({ disableGraph: false, total });
    if (s.spentAtGraph === null) {
      skipped += 1;
      assert.ok(s.afterSearch < GRAPH_PASS_FLOOR, `budget ${total}: skipped with ${s.afterSearch} left`);
    } else {
      ran += 1;
      assert.ok(s.remainingAtGraph >= GRAPH_PASS_FLOOR, `budget ${total}: ran with ${s.remainingAtGraph} left`);
    }
  }
  assert.ok(ran > 0 && skipped > 0, `both sides observed (ran ${ran}, skipped ${skipped})`);
});

test("maintainNow: the inline path (no waitUntil, someone is waiting) runs no graph pass", async () => {
  const inline = await maintainedRun({ disableGraph: false, total: 400, defer: false });
  assert.ok(searchState(inline.b).length > 0, "the inline sync ran");
  assert.equal(inline.graphOps, 0);
  const deferred = await maintainedRun({ disableGraph: false, total: 400, defer: true });
  assert.ok(deferred.graphOps > 0, "the deferred path still runs it");
});

test("maintainNow: a graph failure does not reach the caller", async () => {
  const s = maintained({ disableGraph: true });
  await seed(s.b);
  s.budget = createSearchBudget(200);
  await assert.doesNotReject(maintainIndexAfter(s.store, s.budget, defaultIsIndexable, null).then(() => Promise.all(s.deferred)));
  assert.ok(searchState(s.b).length > 0);
  assert.deepEqual(graphKeys(s.b), []);
});

test("project.js still skips a current record (the sweep relies on the same predicate)", async () => {
  const b = bucket();
  await b.put("a.md", "x");
  await pass(b);
  const r = await projectNote(b, "a.md", "x", b.objects.get("a.md").etag, { budget: big(), gen, mode: "conditional", now });
  assert.equal(r.state, "skipped");
});
