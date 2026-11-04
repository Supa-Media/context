/**
 * Pool, then rerank (`search/rerank.js`; the search revamp, 2026-11-04): the best fused hits read once more by a
 * ranking model, the two orders fused, and the fused order kept whenever the model does not answer in full.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the model's order taken alone (no fusion)              → "a strong word hit holds against one model pick" fails
 *   the timeout removed                                    → "fails open" fails (hangs past the test's limit)
 *   rerank applied without being asked                     → "only when asked for" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RERANK_MODEL, passageOf, rerankHits } from "../src/search/rerank.js";
import { translateSearch } from "../src/tools/v2/searchFetch.js";
import { findNotes } from "../src/tools/search.js";
import { withServedTree } from "./servedTree.mjs";

const hits = (...keys) => keys.map((key) => ({ key, title: key.replace(/\.md$/, ""), snippets: [`about ${key}`] }));
const modelSays = (scores, seen = []) => ({
  async run(model, input) {
    seen.push({ model, input });
    return { response: scores.map((score, id) => ({ id, score })) };
  },
});

test("the model's order is fused with the search's: its clear first pick rises", async () => {
  const seen = [];
  const out = await rerankHits(modelSays([0.1, 0.2, 0.3, 0.99], seen), "team conflict", hits("a.md", "b.md", "c.md", "d.md"));
  assert.deepEqual(out.map((hit) => hit.key), ["a.md", "d.md", "b.md", "c.md"]);
  assert.equal(seen[0].model, RERANK_MODEL);
  assert.equal(seen[0].input.query, "team conflict");
  assert.equal(seen[0].input.contexts.length, 4);
});

test("a strong word hit holds against one model pick, and agreement keeps the order", async () => {
  const out = await rerankHits(modelSays([0.01, 0.5, 0.9]), "q", hits("first.md", "second.md", "third.md"));
  assert.equal(out[0].key, "first.md");
  const same = await rerankHits(modelSays([0.9, 0.5, 0.1]), "q", hits("a.md", "b.md", "c.md"));
  assert.deepEqual(same.map((hit) => hit.key), ["a.md", "b.md", "c.md"]);
});

test("only the best twelve are read; the rest keep their places below", async () => {
  const many = hits(...Array.from({ length: 15 }, (_, index) => `n${index}.md`));
  const seen = [];
  const out = await rerankHits(modelSays(Array.from({ length: 12 }, (_, index) => index / 12), seen), "q", many);
  assert.equal(seen[0].input.contexts.length, 12);
  assert.deepEqual(out.slice(12).map((hit) => hit.key), ["n12.md", "n13.md", "n14.md"]);
  assert.equal(new Set(out.map((hit) => hit.key)).size, 15);
});

test("fails open: no model, a refusal, a partial or strange answer, or a slow one leaves the order", async () => {
  const fused = hits("a.md", "b.md", "c.md");
  const order = (list) => list.map((hit) => hit.key);
  assert.deepEqual(order(await rerankHits(undefined, "q", fused)), order(fused));
  assert.deepEqual(order(await rerankHits({ run: async () => { throw new Error("8006"); } }, "q", fused)), order(fused));
  assert.deepEqual(order(await rerankHits({ run: async () => ({ response: [{ id: 2, score: 1 }] }) }, "q", fused)), order(fused));
  assert.deepEqual(order(await rerankHits({ run: async () => ({ response: "nope" }) }, "q", fused)), order(fused));
  const slow = { run: () => new Promise(() => {}) };
  assert.deepEqual(order(await rerankHits(slow, "q", fused, { timeoutMs: 20 })), order(fused));
});

test("the model reads the title, the file name and the passage, cleaned and bounded", () => {
  const text = passageOf({ key: "@ops/projects/llc-formation.md", title: "Setting up", snippets: ["Articles \uD800 filed", "x".repeat(2000)] });
  assert.ok(text.startsWith("Setting up (llc formation)\nArticles � filed"));
  assert.ok(text.length <= 700);
});

test("only when asked for: `rerank` travels from the v2 search to search_notes, and nothing calls the model otherwise", async () => {
  assert.deepEqual(translateSearch({ query: "plan", args: { rerank: true } }), { name: "search_notes", arguments: { query: "plan", rerank: true }, action: "notes" });
  let calls = 0;
  const notes = new Map([["plan.md", "# Plan\n\nThe plan for the launch.\n"], ["later.md", "# Later\n\nA plan for next year.\n"]]);
  const store = withServedTree({
    ai: { run: async () => ((calls += 1), { response: [{ id: 0, score: 0 }, { id: 1, score: 1 }] }) },
    async list() { return { objects: [...notes.keys()].sort().map((key) => ({ key, size: notes.get(key).length, uploaded: new Date(0), etag: `e-${key}` })), truncated: false }; },
    async get(key) { return notes.has(key) ? { etag: `e-${key}`, text: async () => notes.get(key), size: notes.get(key).length } : null; },
    async head(key) { return notes.has(key) ? { etag: `e-${key}`, size: notes.get(key).length } : null; },
  });
  const plain = await findNotes(store, "private", [], new Map(), "plan", "");
  assert.equal(plain.hits.length, 2);
  assert.equal(calls, 0);
  const asked = await findNotes(store, "private", [], new Map(), "plan", "", { rerank: true });
  assert.equal(calls, 1);
  assert.deepEqual(asked.hits.map((hit) => hit.key).sort(), plain.hits.map((hit) => hit.key).sort());
});
