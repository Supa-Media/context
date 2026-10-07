/**
 * The search benchmark's own arithmetic (apps/mcp/bench). A baseline is only
 * as good as its scoring, so the metrics are checked against hand-computed
 * cases and the corpus against itself.
 *
 * ## Sabotage record
 *
 * `ndcgAt` with an ideal that ignores `k` failed "nDCG normalizes to the top
 * k". `reciprocalRank` counting from 0 failed "reciprocal rank". Seeding the
 * generator from the clock failed "the same seed gives the same corpus".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { generateCorpus } from "../bench/fixtures.js";
import { mean, ndcgAt, percentile, recallAt, reciprocalRank } from "../bench/metrics.js";

test("recall at k", () => {
  assert.equal(recallAt(["a", "x", "b"], ["a", "b"], 3), 1);
  assert.equal(recallAt(["a", "x", "b"], ["a", "b"], 2), 0.5);
  assert.equal(recallAt([], ["a"], 10), 0);
});

test("nDCG normalizes to the top k", () => {
  assert.equal(ndcgAt(["a", "b"], ["a", "b"], 10), 1);
  // One relevant path at rank 2 (index 1): 1/log2(3) over an ideal of 1.
  assert.ok(Math.abs(ndcgAt(["x", "a"], ["a"], 10) - 1 / Math.log2(3)) < 1e-12);
  // Three relevant, k = 1, the one shown is relevant: perfect at that depth.
  assert.equal(ndcgAt(["a"], ["a", "b", "c"], 1), 1);
  // A duplicate path is not counted twice.
  assert.equal(ndcgAt(["a", "a"], ["a", "b"], 10), 1 / (1 + 1 / Math.log2(3)));
});

test("reciprocal rank", () => {
  assert.equal(reciprocalRank(["a"], ["a"]), 1);
  assert.equal(reciprocalRank(["x", "y", "a"], ["a"]), 1 / 3);
  assert.equal(reciprocalRank(["x"], ["a"]), 0);
});

test("a query with no relevant paths is a broken fixture", () => {
  assert.throws(() => recallAt(["a"], [], 10));
});

test("mean and nearest-rank percentile", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 100), 100);
  assert.equal(percentile([7], 99), 7);
});

test("the same seed gives the same corpus", () => {
  const one = generateCorpus({ size: 200, seed: 3 });
  const two = generateCorpus({ size: 200, seed: 3 });
  assert.deepEqual(one, two);
  assert.notDeepEqual(one.notes, generateCorpus({ size: 200, seed: 4 }).notes);
});

test("a corpus has exactly the size asked, unique paths, and judged queries that point into it", () => {
  for (const size of [100, 1_000]) {
    const { notes, queries } = generateCorpus({ size });
    assert.equal(notes.length, size);
    const paths = new Set(notes.map((note) => note.path));
    assert.equal(paths.size, size);
    for (const query of queries) {
      assert.ok(query.relevant.length > 0, query.query);
      for (const path of query.relevant) assert.ok(paths.has(path), `${query.query} -> ${path}`);
    }
    assert.ok(notes.some((note) => note.visibility === "private"));
    assert.ok(notes.some((note) => note.visibility === "team"));
  }
});

test("the corpus carries the shapes the plan names", () => {
  const { notes, queries } = generateCorpus({ size: 1_000 });
  const kinds = new Set(queries.map((query) => query.kind));
  for (const kind of ["exact", "title", "deep", "multi", "morph", "cjk", "code", "message"]) {
    assert.ok(kinds.has(kind), kind);
  }
  assert.ok(notes.some((note) => note.text.length > 64_000), "a note past 64,000 characters");
  const basenames = notes.map((note) => note.path.split("/").pop());
  assert.ok(basenames.length > new Set(basenames).size, "duplicate basenames");
  assert.ok(notes.filter((note) => note.text.includes("[[hub-0]]")).length >= 10, "a hub");
});

test("a size smaller than the judged set refuses", () => {
  assert.throws(() => generateCorpus({ size: 10 }));
});
