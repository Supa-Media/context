/**
 * The rerank step (`src/search/rerank.js`, `rerank` in searchConfig.json after `snippets`, off on main): each
 * workspace's first rows read again beside the query, each adding a part for its place under the path prior and
 * keeping the model's score, which "Rank across workspaces" ranks together. Never adds or drops a note, and the rows
 * stand when the model fails.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-21):
 *   rerankEntries ignoring the reranker's scores           "the reranker's order moves the rows it read" fails
 *   rerankEntries letting a thrown model call escape       "a failing model leaves the rows" fails
 *   rerankScores accepting a missing id                    "an answer out of shape is not used" fails
 *   scoreOf leaving `r` outside the path prior             "an archived copy … still ranks below it" fails
 *   fuseEverywhere ignoring rerankScore                    "across workspaces, the reranker's scores rank together" fails
 *   earlyScore ignoring a word hit's score                 "Rerank uses the early scores without a call…" fails
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RERANK_MODEL, forgetRerankScores, rerankAcross, rerankEntries, rerankScores, rerankText, rerankWordHits } from "../src/search/rerank.js";
import { lowerByPath, mergeLists, scoreOf } from "../src/search/stages.js";
import { fuseEverywhere } from "../src/search/fuse.js";
import { FUSE_RANKING } from "../src/search/ranking.js";
import searchConfig from "../src/search/config/searchConfig.cjs";

const hits = ["a", "b", "c", "d"].map((key) => ({ key: `${key}.md`, title: key, snippets: [`text ${key}`] }));
const rowsOf = (list) => mergeLists(list, [], "key", undefined, undefined, true);
const aiScoring = (scores) => ({
  calls: [],
  async run(model, input) {
    this.calls.push({ model, input });
    return { response: scores.slice(0, input.contexts.length).map((score, id) => ({ id, score })) };
  },
});
const settings = { rerankTop: 3, rerankWeight: 1, rrfK: 60 };
beforeEach(() => forgetRerankScores());

test("the reranker's order moves the rows it read, and the rest keep their place below", async () => {
  const ai = aiScoring([0.1, 0.2, 0.9]);
  // Weight 2: the reranker's order counts twice the words' (at 1, c's last-but-one word rank and first rerank place
  // tie a's first word rank and last rerank place).
  const { entries, reranked } = await rerankEntries(ai, "find c", rowsOf(hits), { ...settings, rerankWeight: 2 });
  assert.deepEqual(entries.map((e) => e.key), ["c.md", "b.md", "a.md", "d.md"]);
  assert.equal(entries[0].rerankScore, 0.9);
  assert.equal(entries[3].rerankScore, undefined);
  assert.equal(reranked.read, 3);
  assert.equal(ai.calls[0].model, RERANK_MODEL);
  assert.deepEqual(ai.calls[0].input.contexts.map((c) => c.text), ["a\ntext a", "b\ntext b", "c\ntext c"]);
});

test("weight 0 keeps the order the steps before gave", async () => {
  const { entries } = await rerankEntries(aiScoring([0, 0, 1]), "q", rowsOf(hits), { ...settings, rerankWeight: 0 });
  assert.deepEqual(entries.map((e) => e.key), ["a.md", "b.md", "c.md", "d.md"]);
});

test("a note only meaning found is read by what the snippets step read for it", async () => {
  const rows = [{ key: "m.md", word: null, meaning: { path: "m.md", score: 0.8 }, read: { title: "Met", snippets: ["passage"] }, w: 0, m: 0.01, title: 0, prior: 1, order: 0 }, ...rowsOf(hits.slice(0, 1))];
  const ai = aiScoring([0.5, 0.4]);
  await rerankEntries(ai, "q", rows, settings);
  assert.equal(ai.calls[0].input.contexts[0].text, "Met\npassage");
});

test("a failing model leaves the rows, and says why", async () => {
  const rows = rowsOf(hits);
  const out = await rerankEntries({ async run() { throw new Error("down"); } }, "q", rows, settings);
  assert.equal(out.entries, rows);
  assert.equal(out.reranked.skipped, "the reranker failed");
  assert.equal((await rerankEntries(null, "q", rows, settings)).reranked.skipped, "no model here");
  assert.equal((await rerankEntries(aiScoring([1]), "q", rows.slice(0, 1), settings)).reranked.skipped, "fewer than two notes");
});

test("an answer out of shape is not used", async () => {
  const ai = { async run() { return { response: [{ id: 0, score: 1 }] }; } };
  assert.equal(await rerankScores(ai, "q", ["a", "b"]), null);
});

test("it reads the title and snippets, capped, and has its four settings", () => {
  assert.equal(rerankText({ key: "x.md", title: "T", snippets: ["s"] }), "T\ns");
  assert.ok(rerankText({ key: "x.md", snippets: ["y".repeat(5000)] }).length <= 2000);
  const node = searchConfig.SEARCH_CONFIG.nodes.find((n) => n.id === "rerank");
  assert.deepEqual(Object.keys(node.settings).sort(), ["readLate", "rerankChars", "rerankTop", "rerankWeight"]);
  const ids = searchConfig.SEARCH_CONFIG.nodes.map((n) => n.id);
  assert.equal(ids.indexOf("rerank"), ids.indexOf("snippets") + 1, "after the step where every row has text");
});

test("an archived copy the reranker scores above the live note still ranks below it, by the path prior", async () => {
  const pair = lowerByPath(rowsOf([{ key: "archive/plan-2024.md", title: "Plan" }, { key: "projects/plan.md", title: "Plan" }]));
  const { entries } = await rerankEntries(aiScoring([0.9, 0.8]), "plan", pair, settings);
  assert.equal(entries[0].key, "projects/plan.md");
  // The reranker's part is under the prior like the others: a log's counts half.
  assert.equal(scoreOf({ w: 0, m: 0, title: 0, r: 0.02, prior: 0.5 }), 0.01);
});

test("across workspaces, the reranker's scores rank together, and without them the fusion is as before", () => {
  // Each workspace's first word hit ties on its word rank; the reranker read both and liked @b's far more.
  const a = [{ key: "a.md", title: "A", wordRank: 0, meaningScore: null }];
  const b = [{ key: "@b/b.md", title: "B", wordRank: 0, meaningScore: null }];
  assert.deepEqual(fuseEverywhere([a, b]).map((h) => h.key), ["a.md", "@b/b.md"]);
  const scored = (list, rerankScore) => list.map((h) => ({ ...h, rerankScore }));
  assert.deepEqual(fuseEverywhere([scored(a, 0.1), scored(b, 0.9)]).map((h) => h.key), ["@b/b.md", "a.md"]);
  assert.deepEqual(fuseEverywhere([scored(a, 0.1), scored(b, 0.9)], 12, { ranking: { ...FUSE_RANKING, rerankWeight: 0 } }).map((h) => h.key), ["a.md", "@b/b.md"]);
});

test("every workspace's rows go in one call, each read as at most rerankChars, and each list ranks by its own places", async () => {
  const ai = aiScoring([0.1, 0.9, 0.8, 0.2]);
  const a = rowsOf([{ key: "a1.md", title: "A1", snippets: ["x".repeat(900)] }, { key: "a2.md", title: "A2" }]);
  const b = rowsOf([{ key: "@b/b1.md", title: "B1" }, { key: "@b/b2.md", title: "B2" }]);
  const { lists, reranked } = await rerankAcross(ai, "q", [a, null, b], { ...settings, rerankWeight: 2, rerankChars: 120 });
  assert.equal(ai.calls.length, 1, "one call for every workspace");
  assert.equal(ai.calls[0].input.contexts.length, 4);
  assert.ok(ai.calls[0].input.contexts.every((c) => c.text.length <= 120));
  assert.deepEqual(lists[0].map((e) => e.key), ["a2.md", "a1.md"]);
  assert.equal(lists[1], null);
  assert.deepEqual(lists[2].map((e) => e.key), ["@b/b1.md", "@b/b2.md"]);
  assert.deepEqual({ calls: reranked.calls, read: reranked.read, sent: reranked.sent }, { calls: 1, read: 4, sent: 4 });
});

test("a query and text already scored in this isolate is not sent again", async () => {
  const ai = aiScoring([0.3, 0.7, 0.5]);
  await rerankEntries(ai, "find c", rowsOf(hits), settings);
  const again = await rerankEntries(ai, "find c", rowsOf(hits), settings);
  assert.equal(ai.calls.length, 1);
  assert.equal(again.reranked.calls, 0);
  assert.deepEqual(again.entries.map((e) => e.rerankScore).slice(0, 3).sort(), [0.3, 0.5, 0.7]);
});

test("the word hits are scored early, in one call for every workspace, the first rerankTop of each", async () => {
  const ai = aiScoring([0.2, 0.9, 0.5, 0.4]);
  const byWords = {
    "@me": { hits: [{ key: "a.md", title: "A" }, { key: "b.md", title: "B" }, { key: "c.md", title: "C" }], matchCount: 3 },
    "@ops": { hits: [{ key: "x.md", title: "X" }, { key: "y.md", title: "Y" }], matchCount: 2 },
    "@gone": null,
  };
  const { byWords: out, reranked } = await rerankWordHits(ai, "q", byWords, { rerankTop: 2, rerankChars: 100 });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(out["@me"].hits.map((h) => h.rerankScore), [0.2, 0.9, undefined]);
  assert.deepEqual(out["@ops"].hits.map((h) => h.rerankScore), [0.5, 0.4]);
  assert.equal(out["@gone"], null);
  assert.equal(out["@me"].matchCount, 3);
  assert.deepEqual({ calls: reranked.calls, read: reranked.read }, { calls: 1, read: 4 });
  const failed = await rerankWordHits({ async run() { throw new Error("down"); } }, "another query", byWords, { rerankTop: 2 });
  assert.equal(failed.byWords, byWords);
  assert.equal(failed.reranked.skipped, "the reranker failed");
});

test("Rerank uses the early scores without a call, and with readLate 0 a row nobody read keeps its place", async () => {
  const early = (key, score) => ({ key, word: { key, title: key, rerankScore: score }, meaning: null, w: 0.01, m: 0, title: 0, prior: 1, order: 0 });
  const meaningOnly = { key: "m.md", word: null, meaning: { path: "m.md", score: 0.8 }, read: { title: "M", snippets: ["s"] }, w: 0, m: 0.0095, title: 0, prior: 1, order: 1 };
  const rows = [early("a.md", 0.1), meaningOnly, early("c.md", 0.9)];
  const ai = aiScoring([0.5]);
  const { entries, reranked } = await rerankEntries(ai, "q", rows, { ...settings, rerankWeight: 2, readLate: 0 });
  assert.equal(ai.calls.length, 0, "every score it needs was read early, or is not read");
  assert.equal(reranked.calls, 0);
  assert.equal(reranked.early, 2);
  // c and a swap the places they held (0 and 2); m keeps place 1 and its own part.
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.equal(byKey["c.md"].r, 2 / (60 + 0 + 1));
  assert.equal(byKey["m.md"].r, 2 / (60 + 1 + 1));
  assert.equal(byKey["a.md"].r, 2 / (60 + 2 + 1));
  assert.equal(byKey["m.md"].rerankScore, undefined);
  assert.equal(entries[0].key, "c.md");
  // readLate 1: only the row nobody read early is sent.
  const late = await rerankEntries(ai, "q", rows, { ...settings, readLate: 1 });
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(ai.calls[0].input.contexts.map((c) => c.text), ["M\ns"]);
  assert.equal(late.reranked.early, 2);
});
