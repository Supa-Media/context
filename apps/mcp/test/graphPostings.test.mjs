/**
 * Posting pages and the P4 mode (`src/graph/postings.js`, `mode.js`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   conditional options dropped (writes unconditional in conditional mode)  2
 *   next === page + 1 check dropped                                         3
 *   walk cap dropped                                                        1
 *   append-past-cap check dropped                                           1
 *   budget.take dropped in walk                                             2
 *   budget.take dropped before a write                                      1
 *   retry bound 1 / bound 5                                                 3 / 1
 *   canSee applied after validate                                           1
 *   canSee dropped                                                          1
 *   validate dropped                                                        2
 *   page create written before the link to it                               1
 *   graphMode needs only conditionalWrite                                   1
 *
 * Fix round 1 (red first for each; each sabotage then failed 1 test):
 *   "full" returned as "budget"; corrupt-page refusal dropped; planned-writes
 *   budget preflight dropped; readPostings dedupe dropped
 *
 * Fix round 2: refusal narrowed from `status !== "end"` back to corrupt only  3 failing
 *
 * Process note: the module was drafted before this file; RED was shown by
 * moving the modules aside (every import failed), then restoring them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphMode } from "../src/graph/mode.js";
import { MAX_ATTEMPTS, MAX_POSTING_PAGES, readPostings, setMembership } from "../src/graph/postings.js";
import { postingPageKey } from "../src/graph/keys.js";
import { POSTING_PAGE_SIZE, serializePage } from "../src/graph/records.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

const loc = { gen: "1", family: "incoming", hash: "a".repeat(64) };
const key = (n) => postingPageKey(loc.gen, loc.family, loc.hash, n);
const big = () => createSearchBudget(100000);
const all = () => true;
const valid = () => true;
const add = (store, source, version = "v1", extra = {}) =>
  setMembership(store, big(), { ...loc, source, referenceSetVersion: version, present: true, mode: "conditional", ...extra });
const remove = (store, source) =>
  setMembership(store, big(), { ...loc, source, referenceSetVersion: "v1", present: false, mode: "conditional" });
const read = async (store, opts = {}) =>
  readPostings(store, opts.budget ?? big(), { ...loc, canSee: all, validate: valid, ...opts });
const sources = async (store) => (await read(store)).entries.map((e) => e.source).sort();
const seed = (bucket, n, entries, next) =>
  bucket.put(key(n), serializePage({ key: key(n), entries, ...(next !== undefined && { next }) }));
const fill = (prefix, count) => Array.from({ length: count }, (_, i) => ({ source: `${prefix}${i}.md`, referenceSetVersion: "v1" }));
/** Counts get/put calls and optionally intercepts the next put. */
function spy(bucket) {
  const s = { gets: 0, puts: [], beforePut: null };
  s.store = {
    capabilities: bucket.capabilities,
    get: (k) => (s.gets += 1, bucket.get(k)),
    async put(k, v, o) {
      s.puts.push({ k, o });
      if (s.beforePut) {
        const hook = s.beforePut;
        s.beforePut = null;
        await hook();
      }
      return bucket.put(k, v, o);
    },
  };
  return s;
}

test("graphMode is conditional only with both probed flags", () => {
  assert.equal(graphMode({ capabilities: { conditionalWrite: true, conditionalCreate: true } }), "conditional");
  assert.equal(graphMode({ capabilities: { conditionalWrite: true, conditionalCreate: false } }), "best-effort");
  assert.equal(graphMode({ capabilities: { conditionalWrite: false, conditionalCreate: true } }), "best-effort");
  assert.equal(graphMode({ capabilities: { conditionalWrite: true } }), "best-effort");
  assert.equal(graphMode({}), "best-effort");
  assert.equal(graphMode(undefined), "best-effort");
});

test("add, re-add with a new referenceSetVersion, remove", async () => {
  const b = memoryBucket();
  assert.equal(await add(b, "a.md"), "done");
  assert.equal(await add(b, "b.md"), "done");
  assert.equal(await add(b, "a.md", "v2"), "done");
  const { entries, complete } = await read(b);
  assert.equal(complete, true);
  assert.deepEqual(entries.filter((e) => e.source === "a.md"), [{ source: "a.md", referenceSetVersion: "v2" }]);
  assert.deepEqual(await sources(b), ["a.md", "b.md"]);
  assert.equal(await remove(b, "a.md"), "done");
  assert.deepEqual(await sources(b), ["b.md"]);
  assert.equal(await remove(b, "ghost.md"), "done");
  assert.equal(await remove(b, "b.md"), "done");
  assert.deepEqual(JSON.parse((await (await b.get(key(0))).text())).entries, []);
});

test("an identical re-add is a no-op that writes nothing", async () => {
  const b = memoryBucket();
  await add(b, "a.md");
  const s = spy(b);
  assert.equal(await add(s.store, "a.md", "v1", {}), "done");
  assert.equal(s.puts.length, 0);
});

test("two writers adding different sources to the same head page both survive", async () => {
  const b = memoryBucket();
  await add(b, "seed.md");
  const s = spy(b);
  s.beforePut = async () => assert.equal(await add(b, "second.md"), "done");
  assert.equal(await add(s.store, "first.md", "v1", { mode: "conditional" }), "done");
  assert.deepEqual(await sources(b), ["first.md", "second.md", "seed.md"]);
});

test("two writers racing to create the head both survive (conditional create)", async () => {
  const b = memoryBucket();
  const s = spy(b);
  s.beforePut = async () => assert.equal(await add(b, "second.md"), "done");
  assert.equal(await add(s.store, "first.md"), "done");
  assert.deepEqual(await sources(b), ["first.md", "second.md"]);
  assert.equal(s.puts[0].o.onlyIf.absent, true);
});

test("overflow past 256 creates and links page 1; removal from page 1 works", async () => {
  const b = memoryBucket();
  for (let i = 0; i < POSTING_PAGE_SIZE + 1; i += 1) assert.equal(await add(b, `n${i}.md`), "done");
  const head = JSON.parse(await (await b.get(key(0))).text());
  const page1 = JSON.parse(await (await b.get(key(1))).text());
  assert.equal(head.entries.length, POSTING_PAGE_SIZE);
  assert.equal(head.next, "1");
  assert.deepEqual(page1.entries.map((e) => e.source), [`n${POSTING_PAGE_SIZE}.md`]);
  assert.equal((await read(b)).entries.length, POSTING_PAGE_SIZE + 1);
  assert.equal(await remove(b, `n${POSTING_PAGE_SIZE}.md`), "done");
  assert.equal((await read(b)).entries.length, POSTING_PAGE_SIZE);
  // The freed slot is on page 1; removing from page 0 and re-adding fills page 0 first.
  assert.equal(await remove(b, "n0.md"), "done");
  assert.equal(await add(b, "late.md"), "done");
  assert.ok(JSON.parse(await (await b.get(key(0))).text()).entries.some((e) => e.source === "late.md"));
});

test("an exhausted budget returns budget and leaves pages parseable", async () => {
  const b = memoryBucket();
  const set = (budget) => setMembership(b, budget, { ...loc, source: "a.md", referenceSetVersion: "v1", present: true, mode: "conditional" });
  assert.equal(await set(createSearchBudget(0)), "budget");
  assert.equal(await set(createSearchBudget(1)), "budget"); // read allowed, write refused
  assert.equal(b.objects.size, 0);
  // Overflow plans two writes (link then create); a budget that covers the read
  // and only one of them must write nothing.
  await seed(b, 0, fill("f", POSTING_PAGE_SIZE));
  const before = JSON.stringify([...b.objects]);
  assert.equal(await set(createSearchBudget(2)), "budget");
  assert.equal(JSON.stringify([...b.objects]), before);
  assert.equal(await set(createSearchBudget(3)), "done");
});

test("a dangling link left by a failed create is harmless and repaired by the next writer", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("f", POSTING_PAGE_SIZE), "1");
  assert.equal((await read(b)).entries.length, POSTING_PAGE_SIZE);
  assert.equal(await add(b, "a.md"), "done");
  assert.equal((await read(b)).entries.length, POSTING_PAGE_SIZE + 1);
});

test("an unparseable page: setMembership writes nothing and returns conflict", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 1), "1");
  await b.put(key(1), "{not json");
  await seed(b, 2, fill("c", 1));
  const before = JSON.stringify([...b.objects]);
  assert.equal(await add(b, "new.md"), "conflict");
  assert.equal(await remove(b, "a0.md"), "conflict");
  assert.equal(await remove(b, "ghost.md"), "conflict");
  assert.equal(JSON.stringify([...b.objects]), before);
  assert.equal((await read(b)).complete, false);
});

test("readPostings deduplicates by source, the last entry in chain order winning", async () => {
  const b = memoryBucket();
  await seed(b, 0, [{ source: "a.md", referenceSetVersion: "old" }, { source: "b.md", referenceSetVersion: "v1" }], "1");
  await seed(b, 1, [{ source: "a.md", referenceSetVersion: "new" }]);
  const r = await read(b);
  assert.deepEqual(r.entries.sort((x, y) => x.source.localeCompare(y.source)), [
    { source: "a.md", referenceSetVersion: "new" },
    { source: "b.md", referenceSetVersion: "v1" },
  ]);
});

test("conditional refusal past the retry bound returns conflict", async () => {
  const b = memoryBucket();
  await add(b, "seed.md");
  const s = spy(b);
  const refusing = { ...s.store, put: async (k, v, o) => (s.puts.push({ k, o }), null) };
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(await add(refusing, "a.md"), "conflict");
  assert.equal(s.puts.length, MAX_ATTEMPTS);
});

test("best-effort mode writes unconditionally, even on a store that ignores preconditions", async () => {
  const b = memoryBucket({ ignoreIfMatch: true });
  assert.equal(graphMode(b), "best-effort");
  const s = spy(b);
  assert.equal(await add(s.store, "a.md", "v1", { mode: graphMode(b) }), "done");
  assert.equal(await add(s.store, "b.md", "v1", { mode: graphMode(b) }), "done");
  assert.ok(s.puts.every((p) => p.o === undefined));
  assert.deepEqual(await sources(b), ["a.md", "b.md"]);
});

test("readPostings: a source canSee rejects never appears and never reaches validate", async () => {
  const b = memoryBucket();
  const c = memoryBucket();
  await add(b, "pub.md");
  await add(b, "secret.md");
  await add(c, "pub.md");
  const seen = [];
  const canSee = (s) => s !== "secret.md";
  const validate = (e) => (seen.push(e.source), true);
  const withHidden = await read(b, { canSee, validate });
  const without = await read(c, { canSee, validate });
  assert.deepEqual(withHidden, without);
  assert.deepEqual(seen, ["pub.md", "pub.md"]);
  assert.equal(JSON.stringify(withHidden).includes("secret"), false);
});

test("readPostings: validate drops stale referenceSetVersion; a throw marks incomplete", async () => {
  const b = memoryBucket();
  await add(b, "fresh.md", "v2");
  await add(b, "stale.md", "v1");
  const current = { "fresh.md": "v2", "stale.md": "v9" };
  const r = await read(b, { validate: (e) => current[e.source] === e.referenceSetVersion });
  assert.deepEqual(r.entries.map((e) => e.source), ["fresh.md"]);
  assert.equal(r.complete, true);
  const t = await read(b, { validate: () => { throw new Error("boom"); } });
  assert.deepEqual(t, { entries: [], complete: false });
});

test("readPostings: complete is false when the budget ends mid-chain", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 2), "1");
  await seed(b, 1, fill("b", 2));
  const r = await read(b, { budget: createSearchBudget(1) });
  assert.equal(r.complete, false);
  assert.equal(r.entries.length, 2);
  assert.equal((await read(b, { budget: createSearchBudget(2) })).complete, true);
  assert.equal((await read(b)).entries.length, 4);
  assert.deepEqual(await read(memoryBucket()), { entries: [], complete: true });
});

test("walker: a self-referencing page is read once", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 1), "0");
  const s = spy(b);
  const r = await read(s.store);
  assert.equal(s.gets, 1);
  assert.deepEqual(r.entries.length, 1);
  assert.equal(r.complete, false);
  const w = spy(b);
  const before = JSON.stringify([...b.objects]);
  assert.equal(await add(w.store, "x.md"), "conflict");
  assert.ok(w.gets <= 3);
  assert.equal(JSON.stringify([...b.objects]), before);
});

test("walker: a backward next never revisits a page", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 1), "1");
  await seed(b, 1, fill("b", 1), "0");
  const s = spy(b);
  const r = await read(s.store);
  assert.equal(s.gets, 2);
  assert.equal(r.entries.length, 2);
  assert.equal(r.complete, false);
});

test("walker: a skipping next is not followed", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 1), "2");
  await seed(b, 2, fill("c", 1));
  const s = spy(b);
  const r = await read(s.store);
  assert.equal(s.gets, 1);
  assert.deepEqual(r.entries.map((e) => e.source), ["a0.md"]);
  assert.equal(r.complete, false);
  const before = JSON.stringify([...b.objects]);
  assert.equal(await add(b, "x.md"), "conflict");
  assert.equal(await remove(b, "c0.md"), "conflict"); // lives only behind the bad link
  assert.equal(await remove(b, "ghost.md"), "conflict");
  assert.equal(JSON.stringify([...b.objects]), before);
});

test("a malformed walk refuses writes: bad next \"5\" and a chain truncated at the read cap", async () => {
  const b = memoryBucket();
  await seed(b, 0, fill("a", 1), "5");
  await seed(b, 5, fill("e", 1));
  const before = JSON.stringify([...b.objects]);
  assert.equal(await add(b, "x.md"), "conflict");
  assert.equal(await remove(b, "e0.md"), "conflict");
  assert.equal(await remove(b, "ghost.md"), "conflict");
  assert.equal(JSON.stringify([...b.objects]), before);
  const c = memoryBucket();
  for (let n = 0; n < MAX_POSTING_PAGES + 2; n += 1) await seed(c, n, fill(`p${n}-`, 1), String(n + 1));
  const cBefore = JSON.stringify([...c.objects]);
  assert.equal(await add(c, "x.md"), "conflict");
  assert.equal(await remove(c, "p0-0.md"), "conflict");
  assert.equal(JSON.stringify([...c.objects]), cBefore);
});

test("walker: a chain longer than the cap stops at the cap", async () => {
  const b = memoryBucket();
  for (let n = 0; n < MAX_POSTING_PAGES + 5; n += 1) await seed(b, n, fill(`p${n}-`, 1), String(n + 1));
  const s = spy(b);
  const r = await read(s.store);
  assert.equal(s.gets, MAX_POSTING_PAGES);
  assert.equal(r.entries.length, MAX_POSTING_PAGES);
  assert.equal(r.complete, false);
  // Full pages to the cap: a writer cannot append past it, but removal still works.
  const f = memoryBucket();
  for (let n = 0; n < MAX_POSTING_PAGES; n += 1) await seed(f, n, fill(`q${n}-`, POSTING_PAGE_SIZE), n + 1 < MAX_POSTING_PAGES ? String(n + 1) : undefined);
  const g = spy(f);
  assert.equal(await add(g.store, "new.md"), "full");
  assert.equal(g.gets, MAX_POSTING_PAGES);
  assert.equal(g.puts.length, 0);
  assert.equal(await remove(f, "q0-0.md"), "done");
});
