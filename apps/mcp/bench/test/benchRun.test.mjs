/**
 * The runner for every search benchmark (`evals/searchCli.mjs`, over `packages/bench`): BEIR's scores per group and
 * their mean, retrieval recall, the expected-note guard, a tiny BEIR set and a LongMemEval question run end to end
 * through a real gateway world with the fake embedder on both paths, and the embedding cache the gate reads.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeBeir } from "../../../../packages/bench/src/beir.mjs";
import { cachedEmbeddings, fakeAi } from "../models.mjs";
import { beirScores, missingExpected, retrievalScores, runSearchSet, shardOf, withRecall } from "../evals/searchCli.mjs";
import { main } from "../evals/cli.mjs";

const quiet = async (fn) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
};

test("the headline is the mean over groups, never over pooled queries, with a reference ranking scored beside it", () => {
  const r = (kind, hits, expect, bm25) => ({ id: `${kind}-${hits.join("")}`, kind, hits, expect, bm25, rank: hits.indexOf(expect[0]) + 1 || null, ms: 1 });
  const records = [r("big", ["a"], ["a"], ["x", "a"]), r("big", ["b"], ["b"], ["b"]), r("big", ["c"], ["c"], ["c"]), r("small", ["x"], ["d"], ["d"])];
  const s = beirScores(records);
  assert.equal(s.bySet.big.ndcg10, 1);
  assert.equal(s.bySet.small.ndcg10, 0);
  assert.equal(s.ndcg10, 0.5, "pooled would say 0.75");
  assert.equal(s.bySet.small.bm25Ndcg10, 1);
  assert.equal(s.bySet.big.firstPct, 100);
  // A set with no reference ranking (HERB) says so as null, not as a score of 0.
  const none = beirScores(records.map(({ bm25: _b, ...rest }) => rest));
  assert.equal(none.bm25Ndcg10, null);
  assert.equal(none.bySet.big.bm25Ndcg10, null);
});

test("retrieval: any and all of the answer notes in the top 5, per ability, questions with none left out", () => {
  const records = [
    withRecall({ id: "a", ability: "multi", expect: ["@sam/x.md", "@sam/z.md"], rank: 1, hits: ["@sam/x.md"], ms: 10 }),
    withRecall({ id: "b", ability: "update", expect: ["@sam/y.md"], rank: 1, hits: ["@sam/y.md"], ms: 20 }),
    withRecall({ id: "c", ability: "abstention", expect: [], rank: null, hits: [], ms: 5 }),
  ];
  assert.deepEqual([records[0].recallAny5, records[0].recallAll5], [true, false]);
  const s = retrievalScores(records);
  assert.equal(s.n, 2);
  assert.equal(s.recallAny5Pct, 100);
  assert.equal(s.recallAll5Pct, 50);
  assert.deepEqual(s.byAbility.update, { n: 1, recallAny5Pct: 100 });
  assert.equal(s.byAbility.abstention, undefined);
});

test("an expected note a world does not have stops the run, naming the case", () => {
  const bench = { workspaces: { sam: { files: { "a.md": "x" } } } };
  assert.deepEqual(missingExpected(bench, [{ id: "c1", expect: ["@sam/a.md"] }, { id: "c2", expect: ["@sam/b.md", "@ghost/a.md"] }]), ["c2 @sam/b.md", "c2 @ghost/a.md"]);
});

test("a tiny NanoBEIR set, kept as BEIR's files, runs end to end through search on both paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
  writeBeir(join(dir, "nanobeir", "scifact"), {
    id: "scifact",
    revision: null,
    corpus: [
      { _id: "1", title: "", text: "Vitamin D supplements lower the risk of bone fractures in older adults." },
      { _id: "2", title: "", text: "Coffee drinking is linked to a lower risk of liver disease." },
      { _id: "3", title: "", text: "Regular running improves heart health and lowers blood pressure." },
    ],
    queries: [
      { _id: "q1", text: "coffee and liver disease", bm25: ["2", "1"] },
      { _id: "q2", text: "running blood pressure", bm25: ["1", "3"] },
    ],
    qrels: { q1: { 2: 1 }, q2: { 3: 1 } },
  });
  try {
    const out = await quiet(() => runSearchSet({ bench: "nanobeir", sets: "scifact", fetch: dir, fake: true }));
    assert.equal(out.bench, "nanobeir");
    assert.equal(out.n, 2);
    assert.equal(out.search.bySet.scifact.n, 2);
    assert.equal(out.search.ndcg10, 1);
    assert.equal(out.search.objectNdcg10, 1);
    // By default the workspace objects alone answer, as every managed workspace searches; `with-database` adds the
    // bucket world's search database, still how the bring-your-own-storage workspaces search.
    assert.deepEqual(out.search.byPath, { object: 2 }, JSON.stringify(out.search.byPath));
    const both = await quiet(() => runSearchSet({ bench: "nanobeir", sets: "scifact", fetch: dir, fake: true, "with-database": true }));
    assert.equal(both.search.ndcg10, 1);
    assert.equal(both.search.objectNdcg10, 1);
    assert.ok(Object.keys(both.search.byPath).some((path) => path !== "object"), JSON.stringify(both.search.byPath));
    assert.ok(out.search.bm25Ndcg10 < 1, "BM25's list put the second query's note second");
    assert.deepEqual(out.rows.map((r) => r.id), ["scifact-q1", "scifact-q2"]);
    // In two processes, each asking every other question: the same rows in the same order, scored as one run.
    const out2 = join(dir, "two.json");
    await quiet(() => main(["search", "--bench", "nanobeir", "--sets", "scifact", "--fetch", dir, "--fake", "--parallel", "2", "--out", out2]));
    const two = JSON.parse(readFileSync(out2, "utf8"));
    assert.deepEqual(two.rows.map((r) => [r.id, r.rank]), out.rows.map((r) => [r.id, r.rank]));
    assert.equal(two.search.ndcg10, out.search.ndcg10);
    assert.equal(two.total, 2);
    assert.deepEqual(shardOf("2/3"), { index: 1, of: 3 });
    assert.throws(() => shardOf("4/3"), /--shard/);
    await assert.rejects(runSearchSet({ bench: "nanobeir", sets: "nope", fetch: dir, fake: true }), /no NanoBEIR set nope/);
    await assert.rejects(runSearchSet({ bench: "nanobeir", fake: true }), /--fetch <dir> is required/);
    await assert.rejects(runSearchSet({ bench: "longmemeval-s", fake: true }), /memory benchmark/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a LongMemEval question is its own world: the answer session's note is found in the top 5", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-lme-"));
  const item = {
    question_id: "lme-test-1",
    question_type: "single-session-user",
    question: "Which bicycle did I buy for the mountain trail?",
    answer: "A red bicycle",
    question_date: "2023/05/20 (Sat) 02:21",
    answer_session_ids: ["bike-session"],
    haystack_session_ids: ["pancake-session", "bike-session", "Plant Care/2"],
    haystack_dates: ["2023/04/12 (Wed) 09:30", "2023/05/01 (Mon) 10:00", "2023/01/01 (Sun) 10:00"],
    haystack_sessions: [
      [{ role: "user", content: "How many eggs go in pancakes for six people?" }, { role: "assistant", content: "Use three eggs." }],
      [{ role: "user", content: "I finally bought a red bicycle for the mountain trail near my house." }, { role: "assistant", content: "A red bicycle is a great choice." }],
      [{ role: "user", content: "Water the fern on Tuesdays." }, { role: "assistant", content: "Ferns like humidity." }],
    ],
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "data.json"), JSON.stringify([item]));
  try {
    const out = await quiet(() => runSearchSet({ bench: "longmemeval-retrieval", data: join(dir, "data.json"), fake: true }));
    assert.equal(out.total, 1);
    const [row] = out.rows;
    assert.equal(row.id, "lme-test-1");
    assert.equal(row.ability, "extraction");
    assert.equal(row.error, null);
    assert.ok(row.rank !== null && row.rank <= 5, `rank ${row.rank}`);
    assert.equal(out.search.recallAny5Pct, 100);
    assert.equal(out.search.byAbility.extraction.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embeddings kept in a file come back bit for bit, and a second run asks the model for none of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
  const file = join(dir, "vectors.txt");
  let calls = 0;
  const counted = { run: async (model, input) => { calls += 1; return fakeAi().run(model, input); } };
  try {
    const first = await cachedEmbeddings(counted, { file }).run("@cf/baai/bge-m3", { text: ["alpha beta", "gamma"] });
    assert.equal(calls, 1);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
    const second = await cachedEmbeddings(counted, { file }).run("@cf/baai/bge-m3", { text: ["gamma", "alpha beta"] });
    assert.equal(calls, 1, "both came from the file");
    assert.deepEqual(second.data[0], first.data[1]);
    assert.deepEqual(second.data[1], first.data[0]);
    await cachedEmbeddings(counted, { file }).run("@cf/baai/bge-m3", { text: ["delta"] });
    assert.equal(calls, 2, "a new text is asked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
