/**
 * The write path's post-commit graph hook (`src/graph/afterWrite.js`) and its
 * budget (`writeEnrichBudgetFor`), driven through the real `toolWriteNote`.
 *
 * The graph is a derivative: nothing it does may change a write's result text
 * or committed body (arch 16.3, P5 "never limits the write itself").
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   inner try/catch of projectNoteAfterWrite removed alone                  0 (the outer catch in
 *                                                                           projectNoteAfterWriteDeferred still holds: two layers)
 *   both try/catch layers removed                                           1 (throwing store)
 *   outer catch alone removed                                               0 (inner holds)
 *   budget clamp upper bound removed                                        1 (parsing)
 *   budget clamp lower bound removed (negative stays negative)              1 (parsing)
 *   graph work run inline although store.defer exists                       1 (deferred, by timeout)
 *   manifest read not budgeted (budget 0 still reads it)                    3 (budget 0, many links, op count)
 *   budget object ignored (unbounded budget used)                           3 (budget 0, many links, op count)
 *   no-manifest guard removed (work attempted at generation 1)              1 (no manifest)
 *   hook call removed from toolWriteNote                                    6
 *
 * Process note: tests written first; RED was the missing exports.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { toolRemember } from "../src/tools/notes/remember.js";
import { toolCommentNote } from "../src/tools/notes/comment.js";
import { toolCreateForm } from "../src/tools/forms/tools.js";
import { toolMoveNote } from "../src/tools/moves/note.js";
import { toolArchiveNote } from "../src/tools/moves/archive.js";
import { initGraphManifest } from "../src/graph/manifest.js";
import { nodeKey, pathHash } from "../src/graph/keys.js";
import { parseNode } from "../src/graph/records.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { WRITE_ENRICH_SUBREQUEST_BUDGET, writeEnrichBudgetFor } from "../src/search/budget.js";
import { memoryBucket } from "./store/fixtures.mjs";

const CAPS = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
const links = (n) => Array.from({ length: n }, (_, i) => `[t${i}](./t${i}.md)`).join(" ");
const normalize = (result) => JSON.stringify(result).replace(/etag m\d+/g, "etag M");

/**
 * A memoryBucket store with an owner actor. `graph: false` leaves the bucket
 * without a graph manifest. `failOn` makes matching graph ops throw.
 */
async function makeStore({ budget, graph = true, defer = false, failPut = false, failGet = false, gate = null, caps = CAPS } = {}) {
  const bucket = memoryBucket();
  const store = {
    capabilities: caps,
    actor: { workspaceId: "w_graphwrite", userId: "u_owner" },
    ops: [],
    deferred: [],
    get: async (key, ...rest) => {
      if (key.startsWith(".context/graph/")) {
        store.ops.push(["get", key]);
        if (failGet) throw new Error("graph get down");
        if (gate) await gate.promise;
      }
      return bucket.get(key, ...rest);
    },
    put: async (key, value, options) => {
      if (key.startsWith(".context/graph/")) {
        store.ops.push(["put", key]);
        if (failPut) throw new Error("graph put down");
        if (gate) await gate.promise;
      }
      return bucket.put(key, value, options);
    },
    delete: (...a) => bucket.delete(...a),
    list: (...a) => bucket.list(...a),
    objects: bucket.objects,
  };
  if (budget !== undefined) store.writeEnrichBudget = budget;
  if (defer) store.defer = (promise) => store.deferred.push(promise);
  if (graph) await initGraphManifest(bucket, createSearchBudget(100), { mode: "conditional", now: 1_700_000_000_000 });
  return store;
}

const write = (store, args) => toolWriteNote(store, "private", [], new Map(), args);
const node = async (store, path) => {
  const got = await store.objects.get(nodeKey("1", await pathHash(path)));
  return got ? parseNode(got.body, path) : null;
};
const graphKeys = (store) => [...store.objects.keys()].filter((k) => k.startsWith(".context/graph/") && !k.endsWith("manifest.json"));

test("writeEnrichBudgetFor: absent, numeric, junk, negative and huge", () => {
  assert.equal(WRITE_ENRICH_SUBREQUEST_BUDGET, 8);
  assert.equal(writeEnrichBudgetFor({}), 8);
  assert.equal(writeEnrichBudgetFor(undefined), 8);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "80" }), 80);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: 12 }), 12);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "abc" }), 8);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "-5" }), 0);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "0" }), 0);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "99999" }), 900);
  assert.equal(writeEnrichBudgetFor({ WRITE_ENRICH_SUBREQUEST_BUDGET: "7.9" }), 7);
});

test("budget 0: write result and body identical, no graph store op at all", async () => {
  const args = { path: "notes/a.md", content: `# A\n${links(3)}\n` };
  const base = await makeStore({ graph: false });
  const baseline = await write(base, args);
  const store = await makeStore({ budget: 0 });
  const result = await write(store, args);
  assert.equal(normalize(result), normalize(baseline));
  assert.equal((await store.get("notes/a.md")) && await (await store.get("notes/a.md")).text(), args.content);
  assert.deepEqual(store.ops, []);
  assert.deepEqual(graphKeys(store), []);
});

test("default budget publishes the node record and leaves the result unchanged", async () => {
  const args = { path: "notes/a.md", content: "# A\nsee [b](./b.md)\n" };
  const baseline = await write(await makeStore({ budget: 0 }), args);
  const store = await makeStore();
  const result = await write(store, args);
  assert.equal(normalize(result), normalize(baseline));
  const record = await node(store, "notes/a.md");
  assert.equal(record?.path, "notes/a.md");
  assert.equal(record.observedSourceVersion, /etag (m\d+)/.exec(result.content[0].text)[1]);
  assert.deepEqual(record.reverseRepair, []);
});

test("many new links exceed the budget: reverseRepair is left, result unchanged, ops within budget", async () => {
  const args = { path: "notes/big.md", content: `# Big\n${links(30)}\n` };
  const baseline = await write(await makeStore({ budget: 0 }), args);
  const store = await makeStore({ budget: 8 });
  const result = await write(store, args);
  assert.equal(normalize(result), normalize(baseline));
  const record = await node(store, "notes/big.md");
  assert.ok(record, "node published first");
  assert.ok(record.reverseRepair.length > 0);
  assert.ok(store.ops.length <= 8, `graph ops ${store.ops.length} exceed 8`);
});

test("total graph ops never exceed the budget, at any budget", async () => {
  for (const budget of [1, 2, 3, 5, 8, 13]) {
    const store = await makeStore({ budget });
    await write(store, { path: "notes/c.md", content: `# C\n${links(10)}\n` });
    assert.ok(store.ops.length <= budget, `budget ${budget}: ${store.ops.length} ops`);
  }
});

test("a graph store that throws on put or get never changes the write", async () => {
  const args = { path: "notes/f.md", content: `# F\n${links(2)}\n` };
  const baseline = await write(await makeStore({ budget: 0 }), args);
  for (const failure of [{ failPut: true }, { failGet: true }]) {
    const store = await makeStore(failure);
    const result = await write(store, args);
    assert.equal(normalize(result), normalize(baseline));
    assert.equal(await (await store.get("notes/f.md")).text(), args.content);
    assert.ok(store.ops.length > 0, "the graph was attempted");
  }
});

test("with store.defer the graph work runs after the write returns", async () => {
  let release;
  const gate = { promise: new Promise((r) => (release = r)) };
  const store = await makeStore({ defer: true, gate });
  const args = { path: "notes/d.md", content: "# D\n[x](./x.md)\n" };
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("write waited for the graph")), 1000));
  const result = await Promise.race([write(store, args), timeout]);
  assert.equal(result.isError, undefined);
  assert.equal(await node(store, "notes/d.md"), null, "not projected before the response");
  release();
  await Promise.all(store.deferred);
  assert.ok(await node(store, "notes/d.md"), "projected once the deferred work runs");
});

test("a fresh workspace without a graph manifest does no graph work", async () => {
  const store = await makeStore({ graph: false });
  const result = await write(store, { path: "notes/n.md", content: "# N\n[x](./x.md)\n" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(graphKeys(store), []);
  assert.deepEqual(store.ops, [["get", ".context/graph/v1/manifest.json"]]);
  assert.equal([...store.objects.keys()].some((k) => k.endsWith("manifest.json")), false);
});

test("remember, comments and forms project like write_note", async () => {
  const store = await makeStore();
  const remembered = await toolRemember(store, "private", [], new Map(), {
    fact: "Prefers [the plan](./plan.md) first.",
    kind: "stated",
    note: "notes/pref.md",
  });
  // remember into a note that does not exist yet is refused; create it first.
  assert.equal(remembered.isError, true);
  await write(store, { path: "notes/pref.md", content: "# Pref\n\n- one\n" });
  const ok = await toolRemember(store, "private", [], new Map(), {
    fact: "Prefers [the plan](./plan.md) first.",
    kind: "stated",
    note: "notes/pref.md",
  });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  assert.match((await node(store, "notes/pref.md")).occurrences.map((o) => JSON.stringify(o)).join(), /plan\.md/);

  await write(store, { path: "notes/talk.md", content: "# Talk\n\nfree, you cheapo [t](./t.md)\n" });
  store.actor = { ...store.actor, client: "Codex" };
  const talkBefore = (await node(store, "notes/talk.md")).observedSourceVersion;
  const commented = await toolCommentNote(store, "private", [], new Map(), {
    path: "notes/talk.md",
    comment: { action: "add", quote: "free, you cheapo", text: "Tone it down." },
  });
  assert.equal(commented.isError, undefined, JSON.stringify(commented));
  assert.notEqual((await node(store, "notes/talk.md")).observedSourceVersion, talkBefore, "the comment's commit was observed");

  const form = await toolCreateForm(store, "private", [], new Map(), {
    path: "forms/survey.md",
    intro: "Read [the brief](./brief.md) first.",
    fields: [{ name: "answer", type: "text", max: 100 }],
  });
  assert.equal(form.isError, undefined, JSON.stringify(form));
  assert.match(JSON.stringify(await node(store, "forms/survey.md")), /brief\.md/);
});

test("moves and archive do not call the hook (left to reconciliation)", async () => {
  const store = await makeStore({ caps: { ...CAPS, conditionalDelete: true } });
  await write(store, { path: "notes/m.md", content: "# M\n[x](./x.md)\n" });
  const before = store.ops.length;
  const keysBefore = graphKeys(store).length;
  const moved = await toolMoveNote(store, "private", [], new Map(), "notes/m.md", "notes/m2.md");
  const archived = await toolArchiveNote(store, "private", [{ prefix: "archive", vis: "private" }], new Map(), "notes/m2.md");
  assert.equal(moved.isError, undefined, JSON.stringify(moved));
  assert.equal(archived.isError, undefined, JSON.stringify(archived));
  assert.equal(store.ops.length, before);
  assert.equal(graphKeys(store).length, keysBefore);
});
