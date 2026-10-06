/**
 * Forward publish plus reverse repair (`src/graph/project.js`, arch 9.4).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   repairs run before the node publish                                    3
 *   obligations not published (reverseRepair cleared up front)              6
 *   "full" treated as a stop                                                1 (full)
 *   validateEntry accepts a stale referenceSetVersion                       1 (delayed write)
 *   clear written without the version condition (unconditional)            1 (clear never erases)
 *   old reverseRepair not merged                                            4 (incl. merge, interrupted)
 *   unchanged source not skipped                                            1
 *   hostile occurrences not caught                                          1 (hostile)
 *   stored reverseRepair refs not validated                                 1 (hostile)
 *   "conflict" stops processing                                             2
 *   reverseRepair cleared despite a conflicting posting                     1
 *   record not fitted to the cap                                            1 (overflow)
 *   overflow sets no rebuild hint                                           1 (overflow)
 *   validateEntry accepts an excluded source                                1
 *   tombstone never skipped by removeNote                                   1
 *   delete used without conditionalDelete                                   1
 *
 * Process note: tests written first; RED was the missing module.
 *
 * Fix round 1 (red first: the two race tests and the fixture delete test):
 *   refused clear/delete not handed back (returns "stale")                  3
 *   hand-back keeps only the newer record's keys (drops ours)               2
 *   memory fixture delete ignores onlyIf.etagMatches                        2
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { projectNote, removeNote, validateEntry } from "../src/graph/project.js";
import { initGraphManifest, loadGraphManifest } from "../src/graph/manifest.js";
import { setMembership, readPostings, MAX_POSTING_PAGES } from "../src/graph/postings.js";
import { nodeKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { POSTING_PAGE_SIZE, parseNode, serializePage } from "../src/graph/records.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

const gen = "1";
const mode = "conditional";
const now = 1_700_000_000_000;
const big = () => createSearchBudget(100000);
const project = (store, path, body, version, budget = big(), extra = {}) =>
  projectNote(store, path, body, version, { budget, gen, mode, now, ...extra });
const links = (...targets) => targets.map((t) => `[${t}](./${t})`).join(" ");
const node = async (store, path) => {
  const got = await store.get(nodeKey(gen, await pathHash(path)));
  return got ? parseNode(await got.text(), path) : null;
};
/** Raw sources in the target's `incoming/` posting, no validation. */
const incoming = async (store, target) => {
  const { entries } = await readPostings(store, big(), {
    gen, family: "incoming", hash: await pathHash(target), canSee: () => true, validate: () => true,
  });
  return entries.map((e) => e.source).sort();
};
/** Records every put key in order and can run a hook before a chosen put. */
function spy(bucket) {
  const s = { puts: [], hook: null };
  s.store = {
    capabilities: bucket.capabilities,
    get: (k) => bucket.get(k),
    delete: (k, o) => bucket.delete(k, o),
    async put(k, v, o) {
      s.puts.push(k);
      if (s.hook && (await s.hook(k, v))) s.hook = null;
      return bucket.put(k, v, o);
    },
  };
  return s;
}

test("concurrent projections of two sources linking one target both land", async () => {
  const b = memoryBucket();
  const [x, y] = await Promise.all([
    project(b, "a.md", links("t.md"), "va1"),
    project(b, "b.md", links("t.md"), "vb1"),
  ]);
  assert.deepEqual([x.state, y.state], ["projected", "projected"]);
  assert.deepEqual(await incoming(b, "t.md"), ["a.md", "b.md"]);
  assert.deepEqual((await node(b, "a.md")).reverseRepair, []);
});

test("an edit that removes a link removes its membership", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md", "u.md"), "v1");
  assert.equal((await project(b, "a.md", links("u.md"), "v2")).state, "projected");
  assert.deepEqual(await incoming(b, "t.md"), []);
  assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
});

test("an unchanged source is skipped for exactly one store op", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md"), "v1");
  const budget = big();
  assert.equal((await project(b, "a.md", links("t.md"), "v1", budget)).state, "skipped");
  assert.equal(budget.spent, 1);
});

test("the node record is published before any posting is touched", async () => {
  const b = memoryBucket();
  const s = spy(b);
  await project(s.store, "a.md", links("t.md", "u.md"), "v1");
  const key = nodeKey(gen, await pathHash("a.md"));
  assert.equal(s.puts[0], key);
  assert.equal(s.puts.at(-1), key, "the clear is the last write");
  assert.ok(s.puts.slice(1, -1).every((k) => k !== key));
});

test("interrupted cleanup: a stop at every budget is finished by a second identical call", async () => {
  // Full run cost, to sweep every stopping point up to it.
  const ref = memoryBucket();
  await project(ref, "a.md", links("t.md", "u.md", "w.md"), "v1");
  const full = big();
  await project(ref, "a.md", links("u.md", "x.md"), "v2", full);
  for (let n = 0; n <= full.spent; n += 1) {
    const b = memoryBucket();
    await project(b, "a.md", links("t.md", "u.md", "w.md"), "v1");
    const first = await project(b, "a.md", links("u.md", "x.md"), "v2", createSearchBudget(n));
    const after = await node(b, "a.md");
    if (first.state === "pending" && after.observedSourceVersion === "v2") {
      assert.ok(after.reverseRepair.length > 0, `budget ${n}: obligations kept while pending`);
    }
    const second = await project(b, "a.md", links("u.md", "x.md"), "v2");
    assert.ok(["projected", "skipped"].includes(second.state), `budget ${n}: ${second.state}`);
    const done = await node(b, "a.md");
    assert.equal(done.observedSourceVersion, "v2");
    assert.deepEqual(done.reverseRepair, []);
    assert.deepEqual(await incoming(b, "t.md"), [], `budget ${n}`);
    assert.deepEqual(await incoming(b, "w.md"), [], `budget ${n}`);
    assert.deepEqual(await incoming(b, "u.md"), ["a.md"], `budget ${n}`);
    assert.deepEqual(await incoming(b, "x.md"), ["a.md"], `budget ${n}`);
  }
});

test("interrupted cleanup: the clear never erases a newer record's obligations", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md"), "v1");
  const s = spy(b);
  const key = nodeKey(gen, await pathHash("a.md"));
  let newer;
  s.hook = async (k, v) => {
    if (k !== key || JSON.parse(v).reverseRepair.length !== 0) return false;
    // A newer edit lands between the repairs and the clear and runs out of
    // budget right after publishing its own obligations.
    newer = await project(b, "a.md", links("w.md"), "v3", createSearchBudget(2));
    return true;
  };
  const older = await project(s.store, "a.md", links("u.md"), "v2");
  assert.equal(newer.state, "pending");
  // Fix round 1 ruling: a refused clear hands its keys back and reports "pending".
  assert.equal(older.state, "pending");
  const kept = await node(b, "a.md");
  assert.equal(kept.observedSourceVersion, "v3");
  assert.ok(kept.reverseRepair.length > 0);
  assert.equal((await project(b, "a.md", links("w.md"), "v3")).state, "projected");
  assert.deepEqual(await incoming(b, "u.md"), []);
  assert.deepEqual(await incoming(b, "w.md"), ["a.md"]);
});

test("a newer edit merges outstanding cleanup instead of erasing it", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md"), "v1");
  // v2 drops t.md but stops right after publishing its obligations.
  assert.equal((await project(b, "a.md", "no links", "v2", createSearchBudget(2))).state, "pending");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
  assert.equal((await project(b, "a.md", "still none", "v3")).state, "projected");
  assert.deepEqual(await incoming(b, "t.md"), []);
});

test("a conflicting posting is left outstanding while the others are repaired", async () => {
  const b = memoryBucket();
  const tKey = postingPageKey(gen, "incoming", await pathHash("t.md"), 0);
  await b.put(tKey, "{not json");
  assert.equal((await project(b, "a.md", links("t.md", "u.md"), "v1")).state, "pending");
  assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
  assert.ok((await node(b, "a.md")).reverseRepair.length > 0);
  await b.delete(tKey);
  assert.equal((await project(b, "a.md", links("t.md", "u.md"), "v1")).state, "projected");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
});

test("a full posting is skipped, the node is partial, and the rest still land", async () => {
  const b = memoryBucket();
  const hash = await pathHash("t.md");
  for (let n = 0; n < MAX_POSTING_PAGES; n += 1) {
    const key = postingPageKey(gen, "incoming", hash, n);
    const entries = Array.from({ length: POSTING_PAGE_SIZE }, (_, i) => ({ source: `s${n}-${i}.md`, referenceSetVersion: "r" }));
    await b.put(key, serializePage({ key, entries, ...(n + 1 < MAX_POSTING_PAGES && { next: String(n + 1) }) }));
  }
  assert.equal((await project(b, "a.md", links("t.md", "u.md"), "v1")).state, "projected");
  const rec = await node(b, "a.md");
  assert.equal(rec.coverage, "partial");
  assert.deepEqual(rec.reverseRepair, []);
  assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
});

test("validateEntry rejects an older delayed membership write after a newer projection", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md"), "v1");
  const v1 = (await node(b, "a.md")).referenceSetVersion;
  await project(b, "a.md", links("t.md", "u.md"), "v2");
  const hash = await pathHash("t.md");
  const read = () => readPostings(b, big(), {
    gen, family: "incoming", hash, canSee: () => true, validate: validateEntry(b, big(), gen),
  });
  assert.deepEqual((await read()).entries.map((e) => e.source), ["a.md"]);
  // The delayed write from the v1 projection lands late.
  assert.equal(await setMembership(b, big(), {
    gen, family: "incoming", hash, source: "a.md", referenceSetVersion: v1, present: true, mode,
  }), "done");
  const { entries, complete } = await read();
  assert.deepEqual(entries, []);
  assert.equal(complete, true);
});

test("validateEntry rejects a missing, unparseable or excluded source and reports a budget stop", async () => {
  const b = memoryBucket();
  await project(b, "enc.md", "---\ncontext_encryption: v1\n---\nsecret", "v1");
  const enc = await node(b, "enc.md");
  assert.equal(enc.coverage, "excluded");
  const validate = validateEntry(b, big(), gen);
  assert.equal(await validate({ source: "enc.md", referenceSetVersion: enc.referenceSetVersion }), false);
  assert.equal(await validate({ source: "ghost.md", referenceSetVersion: "r" }), false);
  await b.put(nodeKey(gen, await pathHash("bad.md")), "{not json");
  assert.equal(await validate({ source: "bad.md", referenceSetVersion: "r" }), false);
  await project(b, "ok.md", links("t.md"), "v1");
  const ok = await node(b, "ok.md");
  assert.equal(await validate({ source: "ok.md", referenceSetVersion: ok.referenceSetVersion }), true);
  await assert.rejects(validateEntry(b, createSearchBudget(0), gen)({ source: "ok.md", referenceSetVersion: ok.referenceSetVersion }));
});

test("an edit to encrypted removes every prior membership", async () => {
  const b = memoryBucket();
  await project(b, "a.md", `${links("t.md")} [e](https://example.com/page)`, "v1");
  assert.deepEqual(await incoming(b, "t.md"), ["a.md"]);
  assert.equal((await project(b, "a.md", "---\ncontext_encryption: v1\n---\nciphertext", "v2")).state, "projected");
  const rec = await node(b, "a.md");
  assert.equal(rec.coverage, "excluded");
  const pages = [...b.objects.entries()].filter(([k]) => k.includes("/incoming/") || k.includes("/urls/") || k.includes("/names/"));
  assert.ok(pages.length >= 3);
  for (const [, { body }] of pages) assert.deepEqual(JSON.parse(body).entries, []);
});

test("a hostile node record or page never throws out of projectNote", async () => {
  const b = memoryBucket();
  const key = nodeKey(gen, await pathHash("a.md"));
  const hostile = [
    "{not json",
    JSON.stringify({ formatVersion: 1, path: "a.md", occurrences: [null, 7, { kind: "link" }], externalReferences: [], coverage: "complete",
      observedSourceVersion: "v1", reverseRepair: [{ family: "../x", hash: "zz" }, 5, null, { family: "incoming" }] }),
    JSON.stringify({ formatVersion: 1, path: "a.md", occurrences: [], externalReferences: [], coverage: "complete", reverseRepair: "nope" }),
  ];
  await b.put(postingPageKey(gen, "incoming", await pathHash("t.md"), 0), JSON.stringify({ formatVersion: 1, key: "wrong", entries: 3 }));
  for (const text of hostile) {
    await b.put(key, text);
    const { state } = await project(b, "a.md", links("t.md", "u.md"), "v1");
    assert.ok(["projected", "pending"].includes(state));
    assert.ok(await node(b, "a.md"), "a parseable record replaces the hostile one");
    assert.deepEqual(await incoming(b, "u.md"), ["a.md"]);
  }
});

test("a reverseRepair over the record cap keeps the record readable, partial, and flags a rebuild", async () => {
  const b = memoryBucket();
  b.capabilities = { conditionalWrite: true, conditionalCreate: true };
  await initGraphManifest(b, big(), { mode, now });
  const targets = Array.from({ length: 4000 }, (_, i) => `n${i}.md`);
  // Stop right after the publish: the obligations live only in the record.
  const { state } = await project(b, "a.md", links(...targets), "v1", createSearchBudget(4));
  assert.equal(state, "pending");
  const rec = await node(b, "a.md");
  assert.ok(rec, "record still parses under the cap");
  assert.equal(rec.coverage, "partial");
  assert.ok(rec.reverseRepair.length > 0 && rec.reverseRepair.length < targets.length + 1);
  assert.ok((await loadGraphManifest(b, big())).health.rebuildHint);
});

test("removeNote with conditional delete removes the record and every membership", async () => {
  const b = memoryBucket();
  b.capabilities = { conditionalDelete: true };
  await project(b, "a.md", links("t.md"), "v1");
  assert.equal((await removeNote(b, "a.md", { budget: big(), gen, mode })).state, "projected");
  assert.equal(await b.get(nodeKey(gen, await pathHash("a.md"))), null);
  assert.deepEqual(await incoming(b, "t.md"), []);
  assert.equal((await removeNote(b, "a.md", { budget: big(), gen, mode })).state, "skipped");
});

test("removeNote without conditional delete leaves an excluded tombstone, finished after a stop", async () => {
  const b = memoryBucket();
  await project(b, "a.md", links("t.md", "u.md"), "v1");
  assert.equal((await removeNote(b, "a.md", { budget: createSearchBudget(3), gen, mode })).state, "pending");
  assert.equal((await removeNote(b, "a.md", { budget: big(), gen, mode })).state, "projected");
  const rec = await node(b, "a.md");
  assert.equal(rec.coverage, "excluded");
  assert.deepEqual(rec.reverseRepair, []);
  assert.deepEqual(await incoming(b, "t.md"), []);
  assert.deepEqual(await incoming(b, "u.md"), []);
  const budget = big();
  assert.equal((await removeNote(b, "a.md", { budget, gen, mode })).state, "skipped");
  assert.equal(budget.spent, 1);
});

test("best-effort mode projects with unconditional writes", async () => {
  const b = memoryBucket({ ignoreIfMatch: true });
  assert.equal((await project(b, "a.md", links("t.md"), "v1", big(), { mode: "best-effort" })).state, "projected");
  assert.equal((await project(b, "a.md", "none", "v2", big(), { mode: "best-effort" })).state, "projected");
  assert.deepEqual(await incoming(b, "t.md"), []);
});

/** Validated incoming sources, the view a backlink reader gets. */
const backlinks = async (store, target) => {
  const { entries } = await readPostings(store, big(), {
    gen, family: "incoming", hash: await pathHash(target), canSee: () => true, validate: validateEntry(store, big(), gen),
  });
  return entries.map((e) => e.source);
};
/**
 * Runs `older` with its first node write paused until `newer` has settled,
 * the interleaving where the older call's repairs land after the newer
 * record was cleared.
 */
async function race(b, older, newer) {
  const nk = nodeKey(gen, await pathHash("s.md"));
  let release;
  const gate = new Promise((r) => (release = r));
  let paused = false;
  const slow = {
    capabilities: b.capabilities,
    get: (k) => b.get(k),
    delete: (k, o) => b.delete(k, o),
    async put(k, v, o) {
      const r = await b.put(k, v, o);
      if (k === nk && !paused) {
        paused = true;
        await gate;
      }
      return r;
    },
  };
  const pending = older(slow);
  while (!paused) await new Promise((r) => setTimeout(r, 1));
  const n = await newer(b);
  release();
  return { older: await pending, newer: n };
}

test("an older call racing a newer projection hands its keys to the newer record", async () => {
  const b = memoryBucket();
  const { older, newer } = await race(
    b,
    (s) => project(s, "s.md", links("t.md"), "v1"),
    (s) => project(s, "s.md", links("t.md", "u.md"), "v2"),
  );
  assert.equal(newer.state, "projected");
  assert.notEqual(older.state, "projected");
  assert.ok((await node(b, "s.md")).reverseRepair.length > 0, "the newest record carries the older call's keys");
  assert.notEqual((await project(b, "s.md", links("t.md", "u.md"), "v2")).state, "skipped");
  assert.deepEqual(await backlinks(b, "t.md"), ["s.md"]);
  assert.deepEqual(await backlinks(b, "u.md"), ["s.md"]);
});

test("removeNote racing a newer projection hands its keys to the newer record", async () => {
  const b = memoryBucket();
  b.capabilities = { conditionalDelete: true };
  await project(b, "s.md", links("t.md"), "v1");
  const { older, newer } = await race(
    b,
    (s) => removeNote(s, "s.md", { budget: big(), gen, mode }),
    (s) => project(s, "s.md", links("t.md"), "v2"),
  );
  assert.equal(newer.state, "projected");
  assert.notEqual(older.state, "projected");
  assert.notEqual((await project(b, "s.md", links("t.md"), "v2")).state, "skipped");
  assert.deepEqual(await backlinks(b, "t.md"), ["s.md"]);
});

test("the memory fixture refuses a delete whose etag does not match", async () => {
  const b = memoryBucket();
  const { etag } = await b.put("k", "x");
  assert.equal(await b.delete("k", { onlyIf: { etagMatches: "m999" } }), null);
  assert.ok(await b.get("k"));
  assert.notEqual(await b.delete("k", { onlyIf: { etagMatches: etag } }), null);
  assert.equal(await b.get("k"), null);
});

test("an edit from encrypted to plain adds the new memberships", async () => {
  const b = memoryBucket();
  await project(b, "a.md", "---\ncontext_encryption: v1\n---\nciphertext", "v1");
  assert.equal((await project(b, "a.md", links("t.md"), "v2")).state, "projected");
  assert.deepEqual(await backlinks(b, "t.md"), ["a.md"]);
  assert.deepEqual((await node(b, "a.md")).reverseRepair, []);
});
