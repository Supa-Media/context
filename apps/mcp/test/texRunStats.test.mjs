/**
 * The Lab's run statistics (`packages/lab/src/texRunStats.cjs`; Dev2, 2026-11-19). Pinned with hand-computed numbers:
 * Wilson intervals, the Student's t table, the clustered standard error, pass^k, and the paired rule that decides a
 * draft against its base on the same rows. The band may say "wins" while the paired interval still says "within noise";
 * the paired rule decides.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stats = require("../../../packages/lab/src/texRunStats.cjs");
const band = require("../../../packages/lab/src/texRunBand.cjs");

const row = (convId, msgIndex, ok, extra = {}) => ({ convId, msgIndex, node: "front", ok, ...extra });
const res = (rows, extra = {}) => ({ pass: 0, total: 0, rows, ...extra });

// Six shared rows in three conversations. The draft passes all six; the base passes only B's second row.
// Paired diffs: 1, 1, 1, 0, 1, 1. Mean 5/6; cluster sums of deviations 1/3, -2/3, 1/3; clustered SE 1/6; df 2.
const draftWin = res([row("A", 0, true), row("A", 1, true), row("B", 0, true), row("B", 1, true), row("C", 0, true), row("C", 1, true)]);
const baseWin = res([row("A", 0, false), row("A", 1, false), row("B", 0, false), row("B", 1, true), row("C", 0, false), row("C", 1, false)]);

test("wilson: the 95% interval for 0, 10 and 5 out of 10, and the empty case", () => {
  const zero = stats.wilson(0, 10);
  assert.equal(zero.lo, 0);
  assert.ok(Math.abs(zero.hi - 0.2775) < 0.0005, `hi ${zero.hi}`);
  const all = stats.wilson(10, 10);
  assert.equal(all.hi, 1);
  assert.ok(Math.abs(all.lo - 0.7225) < 0.0005, `lo ${all.lo}`);
  const half = stats.wilson(5, 10);
  assert.ok(Math.abs(half.lo - 0.2366) < 0.0005 && Math.abs(half.hi - 0.7634) < 0.0005, JSON.stringify(half));
  assert.deepEqual(stats.wilson(0, 0), { p: 0, lo: 0, hi: 1 });
});

test("t975: table values, a df between entries takes the lower table df, large df is 1.96, df below 1 is infinite", () => {
  assert.equal(stats.t975(1), 12.706);
  assert.equal(stats.t975(2), 4.303);
  assert.equal(stats.t975(30), 2.042);
  assert.equal(stats.t975(35), 2.042);
  assert.equal(stats.t975(40), 2.021);
  assert.equal(stats.t975(59), 2.021);
  assert.equal(stats.t975(60), 2.0);
  assert.equal(stats.t975(120), 1.98);
  assert.equal(stats.t975(1000), 1.96);
  assert.equal(stats.t975(0), Infinity);
  assert.equal(stats.t975(NaN), Infinity);
});

test("clusteredMean: positively correlated clusters give a clustered SE above the naive one", () => {
  const m = stats.clusteredMean([1, 1, 0, 0], ["a", "a", "b", "b"]);
  assert.equal(m.n, 4);
  assert.equal(m.clusters, 2);
  assert.equal(m.mean, 0.5);
  assert.ok(Math.abs(m.naiveSe - 0.288675) < 1e-6, `naive ${m.naiveSe}`);
  assert.ok(Math.abs(m.clusteredSe - 0.5) < 1e-12, `clustered ${m.clusteredSe}`);
  assert.ok(m.clusteredSe > m.naiveSe);
  assert.equal(m.se, m.clusteredSe);
  assert.equal(m.df, 1);
});

test("clusteredMean: one cluster has no clustered SE, so it falls back to the naive one", () => {
  const m = stats.clusteredMean([1, 0, 1], ["x", "x", "x"]);
  assert.equal(m.clusteredSe, null);
  assert.equal(m.clusters, 1);
  assert.ok(Math.abs(m.se - 1 / 3) < 1e-3, `se ${m.se}`);
  assert.equal(m.df, 2);
});

test("passHatK: all-pass, none-pass, the 0.6 case, and k out of range", () => {
  assert.equal(stats.passHatK(3, 3, 3), 1);
  assert.equal(stats.passHatK(3, 2, 3), 0);
  assert.ok(Math.abs(stats.passHatK(5, 4, 2) - 0.6) < 1e-12);
  assert.equal(stats.passHatK(2, 1, 3), null);
  assert.equal(stats.passHatK(3, 2, 0), null);
});

test("countedRows drops ran:false and ambiguous rows, and reads runs and passes when a row repeated", () => {
  const counted = stats.countedRows(
    res([
      row("c1", 0, true),
      row("c1", 1, false),
      row("c2", 0, true, { ran: false }),
      row("c2", 1, true, { ambiguous: true }),
      row("c3", 0, false, { runs: 3, passes: 2 }),
    ]),
  );
  assert.equal(counted.length, 3);
  assert.deepEqual(
    counted.map((r) => [r.convId, r.runs, r.passes, r.rate]),
    [
      ["c1", 1, 1, 1],
      ["c1", 1, 0, 0],
      ["c3", 3, 2, 2 / 3],
    ],
  );
  assert.equal(stats.rowKey({ convId: "a", msgIndex: 1, node: "x" }), "a\u00001\u0000x");
  assert.deepEqual(stats.countedRows(null), []);
});

test("runStats: the mean row rate, clustered interval, pooled Wilson and pass^k of a repeated run", () => {
  const s = stats.runStats(
    res([
      row("A", 0, false, { runs: 3, passes: 3 }),
      row("A", 1, false, { runs: 3, passes: 2 }),
      row("B", 0, false, { runs: 3, passes: 1 }),
      row("C", 0, false, { runs: 3, passes: 2 }),
    ]),
  );
  assert.equal(s.rows, 4);
  assert.equal(s.conversations, 3);
  assert.equal(s.k, 3);
  assert.equal(s.rate, 0.6667);
  assert.equal(s.clustered, true);
  assert.ok(Math.abs(s.se - 0.1443) < 0.0005, `se ${s.se}`);
  assert.ok(Math.abs(s.lo - 0.0456) < 0.0005, `lo ${s.lo}`);
  assert.equal(s.hi, 1, "the upper bound is clamped to 1");
  assert.ok(Math.abs(s.wilson.lo - 0.3906) < 0.0015 && Math.abs(s.wilson.hi - 0.8619) < 0.0015, JSON.stringify(s.wilson));
  assert.deepEqual(s.passK, { k: 3, rate: 0.25, allPass: 1 });
  assert.equal(stats.statsWords(s), "pass^3 0.25 · Wilson 39–86% · ±62.1 pts (3 chats)");
});

test("runStats: one conversation is not clustered, and no counted rows is null", () => {
  const s = stats.runStats(res([row("only", 0, true), row("only", 1, false)]));
  assert.equal(s.clustered, false);
  assert.equal(s.conversations, 1);
  assert.equal(s.k, 1);
  assert.equal(stats.runStats(res([row("A", 0, true, { ran: false })])), null);
  assert.equal(stats.statsWords(null), "");
  assert.ok(stats.statsWords(s).startsWith("Wilson "), "k of 1 has no pass^k part");
  assert.ok(!stats.statsWords(s).includes("pass^"));
});

test("pairedCompare: a draft better on every row across three conversations wins, with the interval above 0", () => {
  const p = stats.pairedCompare(draftWin, baseWin);
  assert.equal(p.verdict, "wins");
  assert.equal(p.rows, 6);
  assert.equal(p.conversations, 3);
  assert.equal(p.mean, 0.8333);
  assert.equal(p.se, 0.1667);
  assert.ok(p.lo > 0 && Math.abs(p.lo - 0.1162) < 0.001, `lo ${p.lo}`);
  assert.ok(Math.abs(p.hi - 1.5505) < 0.001, `hi ${p.hi}`);
  assert.equal(p.meanRows, 5);
  assert.equal(p.loRows, 0.7);
  assert.equal(p.hiRows, 9.3);
  assert.equal(p.mdeRows, 5.14);
  assert.match(p.why, /\+5\.00 rows \(95% \+0\.70 to \+9\.30\) over 6 shared rows in 3 conversations/);
  assert.deepEqual(p.perRow.map((r) => r.diff), [1, 1, 1, 1, 1]);
  assert.equal(stats.pairedWords(p), "Δ +5.00 rows (+0.70 to +9.30) · detectable ±5.14 · 6 rows / 3 chats");
});

test("pairedCompare: identical runs are within noise with a mean of 0 and no per-row differences", () => {
  const p = stats.pairedCompare(draftWin, draftWin);
  assert.equal(p.verdict, "within noise");
  assert.equal(p.mean, 0);
  assert.deepEqual(p.perRow, []);
});

test("pairedCompare: a draft worse on every row loses, with the interval below 0", () => {
  const p = stats.pairedCompare(baseWin, draftWin);
  assert.equal(p.verdict, "loses");
  assert.ok(p.hi < 0);
  assert.equal(p.mean, -0.8333);
});

test("pairedCompare: one conversation has no interval", () => {
  const p = stats.pairedCompare(res([row("only", 0, true), row("only", 1, true)]), res([row("only", 0, false), row("only", 1, false)]));
  assert.equal(p.verdict, "too few conversations");
  assert.equal(p.rows, 2);
  assert.equal(p.conversations, 1);
  assert.match(p.why, /turns in one chat are not independent/);
});

test("pairedCompare: rows in only one run are counted apart and left out of the comparison", () => {
  const draft = res([...draftWin.rows, row("D", 0, true), row("C", 9, true, { ran: false })]);
  const base = res([...baseWin.rows, row("E", 0, false)]);
  const p = stats.pairedCompare(draft, base);
  assert.equal(p.rows, 6);
  assert.equal(p.onlyDraft, 1);
  assert.equal(p.onlyBase, 1);
  assert.equal(p.verdict, "wins");
  assert.match(p.why, /2 rows not in both runs left out/);
});

test("pairedCompare: runs with no row in common report no shared rows", () => {
  const p = stats.pairedCompare(res([row("X", 0, true), row("X", 1, true)]), res([row("Y", 0, false), row("Y", 1, false)]));
  assert.equal(p.verdict, "no shared rows");
  assert.equal(p.rows, 0);
  assert.equal(p.onlyDraft, 2);
  assert.equal(p.onlyBase, 2);
  assert.equal(stats.pairedWords(p), "");
});

test("pairedCompare: a run that is not on the recorded world is named, and both at zero are the same world", () => {
  const off = stats.pairedCompare(res(draftWin.rows, { world: { misses: 2 } }), res(baseWin.rows, { world: { misses: 0 } }));
  assert.equal(off.sameWorld, false);
  assert.deepEqual(off.world, { draftMisses: 2, baseMisses: 0 });
  assert.match(off.why, /not the same recorded world \(draft invented 2, base 0 simulated answers\)/);
  const on = stats.pairedCompare(res(draftWin.rows, { world: { misses: 0 } }), res(baseWin.rows, { world: { misses: 0 } }));
  assert.equal(on.sameWorld, true);
  assert.doesNotMatch(on.why, /recorded world/);
});

test("pairedCompare: with the same per-row variance, more rows shrink the detectable change", () => {
  const six = stats.pairedCompare(draftWin, baseWin);
  const wideDraft = [];
  const wideBase = [];
  ["A", "B", "C", "D", "E", "F"].forEach((c) => {
    for (let m = 0; m < 2; m++) {
      wideDraft.push(row(c, m, true));
      wideBase.push(row(c, m, m === 1 && (c === "B" || c === "E")));
    }
  });
  const twelve = stats.pairedCompare(res(wideDraft), res(wideBase));
  assert.equal(twelve.rows, 12);
  assert.equal(twelve.verdict, "wins");
  assert.ok(twelve.mdeRows > 0 && twelve.mdeRows < six.mdeRows, `${twelve.mdeRows} vs ${six.mdeRows}`);
  assert.ok(Math.abs(twelve.mdeRows - 4.32) < 0.01, `mde ${twelve.mdeRows}`);
});

test("compareRuns: the band says wins, but the paired interval includes 0, so the verdict is within noise", () => {
  const draft = res(
    [row("A", 0, true), row("A", 1, true), row("B", 0, false), row("B", 1, false)],
    { score: band.bandOf([20, 21, 22], 30) },
  );
  const base = res(
    [row("A", 0, false), row("A", 1, false), row("B", 0, true), row("B", 1, true)],
    { score: band.bandOf([10, 11, 12], 30) },
  );
  const c = stats.compareRuns(draft, base);
  assert.equal(c.band.verdict, "wins");
  assert.equal(c.paired.verdict, "within noise");
  assert.equal(c.verdict, "within noise");
  assert.equal(c.paired.mean, 0);
});

test("compareRuns: with shared rows, the paired verdict decides", () => {
  const c = stats.compareRuns(draftWin, baseWin);
  assert.equal(c.verdict, "wins");
  assert.equal(c.paired.verdict, "wins");
  assert.ok(c.band.verdict);
});

test("compareRuns: with no rows, or no shared rows, it falls back to the noise band", () => {
  const draft = { pass: 16, total: 30, score: band.bandOf([15, 16, 17], 30) };
  const base = { pass: 13, total: 30, score: band.bandOf([11, 12, 13], 30) };
  const noRows = stats.compareRuns(draft, base);
  assert.equal(noRows.verdict, "wins");
  assert.equal(noRows.paired, null);
  assert.deepEqual(noRows.band, { verdict: "wins", why: noRows.band.why });

  const disjoint = stats.compareRuns(
    { ...res([row("X", 0, true), row("X", 1, true)]), score: draft.score },
    { ...res([row("Y", 0, false), row("Y", 1, false)]), score: base.score },
  );
  assert.equal(disjoint.paired, null);
  assert.equal(disjoint.verdict, "wins");

  const missing = stats.compareRuns(null, base);
  assert.equal(missing.verdict, "no base");
  assert.equal(missing.paired, null);
});
