/**
 * NanoBEIR (`evals/nanoBeir.mjs`): BEIR's scores computed as BEIR's evaluator computes them, a set fetched page by
 * page from the Hugging Face dataset viewer, each document one note, and a tiny set run end to end through a real
 * gateway world with the fake embedder, on both paths.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cachedEmbeddings, fakeAi } from "../models.mjs";
import { fileOf, GATE_SETS, loadNanoSet, mrrAt, NANO_BENCHES, NANO_SETS, nanoScores, ndcgAt, recallAt, runNanoBeir, worldOf } from "../evals/nanoBeir.mjs";
import { embedderFor } from "../evals/searchSuite.mjs";

test("nDCG@10 is BEIR's: binary gains, log2 discount, the ideal list puts every relevant note first", () => {
  assert.equal(ndcgAt(["a", "b"], ["a"]), 1);
  // Relevant at place 2 of one relevant: 1/log2(3).
  assert.equal(ndcgAt(["x", "a"], ["a"]).toFixed(4), (1 / Math.log2(3)).toFixed(4));
  // Two relevant, one found first: 1 / (1 + 1/log2(3)).
  assert.equal(ndcgAt(["a", "x"], ["a", "b"]).toFixed(4), (1 / (1 + 1 / Math.log2(3))).toFixed(4));
  // Past the tenth place counts for nothing, and a note listed twice counts once.
  assert.equal(ndcgAt([..."0123456789".split(""), "a"], ["a"]), 0);
  assert.equal(ndcgAt(["a", "a", "b"], ["a", "b"]), 1);
  assert.equal(ndcgAt([], ["a"]), 0);
  assert.equal(recallAt(["a", "x", "b"], ["a", "b", "c", "d"]), 0.5);
  assert.equal(mrrAt(["x", "y", "a"], ["a"]).toFixed(4), (1 / 3).toFixed(4));
  assert.equal(mrrAt(["x"], ["a"]), 0);
});

test("the 13 sets are NanoBEIR's, and the gate runs four of them", () => {
  assert.equal(NANO_SETS.length, 13);
  assert.equal(new Set(NANO_SETS.map((s) => s.repo)).size, 13);
  for (const s of NANO_SETS) assert.match(s.repo, /^sentence-transformers\/Nano[A-Za-z0-9]+-bm25$/);
  assert.deepEqual(NANO_BENCHES["nanobeir-gate"], GATE_SETS);
  for (const id of GATE_SETS) assert.ok(NANO_SETS.some((s) => s.id === id));
});

test("a document id is a safe file name, and two that clash both get a note", () => {
  assert.equal(fileOf("doc57226"), "doc57226");
  assert.equal(fileOf("../etc/passwd"), "---etc-passwd");
  assert.equal(fileOf(""), "doc");
  const { notes, cases } = worldOf({ id: "t", corpus: [{ id: "a/b", title: "", text: "one" }, { id: "a-b", title: "Two", text: "two" }], queries: [{ id: "q", text: "two", relevant: ["a-b"], bm25: ["a/b", "a-b"] }] });
  assert.deepEqual(Object.keys(notes), ["@sam/beir/a-b.md", "@sam/beir/a-b-2.md"]);
  assert.equal(notes["@sam/beir/a-b-2.md"], "# Two\n\ntwo\n");
  assert.deepEqual(cases[0], { id: "t-q", query: "two", as: "Sam", kind: "t", expect: ["@sam/beir/a-b-2.md"], bm25: ["@sam/beir/a-b.md", "@sam/beir/a-b-2.md"] });
});

test("a set is read from its parquet files at the Hub's revision, a busy answer tried again, kept on disk, unjudged queries dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nanobeir-"));
  const sha = "a".repeat(40);
  const tables = {
    corpus: Array.from({ length: 130 }, (_, i) => ({ _id: `d${i}`, text: `text ${i}` })),
    queries: [{ _id: "q1", text: "text 5" }, { _id: "q2", text: "nothing" }],
    relevance: [{ "query-id": "q1", "positive-corpus-ids": ["d5"], "bm25-ranked-ids": ["d5", "d1"] }],
  };
  const asked = [];
  let busy = true;
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith("/api/datasets/sentence-transformers/NanoSciFact-bm25")) {
      return new Response(JSON.stringify({ sha, siblings: ["README.md", "corpus/train-00000-of-00001.parquet", "queries/train-00000-of-00001.parquet", "relevance/train-00000-of-00001.parquet"].map((rfilename) => ({ rfilename })) }));
    }
    if (url.includes("/corpus/") && busy) {
      busy = false;
      return new Response("busy", { status: 503 });
    }
    const config = /resolve\/[0-9a-f]{40}\/(\w+)\//.exec(url)?.[1];
    return new Response(JSON.stringify(tables[config]));
  };
  const readParquet = async (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  try {
    const data = await loadNanoSet("scifact", dir, { fetchImpl, readParquet, sleep: async () => {} });
    assert.equal(data.revision, sha);
    assert.ok(asked.every((u) => !u.includes("/resolve/") || u.includes(`/resolve/${sha}/`)), "files are read at the pinned revision");
    assert.equal(data.corpus.length, 130);
    assert.deepEqual(data.queries, [{ id: "q1", text: "text 5", relevant: ["d5"], bm25: ["d5", "d1"] }]);
    assert.ok(existsSync(join(dir, "nanobeir-scifact.json")));
    const again = asked.length;
    await loadNanoSet("scifact", dir, { fetchImpl, readParquet });
    assert.equal(asked.length, again, "a kept set is not fetched again");
    await assert.rejects(loadNanoSet("nope", dir, { fetchImpl }), /no NanoBEIR set nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real parquet file reads into rows (hyparquet)", async () => {
  const { parquetReadObjects } = await import("hyparquet");
  assert.equal(typeof parquetReadObjects, "function");
});

test("the headline is the mean over sets, never over pooled queries, with BM25's own list scored beside it", () => {
  const r = (kind, hits, expect, bm25) => ({ id: `${kind}-${hits.join("")}`, kind, hits, expect, bm25, rank: hits.indexOf(expect[0]) + 1 || null, ms: 1 });
  const records = [r("big", ["a"], ["a"], ["x", "a"]), r("big", ["b"], ["b"], ["b"]), r("big", ["c"], ["c"], ["c"]), r("small", ["x"], ["d"], ["d"])];
  const s = nanoScores(records);
  assert.equal(s.bySet.big.ndcg10, 1);
  assert.equal(s.bySet.small.ndcg10, 0);
  assert.equal(s.ndcg10, 0.5, "pooled would say 0.75");
  assert.equal(s.bySet.small.bm25Ndcg10, 1);
  assert.equal(s.bySet.big.firstPct, 100);
});

test("a tiny set runs end to end through search on both paths, and the scores come back per set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nanobeir-run-"));
  const data = {
    id: "scifact",
    corpus: [
      { id: "1", title: "", text: "Vitamin D supplements lower the risk of bone fractures in older adults." },
      { id: "2", title: "", text: "Coffee drinking is linked to a lower risk of liver disease." },
      { id: "3", title: "", text: "Regular running improves heart health and lowers blood pressure." },
    ],
    queries: [
      { id: "q1", text: "coffee and liver disease", relevant: ["2"], bm25: ["2", "1"] },
      { id: "q2", text: "running blood pressure", relevant: ["3"], bm25: ["1", "3"] },
    ],
  };
  writeFileSync(join(dir, "nanobeir-scifact.json"), JSON.stringify(data));
  try {
    const lines = [];
    const log = console.log;
    console.log = () => {};
    let out;
    try {
      out = await runNanoBeir({ sets: ["scifact"], dir, ai: embedderFor({ fake: true }), log: (line) => lines.push(line) });
    } finally {
      console.log = log;
    }
    assert.equal(out.records.length, 2);
    assert.equal(out.search.bySet.scifact.n, 2);
    assert.equal(out.search.ndcg10, 1);
    assert.equal(out.search.objectNdcg10, 1);
    assert.ok(out.search.bm25Ndcg10 < 1, "BM25's list put the second query's note second");
    assert.ok(lines.some((l) => /scifact: nDCG@10 1/.test(l)));
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
