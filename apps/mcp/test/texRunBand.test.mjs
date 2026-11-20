/**
 * The Lab run's noise band (`packages/lab/src/texRunBand.cjs`; Dev2, 2026-11-19: one Front door run came back 11/30
 * and 15/30 minutes apart). Pinned: a score is its mean with its min..max band; a draft wins only when its worst repeat
 * beats its base's best, loses only when its best is under the base's worst, and has no band when either side ran once;
 * a run's repeats default to 3 and are 1 to 5; a cc run is labelled "model family only".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const band = createRequire(import.meta.url)("../../../packages/lab/src/texRunBand.cjs");

test("bandOf reads the mean, min and max over the repeats, and a 95% interval inside the total", () => {
  const s = band.bandOf([11, 15, 13], 30);
  assert.deepEqual({ mean: s.mean, min: s.min, max: s.max, repeats: s.repeats, total: s.total }, { mean: 13, min: 11, max: 15, repeats: 3, total: 30 });
  assert.ok(s.lo < s.mean && s.mean < s.hi, "the interval brackets the mean");
  assert.ok(s.lo >= 0 && s.hi <= 30, "the interval stays inside 0..total");
});

test("bandOf of one repeat is its own mean with no spread, and of none is zero", () => {
  assert.deepEqual(band.bandOf([14], 30), { mean: 14, min: 14, max: 14, lo: 14, hi: 14, repeats: 1, total: 30 });
  assert.equal(band.bandOf([], 30).repeats, 0);
});

test("bandVerdict: wins past the base's best, loses under its worst, within noise when the bands overlap", () => {
  const base = band.bandOf([11, 12, 13], 30);
  assert.equal(band.bandVerdict(band.bandOf([14, 15, 16], 30), base).verdict, "wins");
  assert.equal(band.bandVerdict(band.bandOf([8, 9, 10], 30), base).verdict, "loses");
  assert.equal(band.bandVerdict(band.bandOf([12, 15, 13], 30), base).verdict, "within noise");
  assert.equal(band.bandVerdict(band.bandOf([13, 13, 13], 30), band.bandOf([13, 13, 13], 30)).verdict, "within noise", "an equal score is not a win");
});

test("bandVerdict: a single repeat on either side has no band, and a missing side has no base", () => {
  assert.equal(band.bandVerdict(band.bandOf([20], 30), band.bandOf([11, 12, 13], 30)).verdict, "no band");
  assert.equal(band.bandVerdict(band.bandOf([20, 21, 22], 30), band.bandOf([11], 30)).verdict, "no band");
  assert.equal(band.bandVerdict(null, { pass: 12, total: 30 }).verdict, "no base");
  assert.equal(band.bandVerdict(undefined, undefined).verdict, "no base");
});

test("bandVerdict reads a results object: its own score, or its single pass count as one repeat", () => {
  const scored = { pass: 16, total: 30, score: band.bandOf([15, 16, 17], 30) };
  assert.equal(band.bandVerdict(scored, { pass: 13, total: 30, score: band.bandOf([11, 12, 13], 30) }).verdict, "wins");
  assert.equal(band.bandVerdict({ pass: 16, total: 30 }, { pass: 13, total: 30 }).verdict, "no band");
  assert.match(band.bandVerdict(scored, { pass: 13, total: 30 }).why, /one repeat/);
});

test("repeatsOf: 3 when missing, 1 to 5 when given, null for anything else", () => {
  assert.equal(band.repeatsOf(undefined), 3);
  assert.equal(band.repeatsOf(null), 3);
  assert.equal(band.repeatsOf(""), 3);
  assert.equal(band.repeatsOf(5), 5);
  assert.equal(band.repeatsOf(1), 1);
  assert.equal(band.repeatsOf("2"), 2);
  assert.equal(band.repeatsOf(6), null);
  assert.equal(band.repeatsOf(0), null);
  assert.equal(band.repeatsOf(2.5), null);
  assert.equal(band.repeatsOf("many"), null);
  assert.equal(band.DEFAULT_REPEATS, 3);
  assert.equal(band.MAX_REPEATS, 5);
});

test("fidelityOf: a cc run is model family only, a gw run has no label", () => {
  assert.equal(band.fidelityOf("cc"), band.CC_FIDELITY);
  assert.equal(band.CC_FIDELITY, "model family only");
  assert.equal(band.fidelityOf("gw"), null);
  assert.match(band.CC_FIDELITY_WHY, /gw/);
});
