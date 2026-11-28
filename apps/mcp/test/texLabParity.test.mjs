/**
 * The Lab's parity check (`scripts/tex-lab-parity.mjs`): the estimate costs a run before it is made, and the comparison
 * says whether the sandbox's bench run and GitHub's run agree within their noise. Made-up results only; ids are fake.
 *
 * Sabotage: an estimate that prices a judge call as a Tex turn, a noise band that ignores one side, or a comparison
 * that compares different commits fails these.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { benchUnits, runConversations } from "../../../packages/lab/src/labRunSets.mjs";
import { compareParity, estimateParity, estimateText, parityText, resultsFrom } from "../../../scripts/tex-lab-parity.mjs";

const REPO = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/lab/src/texSetsRepo.generated.json", import.meta.url)), "utf8")).sets;

/** A results object as `resultsOf` makes it, for fake conversations `conv-a` and `conv-b`. */
function results({ mean = 6, min = 5, max = 7, total = 10, repeats = 3, perConv, fallbacks = 0, valid = true, couldNotRun = [], rows = [] } = {}) {
  return {
    pass: mean,
    total,
    score: { mean, min, max, lo: mean, hi: mean, repeats, total },
    repeats,
    couldNotRun,
    fallbacks,
    valid,
    costUsd: 1.25,
    perConv: perConv ?? [
      { id: "conv-a", pass: 4, total: 6, min: 3, max: 5 },
      { id: "conv-b", pass: 2, total: 4, min: 1, max: 3 },
    ],
    perNode: [{ node: "fd", pass: mean, total, min, max }],
    rows,
  };
}

const row = (convId, msgIndex, ok, extra = {}) => ({ convId, msgIndex, node: "fd", ok, ...extra });

test("estimate: the real Training set's units, runnable share, turns, judge calls and dollars", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the estimate must not call the network");
  };
  try {
    const e = estimateParity({ set: "training", repeats: 3, repo: REPO });
    const units = benchUnits(runConversations("training", REPO, []), 1).length;
    assert.equal(e.units, units);
    assert.ok(units > 0);
    assert.ok(e.sandboxRunnable < units, "the sandbox runs fewer units than the set has");
    assert.equal(e.sandboxRunnable + e.sandboxCannot.total, units);
    assert.equal(e.sandboxCannot.total, Object.values(e.sandboxCannot.byReason).reduce((a, b) => a + b, 0));
    assert.equal(e.sides.github.turns, units * 3);
    assert.equal(e.sides.sandbox.turns, e.sandboxRunnable * 3);
    assert.equal(e.sides.total.turns, e.sides.sandbox.turns + e.sides.github.turns);
    assert.equal(e.sides.github.judgeCalls, e.sides.github.turns * 3);
    assert.equal(e.sides.sandbox.judgeCalls, e.sides.sandbox.turns * 3);
    assert.ok(e.sides.total.totalUsd > 0);
    assert.ok(e.sides.total.texUsd > 0 && e.sides.total.judgeUsd > 0);
    const text = estimateText(e);
    assert.match(text, /assumptions: Tex claude-sonnet-5-5, 30000 input and 1500 output tokens a turn/);
    assert.match(text, /judge claude-haiku-5-5, 6000 input and 600 output tokens a call, 3 votes/);
    assert.match(text, /^github: expected Tex turns \d+, judge calls \d+/m);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("estimate: a sandbox unit with a via, a kind or pictures is not runnable", () => {
  const repo = [
    { id: "conv-a", set: "dev", msgs: [{ id: "m1", who: "x", text: "hi", tex: false, labels: { fd: { star: true } } }] },
    {
      id: "conv-b",
      set: "dev",
      msgs: [{ id: "m1", who: "x", text: "hi", via: "email", labels: { fd: { star: true } } }, { id: "m2", who: "x", text: "a", kind: "react", labels: { fd: { star: true } } }, { id: "m3", who: "x", text: "b", pics: ["p"], labels: { fd: { star: true } } }],
    },
  ];
  const e = estimateParity({ set: "dev", repeats: 1, repo });
  assert.equal(e.units, 4);
  assert.equal(e.sandboxRunnable, 1);
  assert.deepEqual(e.sandboxCannot.byReason, { "a email trigger": 1, "a react": 1, pictures: 1 });
});

test("estimate: a set's units are walked once per repeat on the GitHub side", () => {
  const e1 = estimateParity({ set: "dev", repeats: 1, repo: REPO });
  const e3 = estimateParity({ set: "dev", repeats: 3, repo: REPO });
  assert.equal(e3.sides.github.turns, e1.sides.github.turns * 3);
  assert.equal(e3.sides.sandbox.judgeCalls, e3.sides.sandbox.turns * 3);
});

test("compare: two identical runs are within noise", () => {
  const a = results({ rows: [row("conv-a", 0, true), row("conv-b", 1, false, { passes: 0, runs: 3 })] });
  const cmp = compareParity(a, structuredClone(a), { sandboxCommit: "abc123", githubCommit: "abc123" });
  assert.equal(cmp.verdict, "within noise");
  const overall = cmp.metrics.find((m) => m.metric === "overall pass rate");
  assert.equal(overall.withinNoise, true);
  assert.equal(overall.sandbox, 0.6);
  assert.equal(cmp.rows.shared, 2);
  assert.equal(cmp.rows.agree, 2);
});

test("compare: a delta bigger than both bands is outside noise and names the metric", () => {
  const s = results({ mean: 9, min: 8.5, max: 9.5 });
  const g = results({ mean: 3, min: 2.5, max: 3.5 });
  const cmp = compareParity(s, g, { sandboxCommit: "abc", githubCommit: "abc" });
  assert.match(cmp.verdict, /^outside noise/);
  assert.match(cmp.verdict, /overall pass rate/);
  assert.equal(cmp.metrics.find((m) => m.metric === "overall pass rate").withinNoise, false);
  assert.match(parityText(cmp), /verdict: outside noise: overall pass rate/);
});

test("compare: one repeat on a side gives noise 0 and says repeats are needed", () => {
  const s = results({ repeats: 1, mean: 6, min: 6, max: 6 });
  const g = results({ mean: 6, min: 5, max: 7 });
  const cmp = compareParity(s, g, { sandboxCommit: "abc", githubCommit: "abc" });
  const overall = cmp.metrics.find((m) => m.metric === "overall pass rate");
  assert.equal(overall.noise, 0);
  assert.ok(cmp.notes.some((n) => /repeats are needed/.test(n)));
});

test("compare: different commits are not comparable", () => {
  const a = results();
  const cmp = compareParity(a, structuredClone(a), { sandboxCommit: "abc", githubCommit: "def" });
  assert.equal(cmp.verdict, "not comparable");
  assert.match(cmp.notes[0], /different commits/);
});

test("compare: a missing side and different sets are not comparable", () => {
  assert.equal(compareParity(results(), null).verdict, "not comparable");
  const other = results({ perConv: [{ id: "conv-z", pass: 1, total: 2, min: 1, max: 1 }] });
  assert.equal(compareParity(results(), other).verdict, "not comparable");
});

test("compare: a sandbox fallback is outside noise and names fallbacks", () => {
  const s = results({ fallbacks: 1 });
  const g = results();
  const cmp = compareParity(s, g, { sandboxCommit: "abc", githubCommit: "abc" });
  assert.match(cmp.verdict, /^outside noise/);
  assert.match(cmp.verdict, /fallbacks/);
  assert.equal(cmp.metrics.find((m) => m.metric === "fallbacks").withinNoise, false);
});

test("compare: the rows list units that disagree and units only one side counted", () => {
  const s = results({
    rows: [row("conv-a", 0, true, { passes: 3, runs: 3 }), row("conv-a", 1, false, { passes: 0, runs: 3 }), row("conv-b", 0, true), row("conv-b", 2, true, { ran: false })],
  });
  const g = results({ rows: [row("conv-a", 0, false, { passes: 1, runs: 3 }), row("conv-a", 1, false, { passes: 0, runs: 3 }), row("conv-b", 0, true), row("conv-b", 2, true)] });
  const cmp = compareParity(s, g, { sandboxCommit: "abc", githubCommit: "abc" });
  assert.equal(cmp.rows.shared, 3);
  assert.equal(cmp.rows.agree, 2);
  assert.equal(cmp.rows.disagree.units[0].unit, "conv-a|0|fd");
  assert.deepEqual(cmp.rows.disagree.units[0].sandbox, { ok: true, passes: 3, runs: 3 });
  assert.equal(cmp.rows.onlySandbox.count, 0);
  assert.deepEqual(cmp.rows.onlyGithub.units, ["conv-b|2|fd"]);
});

test("resultsFrom: accepts the run shapes a file may hold", () => {
  const r = results();
  assert.equal(resultsFrom(r).results, r);
  assert.equal(resultsFrom({ status: "ok", run: { commit: "abc", results: r } }).commit, "abc");
  assert.equal(resultsFrom({ status: "ok", run: { commit: "abc", results: r } }).results, r);
  assert.equal(resultsFrom({ run: { results: r } }).results, r);
});
