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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RERANK_MODEL, rerankEntries, rerankScores, rerankText } from "../src/search/rerank.js";
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

test("it reads the title and snippets, capped, and is off on main with its two settings", () => {
  assert.equal(rerankText({ key: "x.md", title: "T", snippets: ["s"] }), "T\ns");
  assert.ok(rerankText({ key: "x.md", snippets: ["y".repeat(5000)] }).length <= 2000);
  const node = searchConfig.SEARCH_CONFIG.nodes.find((n) => n.id === "rerank");
  assert.equal(node.on, false);
  assert.deepEqual(Object.keys(node.settings).sort(), ["rerankTop", "rerankWeight"]);
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
