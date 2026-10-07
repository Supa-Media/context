/**
 * Rebuild generations, cutover and old-generation garbage collection
 * (`src/graph/rebuild.js`, wired in `src/graph/reconcile.js`; arch 9.6,
 * controller rulings OPEN-16 and OPEN-22).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   cutover on the first clean wrap (no re-check pass)                    5 (edit during build, wraps once,
 *                                                                           pending, bump, hostile collect)
 *   cutover even when the re-check wrap left work pending                 1 (pending)
 *   cutover on a truncated census                                         1 (truncated)
 *   re-check treats an existing node as current (write during build lost) 2 (edit during build, pending)
 *   readers switched to the new generation at build start                14 (readers pinned, crash, ...)
 *   GC may delete the serving generation                                  1 (hostile collect)
 *   GC may delete the building or retained generation                     1 (hostile collect)
 *   GC without the conditionalDelete check                                1 (no conditionalDelete)
 *   GC prefix widened to GRAPH_PREFIX                                     2 (retention, pending)
 *   GC takes the whole budget instead of half                             1 (retention: bounded page)
 *   collect never cleared                                                 1 (retention)
 *   cutover does not hand the old previous to collect                     1 (retention)
 *   generation incremented with Number                                    1 (2^53)
 *   active health left as is during the build                             1 (bump)
 *
 * Measured zero, kept: the building generation taking audit turns keyed on
 * the active generation's health (the grid still converges within its bound;
 * the gate stays because that health says nothing about a building
 * generation). "recheck set after a pending wrap" alone was also zero: the
 * cutover branch's own state check masks it, and the row above it is that
 * guard's sabotage.
 *
 * Process note: tests written first; RED was every cutover-dependent test
 * ("no cutover to 2"). The crash test first threw from the store, which
 * reconciliation swallows as unreadable reads, so it never crashed; it now
 * stops the worker with ops that never return.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { graphHealth, loadGraphManifest } from "../src/graph/manifest.js";
import { projectNote, validateEntry } from "../src/graph/project.js";
import { projectNoteAfterWrite } from "../src/graph/afterWrite.js";
import { readPostings } from "../src/graph/postings.js";
import { RESOLVER_VERSION } from "../src/graph/facts.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey, nodeKey, pathHash } from "../src/graph/keys.js";
import { parseNode } from "../src/graph/records.js";
import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

const now = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const links = (...targets) => targets.map((t) => `[${t}](./${t})`).join(" ");
const pad = (i) => String(i).padStart(3, "0");

function bucket({ conditional = true, conditionalDelete = true } = {}) {
  const b = memoryBucket();
  b.capabilities = conditional
    ? { conditionalWrite: true, conditionalCreate: true, conditionalDelete }
    : { conditionalDelete };
  return b;
}
/** A view of `b` whose `list` honours `limit` and `cursor` like R2 does. */
function paged(b) {
  return {
    ...b,
    async list(options = {}) {
      const all = (await b.list({ prefix: options.prefix })).objects;
      const start = options.cursor ? Number(options.cursor) : 0;
      const end = options.limit ? start + options.limit : all.length;
      const truncated = end < all.length;
      return { objects: all.slice(start, end), truncated, ...(truncated && { cursor: String(end) }) };
    },
  };
}
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
const manifestOf = (b) => loadGraphManifest(b, big());
const rawManifest = (b) => JSON.parse(b.objects.get(graphManifestKey()).body);
const nodeIn = async (b, gen, path) => {
  const got = await b.get(nodeKey(gen, await pathHash(path)));
  return got ? parseNode(await got.text(), path) : null;
};
const settledIn = async (b, gen, path) => {
  const n = await nodeIn(b, gen, path);
  return n !== null && n.observedSourceVersion === b.objects.get(path).etag && n.reverseRepair.length === 0;
};
/** Validated backlinks of `target` as a reader pinned to `gen` sees them. */
const backlinks = async (b, gen, target) => {
  const { entries } = await readPostings(b, big(), {
    gen, family: "incoming", hash: await pathHash(target), canSee: () => true, validate: validateEntry(b, big(), gen),
  });
  return entries.map((e) => e.source).sort();
};
const keysUnder = (b, prefix) => [...b.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
const snapshot = (b, prefix) => keysUnder(b, prefix).map((k) => `${k}=${b.objects.get(k).body}`);

/** Simulate deploying code with a newer resolver: the manifest names an older one. */
async function bump(b) {
  const m = rawManifest(b);
  await b.put(graphManifestKey(), JSON.stringify({ ...m, resolverVersion: RESOLVER_VERSION - 1 }));
}
async function converge(b, budget = big) {
  for (let i = 0; i < 10; i += 1) {
    await pass(b, budget());
    if ((await manifestOf(b))?.health.state === "ready") return;
  }
  assert.fail("did not converge");
}
/** Bump and pass at a big budget until `gen` is serving. */
async function rebuildTo(b, gen, store = b) {
  await bump(b);
  for (let i = 0; i < 10; i += 1) {
    await pass(store);
    if ((await manifestOf(b)).generation === gen) return;
  }
  assert.fail(`no cutover to ${gen}`);
}

async function seed(b) {
  await b.put("a.md", links("t.md", "u.md"));
  await b.put("b.md", links("t.md"));
  await b.put("c.md", "no links");
  await b.put("t.md", links("a.md"));
  await b.put("u.md", "plain");
}

test("a fresh manifest records the running versions and starts no rebuild", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  const m = rawManifest(b);
  assert.equal(m.resolverVersion, RESOLVER_VERSION);
  assert.equal(m.building, null);
  await pass(b);
  assert.equal(rawManifest(b).building, null);
  assert.equal(rawManifest(b).generation, "1");
});

test("a resolver-version bump starts a rebuild into generation active + 1, active keeps serving", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await bump(b);
  await pass(b);
  const m = rawManifest(b);
  assert.equal(m.generation, "1");
  assert.equal(m.building.generation, "2");
  assert.equal(m.building.resolverVersion, RESOLVER_VERSION);
  // The active generation is no longer reconciled during the build: honest health.
  assert.equal((await graphHealth(b, big())).complete, false);
  // A second pass builds into 2; it neither restarts the build nor cuts over yet.
  await pass(b);
  assert.equal(rawManifest(b).generation, "1");
  assert.equal(rawManifest(b).building.generation, "2");
});

test("a generation past 2^53 still increments exactly", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await b.put(graphManifestKey(), JSON.stringify({ ...rawManifest(b), generation: "9007199254740993", resolverVersion: 0 }));
  await pass(b);
  assert.equal(rawManifest(b).building.generation, "9007199254740994");
});

test("cutover swaps generation, clears building, records the new versions and keeps the old generation", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  const old = snapshot(b, generationPrefix("1"));
  await rebuildTo(b, "2");
  const m = rawManifest(b);
  assert.equal(m.building, null);
  assert.equal(m.previous, "1");
  assert.equal(m.resolverVersion, RESOLVER_VERSION);
  assert.equal(m.health.state, "ready");
  assert.equal((await graphHealth(b, big())).complete, true);
  assert.deepEqual(await backlinks(b, "2", "t.md"), ["a.md", "b.md"]);
  for (const p of ["a.md", "b.md", "c.md", "t.md", "u.md"]) assert.ok(await settledIn(b, "2", p), p);
  // Retained until the next cutover (OPEN-22); a pinned reader still answers.
  assert.deepEqual(snapshot(b, generationPrefix("1")).filter((s) => !s.includes("maintenance/")), old.filter((s) => !s.includes("maintenance/")));
  assert.deepEqual(await backlinks(b, "1", "t.md"), ["a.md", "b.md"]);
  // No rebuild after a clean cutover.
  await pass(b);
  assert.equal(rawManifest(b).building, null);
});

// Convergence grid (Task 10 style): K plain notes, `m.md` with L links, J
// plain notes after it; generation 1 converged first, then a resolver bump.
const hubBody = (n) => Array.from({ length: n }, (_, i) => `[t${i}](./t${i}.md)`).join(" ");
async function rebuildGridPasses(conditional, B, K, L, J, max) {
  const b = bucket({ conditional });
  const paths = [];
  for (let i = 0; i < K; i += 1) paths.push(`a${pad(i)}.md`);
  paths.push("m.md");
  for (let i = 0; i < J; i += 1) paths.push(`z${pad(i)}.md`);
  for (const p of paths) await b.put(p, p === "m.md" ? hubBody(L) : "plain");
  await converge(b);
  await bump(b);
  for (let passes = 1; passes <= max; passes += 1) {
    const budget = createSearchBudget(B);
    await pass(b, budget);
    assert.ok(budget.spent <= B, `spent ${budget.spent} > ${B}`);
    const m = rawManifest(b);
    if (m.generation !== "2") continue;
    // At the cutover itself every census path is current in the new generation.
    for (const p of paths) assert.ok(await settledIn(b, "2", p), `cut over with ${p} unsettled (B=${B})`);
    assert.equal(m.health.state, "ready");
    return passes;
  }
  return null;
}
// Ops per note as in Task 10 (6 plus two per link) for the build, plus one
// node read per note for the re-check wrap, over about B - 10 ops a pass.
const rebuildBound = (B, K, L, J) => 10 + GRID_FACTOR * Math.ceil((7 * (K + J + 1) + 2 * L) / Math.max(1, B - 10));
const GRID_FACTOR = 2;
const GRID_LAYOUTS = [[0, 1, 6], [6, 1, 0], [6, 1, 6], [20, 1, 30], [70, 1, 3], [0, 40, 6], [0, 40, 10]];

test("a rebuild converges at fixed small budgets in both modes and cuts over only on a settled generation", async () => {
  const failures = [];
  for (const conditional of [true, false]) {
    for (const B of [11, 12, 13, 15, 18, 24, 40, 80]) {
      for (const [K, L, J] of GRID_LAYOUTS) {
        const bound = rebuildBound(B, K, L, J);
        if ((await rebuildGridPasses(conditional, B, K, L, J, bound)) === null) {
          failures.push(`${conditional ? "cond" : "best"} B=${B} K=${K} L=${L} J=${J} (bound ${bound})`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("readers pinned to the active generation keep reading it until cutover", async () => {
  const b = bucket();
  await seed(b);
  for (let i = 0; i < 20; i += 1) await b.put(`z${pad(i)}.md`, "plain");
  await converge(b);
  await bump(b);
  let building = 0;
  for (let passes = 0; passes < 200; passes += 1) {
    await pass(b, createSearchBudget(13));
    const m = await manifestOf(b);
    if (m.generation === "2") break;
    if (m.building) building += 1;
    assert.equal(m.generation, "1");
    assert.deepEqual(await backlinks(b, m.generation, "t.md"), ["a.md", "b.md"], `pass ${passes}`);
  }
  assert.ok(building > 3, "the build spanned several passes");
  const m = await manifestOf(b);
  assert.equal(m.generation, "2");
  assert.deepEqual(await backlinks(b, m.generation, "t.md"), ["a.md", "b.md"]);
});

test("an edit made during the build, after the sweep passed the note, is correct at cutover (re-check)", async () => {
  const b = bucket();
  await seed(b);
  for (let i = 0; i < 20; i += 1) await b.put(`z${pad(i)}.md`, "plain");
  await converge(b);
  await bump(b);
  // Build until a.md is settled in generation 2 and the first wrap is still ahead.
  for (let passes = 0; ; passes += 1) {
    assert.ok(passes < 100, "a.md reached");
    await pass(b, createSearchBudget(13));
    if (await settledIn(b, "2", "a.md")) break;
  }
  const cursor = JSON.parse(b.objects.get(maintenanceCursorKey("2")).body);
  assert.notEqual(cursor.sweepCursor, "", "first wrap not finished");
  assert.equal((await manifestOf(b)).generation, "1");
  // The write projects into the generation it pinned: the active one.
  await b.put("a.md", links("c.md"));
  const etag = b.objects.get("a.md").etag;
  await projectNoteAfterWrite(b, { path: "a.md", body: links("c.md"), version: etag, budget: big() });
  assert.deepEqual(await backlinks(b, "1", "c.md"), ["a.md"]);
  for (let passes = 0; (await manifestOf(b)).generation !== "2"; passes += 1) {
    assert.ok(passes < 200, "cut over");
    await pass(b, createSearchBudget(13));
  }
  assert.ok(await settledIn(b, "2", "a.md"), "edit reflected at the cutover");
  assert.deepEqual(await backlinks(b, "2", "c.md"), ["a.md"]);
  assert.deepEqual(await backlinks(b, "2", "t.md"), ["b.md"]);
});

test("a write pinned to the old generation across the swap is repaired in the new one by the next pass", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  const pinned = (await manifestOf(b)).generation; // a writer read the manifest here
  await rebuildTo(b, "2");
  await b.put("b.md", links("u.md"));
  const etag = b.objects.get("b.md").etag;
  await projectNote(b, "b.md", links("u.md"), etag, { budget: big(), gen: pinned, mode: "conditional", now });
  assert.equal(await settledIn(b, "2", "b.md"), false, "new generation stale until the census diff");
  await pass(b);
  assert.ok(await settledIn(b, "2", "b.md"));
  assert.deepEqual(await backlinks(b, "2", "u.md"), ["a.md", "b.md"]);
  assert.deepEqual(await backlinks(b, "2", "t.md"), ["a.md"]);
});

test("a truncated census never cuts over", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await bump(b);
  for (let i = 0; i < 10; i += 1) await pass(b, big(), { censusComplete: false });
  const m = rawManifest(b);
  assert.equal(m.generation, "1");
  assert.equal(m.building.generation, "2");
  for (let i = 0; i < 3; i += 1) await pass(b);
  assert.equal(rawManifest(b).generation, "2");
});

test("a building generation whose wraps leave work pending never cuts over", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await bump(b);
  let failing = true;
  const flaky = { ...b, get: (k) => (failing && k === "c.md" ? Promise.reject(new Error("read failed")) : b.get(k)) };
  for (let i = 0; i < 10; i += 1) await pass(flaky);
  assert.equal(rawManifest(b).generation, "1");
  assert.equal(rawManifest(b).building.generation, "2");
  failing = false;
  for (let i = 0; i < 3; i += 1) await pass(flaky);
  assert.equal(rawManifest(b).generation, "2");
  assert.ok(await settledIn(b, "2", "c.md"));
  // A clean wrap, then a re-check that leaves work pending: still no cutover.
  await bump(b);
  await pass(flaky); // starts building 3
  await pass(flaky); // clean wrap
  await b.put("c.md", links("u.md"));
  failing = true;
  for (let i = 0; i < 5; i += 1) await pass(flaky);
  assert.equal(rawManifest(b).generation, "2");
  failing = false;
  for (let i = 0; i < 3; i += 1) await pass(flaky);
  assert.equal(rawManifest(b).generation, "3");
  assert.ok(await settledIn(b, "3", "c.md"));
});

test("a pass that wraps clean once does not cut over; the re-check wrap does", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await bump(b);
  await pass(b); // starts the build
  await pass(b); // sweeps generation 2 and wraps clean
  for (const p of ["a.md", "b.md", "c.md", "t.md", "u.md"]) assert.ok(await settledIn(b, "2", p), p);
  assert.equal(rawManifest(b).generation, "1", "no cutover on the first clean wrap");
  await pass(b); // the re-check wrap
  assert.equal(rawManifest(b).generation, "2");
});

test("a crash mid-build leaves the old generation serving, and the build resumes", async () => {
  const b = bucket();
  await seed(b);
  for (let i = 0; i < 10; i += 1) await b.put(`z${pad(i)}.md`, "plain");
  await converge(b);
  await bump(b);
  await pass(b);
  let crashes = 0;
  for (let ops = 3; ops < 60; ops += 2) {
    // The worker is killed at op `ops`: that op and every later one never return.
    let n = 0;
    let killedAt;
    const hung = new Promise((r) => { killedAt = r; });
    const op = (fn) => ((n += 1) > ops ? (killedAt(true), new Promise(() => {})) : fn());
    const crashing = {
      ...b,
      get: (k) => op(() => b.get(k)),
      put: (k, v, o) => op(() => b.put(k, v, o)),
      delete: (k, o) => op(() => b.delete(k, o)),
      list: (o) => op(() => b.list(o)),
    };
    const run = reconcileGraph(crashing, big(), { census: censusOf(b), censusComplete: true, removedHints: [], isIndexable: defaultIsIndexable, now });
    const killed = await Promise.race([run.then(() => false), hung]);
    if (!killed) break; // a pass that finished is not a crash
    crashes += 1;
    const m = await manifestOf(b);
    assert.equal(m.generation, "1", `serving after a crash at op ${ops}`);
    assert.equal(m.building.generation, "2");
    assert.deepEqual(await backlinks(b, "1", "t.md"), ["a.md", "b.md"]);
  }
  assert.ok(crashes > 5, `crashes ${crashes}`);
  for (let i = 0; i < 5 && (await manifestOf(b)).generation !== "2"; i += 1) await pass(b);
  assert.equal((await manifestOf(b)).generation, "2");
  assert.deepEqual(await backlinks(b, "2", "t.md"), ["a.md", "b.md"]);
});

test("a newer-format manifest is never rebuilt, cut over or collected", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await rebuildTo(b, "2");
  await rebuildTo(b, "3");
  const newer = JSON.stringify({ ...rawManifest(b), formatVersion: 2, resolverVersion: 0, building: { generation: "4", startedAt: "x" }, collect: "1" });
  await b.put(graphManifestKey(), newer);
  const before = snapshot(b, GRAPH_PREFIX).filter((s) => !s.startsWith(graphManifestKey()));
  for (let i = 0; i < 5; i += 1) await pass(paged(b));
  assert.equal(b.objects.get(graphManifestKey()).body, newer);
  assert.deepEqual(snapshot(b, GRAPH_PREFIX).filter((s) => !s.startsWith(graphManifestKey())), before);
});

/** Records every delete and every write outside the graph prefix. */
function audited(b) {
  const log = { deleted: [], outside: [] };
  const store = {
    ...paged(b),
    put: (k, v, o) => { if (!k.startsWith(GRAPH_PREFIX)) log.outside.push(k); return b.put(k, v, o); },
    delete: (k, o) => { log.deleted.push(k); if (!k.startsWith(GRAPH_PREFIX)) log.outside.push(k); return b.delete(k, o); },
  };
  return { store, log };
}
async function twoCutovers(b) {
  await seed(b);
  await b.put(".context/forwarding.json", "{\"fake\":true}");
  await b.put(".context/search/manifest.json", "{\"fake\":true}");
  // A decoy generation whose prefix shares the digit: g/10/ is not g/1/.
  await b.put(`${generationPrefix("10")}nodes/decoy.json`, "{}");
  await converge(b);
  await rebuildTo(b, "2");
  await rebuildTo(b, "3");
}

test("GC after the second cutover deletes only g/<old>/ in bounded pages and nothing else", async () => {
  const b = bucket();
  await twoCutovers(b);
  assert.equal(rawManifest(b).collect, "1");
  assert.ok(keysUnder(b, generationPrefix("1")).length > 5);
  const keep = [
    ...snapshot(b, generationPrefix("2")),
    ...snapshot(b, `${generationPrefix("10")}`),
    `${b.objects.get(".context/forwarding.json").body}`,
    `${b.objects.get(".context/search/manifest.json").body}`,
  ];
  const { store, log } = audited(b);
  for (let i = 0; i < 40 && rawManifest(b).collect; i += 1) {
    const budget = createSearchBudget(13);
    const before = log.deleted.length;
    await pass(store, budget);
    assert.ok(budget.spent <= 13);
    assert.ok(log.deleted.length - before <= 6, "bounded page per pass");
  }
  assert.equal(rawManifest(b).collect, null, "collect cleared when g/1/ is empty");
  assert.deepEqual(keysUnder(b, generationPrefix("1")), []);
  for (const k of log.deleted) assert.ok(k.startsWith(generationPrefix("1")), k);
  assert.deepEqual(log.outside, []);
  assert.deepEqual([
    ...snapshot(b, generationPrefix("2")),
    ...snapshot(b, `${generationPrefix("10")}`),
    `${b.objects.get(".context/forwarding.json").body}`,
    `${b.objects.get(".context/search/manifest.json").body}`,
  ], keep);
  assert.equal(rawManifest(b).generation, "3");
  assert.deepEqual(await backlinks(b, "3", "t.md"), ["a.md", "b.md"]);
});

test("GC on a store without conditionalDelete deletes nothing", async () => {
  const b = bucket({ conditionalDelete: false });
  await twoCutovers(b);
  const before = snapshot(b, generationPrefix("1"));
  const { store, log } = audited(b);
  for (let i = 0; i < 10; i += 1) await pass(store);
  assert.deepEqual(log.deleted, []);
  assert.deepEqual(snapshot(b, generationPrefix("1")), before);
});

test("GC refuses a collect naming the serving, building or previous generation, or a non-generation", async () => {
  for (const hostile of ["3", "2", "4", "../", "", 1]) {
    const b = bucket();
    await twoCutovers(b);
    const m = rawManifest(b);
    await b.put(graphManifestKey(), JSON.stringify({ ...m, collect: hostile, building: { generation: "4", startedAt: "t", parserVersion: 1, resolverVersion: RESOLVER_VERSION, urlKeyVersion: 1 } }));
    const { store, log } = audited(b);
    await pass(store); // builds g/4/ and wraps once: no cutover, so only GC could delete
    assert.equal(rawManifest(b).generation, "3");
    assert.deepEqual(log.deleted, [], `collect ${JSON.stringify(hostile)}`);
  }
});

test("nothing outside .context/graph/ is written or deleted through a rebuild, two cutovers and GC", async () => {
  const b = bucket();
  const { store, log } = audited(b);
  await seed(b);
  await converge(store);
  await rebuildTo(b, "2", store);
  await rebuildTo(b, "3", store);
  for (let i = 0; i < 10; i += 1) await pass(store, createSearchBudget(15));
  assert.deepEqual(log.outside, []);
});
