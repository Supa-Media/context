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
 * Fix round 1 (red first: the five fix-round tests at the bottom and the
 * changed wraps-clean test, 6 failing). Counts over graphRebuild,
 * graphReconcile, graphManifest and graphWrite:
 *   GC delete failure escapes and aborts the pass                         1 (GC failure)
 *   failed collect never abandoned (limit Infinity)                       1 (GC failure)
 *   abandonment not logged                                                1 (GC failure)
 *   cutover without waiting for the audit listing                         1 (delete during build)
 *   audit listing not restarted at the first clean wrap                   1 (wraps clean)
 *   node audit restarts a node from 0 after a budget stop                 1 (grid: livelock at L=40)
 *   building generation never takes audit turns                           2 (delete during build, grid)
 *   cutover keeps rebuildHint                                             1 (rebuildHint)
 *   rebuild on any version difference                                     1 (two code versions)
 *   build into a building generation regardless of its versions           1 (two code versions)
 *   reconcile does not leave a newer manifest alone                       1 (two code versions)
 *   afterWrite writes into a newer generation                             1 (two code versions)
 *   an older code's build is not restarted                                1 (two code versions)
 *   graphHealth drops building                                            2 (health building, graphManifest
 *                                                                           complete shape)
 * The "measured zero" audit-turn gate above is superseded: a building
 * generation now takes audit turns once `recheck` is set, and that row bites.
 *
 * Fix round 2 (red first: the three fix-round-2 tests at the bottom; the
 * "GC takes the whole budget instead of half" row above is retired, a GC turn
 * now takes the whole pass and the bounded-page assert says 7). Counts over
 * every graph*.test.mjs:
 *   GC first on half the pass (the round 1 order, whole fix reverted)     2 (2,000 junk, 20,000 junk)
 *   GC halved again, order kept                                           1 (2,000 junk)
 *   no GC turn (GC only on what the sweep leaves)                         2 (2,000 junk, GC failure)
 *   no GC after the sweep (GC turn only)                                  1 (two code versions)
 *   older code publishes ready during a newer build                       1 (older code during a newer build)
 *
 * Helpers live in graphRebuildFixtures.mjs (split out in fix round 2 to keep
 * this file under the 700-line review threshold).
 *
 * Process note: tests written first; RED was every cutover-dependent test
 * ("no cutover to 2"). The crash test first threw from the store, which
 * reconciliation swallows as unreadable reads, so it never crashed; it now
 * stops the worker with ops that never return.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { abandonCollect } from "../src/graph/rebuild.js";
import { graphHealth } from "../src/graph/manifest.js";
import { projectNote, removeNote } from "../src/graph/project.js";
import { projectNoteAfterWrite } from "../src/graph/afterWrite.js";
import { RESOLVER_VERSION } from "../src/graph/facts.js";
import { generationPrefix, graphManifestKey, maintenanceCursorKey } from "../src/graph/keys.js";
import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { GRAPH_PASS_FLOOR } from "../src/search/pacing.js";
import {
  now, big, links, pad, bucket, paged, censusOf, pass, manifestOf, rawManifest, nodeIn, settledIn, backlinks,
  keysUnder, snapshot, bump, converge, rebuildTo, seed, audited, twoCutovers, refusingDeletes, capturingLogs,
  collecting, passesUntil, olderCode, scheduleCell,
} from "./graphRebuildFixtures.mjs";

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
// Fix round 1 added a full audit listing before cutover; measured worst
// case 44 of a bound of 50 (best-effort, B=18, K=0 L=40 J=10).
// Fix round 3 runs the turn cycle during the build too, so the build sweeps
// on half the passes: worst factor measured 2.31 (best-effort, B=15, K=0 L=40
// J=6: 70 passes), so GRID_FACTOR goes from 2 to 3.
const rebuildBound = (B, K, L, J) => 10 + GRID_FACTOR * Math.ceil((7 * (K + J + 1) + 2 * L) / Math.max(1, B - 10));
const GRID_FACTOR = 3;
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

test("a pass that wraps clean once does not cut over; the re-check wrap after a full audit listing does", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  await bump(b);
  await pass(b); // starts the build
  await pass(b); // sweeps generation 2 and wraps clean
  for (const p of ["a.md", "b.md", "c.md", "t.md", "u.md"]) assert.ok(await settledIn(b, "2", p), p);
  assert.equal(rawManifest(b).generation, "1", "no cutover on the first clean wrap");
  // The first clean wrap restarted the audit listing for the re-check.
  const cursor = JSON.parse(b.objects.get(maintenanceCursorKey("2")).body);
  assert.equal(cursor.auditWrapped, false);
  assert.equal(cursor.auditCursor, "");
  await pass(b); // the re-check wrap, then the audit lists the whole generation, then cutover
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
    // Fix round 2: a GC turn takes the whole pass: 13 less two reads, the wrap reserve (3) and the list.
    assert.ok(log.deleted.length - before <= 7, "bounded page per pass");
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

// Fix round 1

test("GC whose deletes always fail never blocks reconciliation, and collect is abandoned after bounded failures", async () => {
  for (const B of [13, 100000]) {
    const b = bucket();
    await twoCutovers(b);
    assert.equal(rawManifest(b).collect, "1");
    const left = keysUnder(b, generationPrefix("1")).length;
    const store = refusingDeletes(b, generationPrefix("1"));
    await b.put("new-note.md", links("t.md"));
    const logs = await capturingLogs(async () => {
      for (let i = 0; i < 40 && !(rawManifest(b).health.state === "ready" && (await settledIn(b, "3", "new-note.md"))); i += 1) {
        await pass(store, createSearchBudget(B)); // must not throw
      }
      for (let i = 0; i < 10; i += 1) await pass(store, createSearchBudget(B));
    });
    assert.ok(await settledIn(b, "3", "new-note.md"), `B=${B}: a new note still projects`);
    assert.equal(rawManifest(b).health.state, "ready", `B=${B}`);
    assert.deepEqual(await backlinks(b, "3", "t.md"), ["a.md", "b.md", "new-note.md"]);
    assert.equal(rawManifest(b).collect, null, `B=${B}: collect abandoned`);
    assert.equal(keysUnder(b, generationPrefix("1")).length, left, "the generation is left in place");
    assert.ok(logs.some((l) => l.includes("graph-gc-abandoned")), "abandonment is logged");
    for (const l of logs) assert.ok(!l.includes(".md"), `no note path in logs: ${l}`);
  }
});

test("a note deleted during the build with no removal hint has no node or backlink after cutover", async () => {
  const b = bucket();
  await b.put("a.md", links("t.md"));
  await b.put("t.md", "x");
  for (let i = 0; i < 20; i += 1) await b.put(`z${pad(i)}.md`, "plain");
  await converge(b);
  await bump(b);
  for (let i = 0; !(await nodeIn(b, "2", "a.md")); i += 1) {
    assert.ok(i < 100);
    await pass(b, createSearchBudget(13));
  }
  // Deleted through the gateway: the write path removes it from the pinned generation only.
  b.objects.delete("a.md");
  await removeNote(b, "a.md", { budget: big(), gen: "1", mode: "conditional" });
  for (let i = 0; rawManifest(b).generation !== "2"; i += 1) {
    assert.ok(i < 400, "cut over");
    await pass(paged(b), createSearchBudget(13));
  }
  assert.equal(await nodeIn(b, "2", "a.md"), null, "no node for the deleted note at cutover");
  assert.deepEqual(await backlinks(b, "2", "t.md"), []);
});

test("cutover clears rebuildHint, so the fresh generation can be complete; the hint alone starts no rebuild", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  const m = rawManifest(b);
  await b.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, rebuildHint: "reverse-repair-overflow" } }));
  for (let i = 0; i < 5; i += 1) await pass(b);
  assert.equal(rawManifest(b).building, null, "a hint does not start a rebuild");
  assert.equal(rawManifest(b).generation, "1");
  assert.equal((await graphHealth(b, big())).complete, false);
  await rebuildTo(b, "2");
  assert.equal(rawManifest(b).health.rebuildHint ?? null, null);
  assert.equal((await graphHealth(b, big())).complete, true);
});

test("two code versions on one bucket: newer versions are left alone and a building generation is used only by matching code", async () => {
  const newer = RESOLVER_VERSION + 1;
  // A newer client cut over: this (older) code neither rebuilds nor writes into it.
  {
    const b = bucket();
    await seed(b);
    await converge(b);
    await b.put(graphManifestKey(), JSON.stringify({ ...rawManifest(b), resolverVersion: newer }));
    const before = snapshot(b, GRAPH_PREFIX);
    await b.put("new-note.md", links("t.md"));
    const { store, log } = audited(b);
    for (let i = 0; i < 5; i += 1) await pass(store);
    await projectNoteAfterWrite(b, { path: "new-note.md", body: links("t.md"), version: b.objects.get("new-note.md").etag, budget: big() });
    assert.deepEqual(snapshot(b, GRAPH_PREFIX), before, "nothing under the graph prefix changed");
    assert.deepEqual(log.deleted, []);
  }
  // A newer client is building: this code keeps reconciling the active generation
  // and never builds into, cuts over or restarts that build.
  {
    const b = bucket();
    await seed(b);
    await converge(b);
    const building = { generation: "2", startedAt: "t", parserVersion: 1, resolverVersion: newer, urlKeyVersion: 1 };
    await b.put(graphManifestKey(), JSON.stringify({ ...rawManifest(b), building }));
    await b.put("new-note.md", links("t.md"));
    for (let i = 0; i < 8; i += 1) await pass(b);
    assert.deepEqual(rawManifest(b).building, building);
    assert.equal(rawManifest(b).generation, "1");
    assert.deepEqual(keysUnder(b, generationPrefix("2")), []);
    assert.ok(await settledIn(b, "1", "new-note.md"), "the active generation is still reconciled");
  }
  // An older client started a build: this code restarts it at its own versions
  // and the abandoned generation is collected.
  {
    const b = bucket();
    await seed(b);
    await converge(b);
    const stale = { generation: "2", startedAt: "t", parserVersion: 1, resolverVersion: RESOLVER_VERSION - 1, urlKeyVersion: 1 };
    await b.put(`${generationPrefix("2")}nodes/leftover.json`, "{}");
    await b.put(graphManifestKey(), JSON.stringify({ ...rawManifest(b), resolverVersion: RESOLVER_VERSION - 2, building: stale }));
    await pass(b);
    assert.equal(rawManifest(b).building.generation, "3");
    assert.equal(rawManifest(b).building.resolverVersion, RESOLVER_VERSION);
    for (let i = 0; i < 12 && (rawManifest(b).generation !== "3" || rawManifest(b).collect); i += 1) await pass(paged(b));
    assert.equal(rawManifest(b).generation, "3");
    assert.equal(rawManifest(b).resolverVersion, RESOLVER_VERSION);
    assert.deepEqual(keysUnder(b, generationPrefix("2")), [], "abandoned build collected");
  }
});

test("graphHealth names the building generation, or null", async () => {
  const b = bucket();
  await seed(b);
  await converge(b);
  assert.equal((await graphHealth(b, big())).building, null);
  await bump(b);
  await pass(b);
  const h = await graphHealth(b, big());
  assert.equal(h.building, "2");
  assert.equal(h.generation, "1");
  await rebuildTo(b, "2");
  assert.equal((await graphHealth(b, big())).building, null);
});

// Fix round 2

// Measured at B=11 (fix round 3 figures; round 2's in brackets): the new note
// projects in 5 [6] (cond) and 7 [8] (best-effort) passes with or without the
// junk, so the delay allowed is 0; the 2,000 junk keys are gone after 1,605
// (cond) and 1,151 (best-effort) more passes, so the bound is about twice the
// worst. 20,000 junk keys: projected and ready in 7 [4] and 9 [5] passes, cap 20.
const MAX_GC_DELAY = 0;
const GC_EMPTY_BOUND = 3300;

test("GC never starves the sweep: 2,000 junk keys in the collected generation delay no projection, and it still empties", async () => {
  assert.equal(GRAPH_PASS_FLOOR, 11);
  for (const conditional of [true, false]) {
    const counts = [];
    for (const junk of [0, 2000]) {
      const b = await collecting(conditional, junk);
      await b.put("new-note.md", links("t.md"));
      counts.push(await passesUntil(b, GRAPH_PASS_FLOOR, 200, () => settledIn(b, "3", "new-note.md")));
      if (junk === 0) continue;
      const emptied = await passesUntil(b, GRAPH_PASS_FLOOR, GC_EMPTY_BOUND, () => rawManifest(b).collect === null);
      assert.notEqual(emptied, null, `${conditional ? "cond" : "best"}: collect cleared within ${GC_EMPTY_BOUND}`);
      assert.deepEqual(keysUnder(b, generationPrefix("1")), []);
      assert.deepEqual(await backlinks(b, "3", "t.md"), ["a.md", "b.md", "new-note.md"]);
    }
    const [clean, junky] = counts;
    assert.ok(clean !== null && junky !== null && junky <= clean + MAX_GC_DELAY, `${conditional ? "cond" : "best"}: ${junky} vs ${clean}`);
  }
});

test("20,000 junk keys in the collected generation: a new note projects and health reaches ready in bounded passes", async () => {
  for (const conditional of [true, false]) {
    const b = await collecting(conditional, 20000);
    const m = rawManifest(b);
    await b.put(graphManifestKey(), JSON.stringify({ ...m, health: { ...m.health, state: "behind" } }));
    await b.put("new-note.md", links("t.md"));
    const done = async () => rawManifest(b).health.state === "ready" && (await settledIn(b, "3", "new-note.md"));
    assert.notEqual(await passesUntil(b, GRAPH_PASS_FLOOR, 20, done), null, conditional ? "cond" : "best");
  }
});

test("older code during a newer build reconciles the active generation but never publishes it complete", async () => {
  const b = bucket();
  await seed(b);
  for (let i = 0; i < 20; i += 1) await b.put(`z${pad(i)}.md`, "plain");
  await converge(b);
  await bump(b); // this code is now the newer one; olderCode(b) is the code it replaces
  const older = olderCode(b);
  const check = async (when) => {
    if (rawManifest(b).building) assert.equal((await graphHealth(b, big())).complete, false, when);
  };
  await pass(b, createSearchBudget(15)); // starts the build
  assert.equal(rawManifest(b).building.generation, "2");
  for (let i = 0; i < 5; i += 1) {
    await pass(older, createSearchBudget(100000));
    await check(`older pass ${i}`);
    await pass(b, createSearchBudget(15));
    await check(`newer pass ${i}`);
  }
  // Only the newer code runs from here; a note is deleted outside the gateway.
  b.objects.delete("z05.md");
  for (let i = 0; rawManifest(b).building; i += 1) {
    assert.ok(i < 400, "cut over");
    await pass(b, createSearchBudget(15));
    await check(`after the delete, pass ${i}`);
  }
  assert.equal(rawManifest(b).generation, "2");
  assert.equal(await nodeIn(b, "2", "z05.md"), null);
  assert.equal((await graphHealth(b, big())).complete, true);
});

// Fix round 3: the turn cycle runs whatever the health says, so no piece
// lives on leftovers. Measured: every cell finishes within 6N + 20 passes
// (worst: stuck, best-effort, B=11, N=1: 26), so the bound is 6N + 40.
// Health-keyed turns fail stuck and rollback cells (they never finish).
const scheduleBound = (B, N) => 40 + 6 * N;

test("GC and the audit progress for every census size whether health is ready, stuck behind, or behind after a rollback", async () => {
  const failures = [];
  for (const health of ["ready", "stuck", "rollback"]) {
    for (const conditional of [true, false]) {
      for (const B of [11, 13, 15]) {
        for (const N of [1, 2, 3, 5, 7, 8, 9, 15, 16, 17, 23, 24, 31, 40]) {
          const { gcAt, auditAt } = await scheduleCell(conditional, B, N, health, scheduleBound(B, N));
          if (gcAt === null || auditAt === null) failures.push(`${health} ${conditional ? "cond" : "best"} B=${B} N=${N}: gc ${gcAt} audit ${auditAt}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("abandonCollect logs graph-gc-abandoned only after its publish lands", async () => {
  const b = bucket();
  await twoCutovers(b);
  const refusing = { ...b, put: (k, v, o) => (k === graphManifestKey() ? Promise.resolve(null) : b.put(k, v, o)) };
  const refused = await capturingLogs(() => abandonCollect(refusing, big(), "1"));
  assert.equal(rawManifest(b).collect, "1");
  assert.ok(!refused.some((l) => l.includes("graph-gc-abandoned")), "no log for a refused publish");
  const landed = await capturingLogs(() => abandonCollect(b, big(), "1"));
  assert.equal(rawManifest(b).collect, null);
  assert.ok(landed.some((l) => l.includes("graph-gc-abandoned")));
});

