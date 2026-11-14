/**
 * The public memory benchmarks as a bench folder (`bench/publicSets.mjs`):
 * dates and evidence read from each dataset's own shapes, the LongMemEval
 * sample the same on every run, and the bootstrap range in `bench/search.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evidenceSessions, lmeDate, locomoDate, sampleLme } from "../publicSets.mjs";
import { bootstrapRange } from "../search.mjs";

test("dates come from each dataset's own format", () => {
  assert.equal(lmeDate("2023/05/20 (Sat) 02:21"), "2023-05-20");
  assert.equal(locomoDate("1:56 pm on 8 May, 2023"), "2023-05-08");
  assert.equal(locomoDate("not a date"), null);
});

test("LoCoMo evidence names sessions, once each, malformed ids included", () => {
  assert.deepEqual(evidenceSessions(["D1:3", "D1:9", "D:11:26", "D4:10"]), [1, 4]);
  assert.deepEqual(evidenceSessions(undefined), []);
});

test("the LongMemEval sample skips abstentions, covers every type and does not depend on input order", () => {
  const entries = ["a", "b"].flatMap((type) =>
    ["3", "1", "2", "0_abs"].map((n) => ({ question_id: `${type}${n}`, question_type: type })),
  );
  const ids = sampleLme(entries, 4).map((e) => e.question_id);
  assert.deepEqual(ids, ["a1", "b1"]);
  assert.deepEqual(sampleLme([...entries].reverse(), 4).map((e) => e.question_id), ids);
});

test("the bootstrap range holds the mean, is the same every run, and is a point when every score agrees", () => {
  const scores = Array.from({ length: 100 }, (_, i) => (i < 60 ? 1 : 0));
  const [low, high] = bootstrapRange(scores);
  assert.ok(low < 0.6 && high > 0.6 && low > 0.45 && high < 0.75, `${low} to ${high}`);
  assert.deepEqual(bootstrapRange(scores), [low, high]);
  assert.deepEqual(bootstrapRange([1, 1, 1]), [1, 1]);
  assert.deepEqual(bootstrapRange([]), [0, 0]);
});
