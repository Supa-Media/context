import assert from "node:assert/strict";
import { test } from "node:test";
import { timed, timesLine } from "../bench/setsPool.mjs";

// Dev runs took 16 minutes with no line saying which tests held them (2026-11-26). Sabotage: drop `finally` in timed and
// the failing test has no time; sort ascending in timesLine and the slowest is not named first.
test("a run's Front door tests each keep their time, and one line names the slowest, ids only", async () => {
  let clock = 0;
  const now = () => clock;
  const work = timed(async (t) => {
    clock += t.takes;
    if (t.fails) throw new Error("boom");
  }, now);
  const tests = [{ id: "wedding-trip", name: "sets-1", cases: 2, takes: 400_000 }, { id: "the-flat", name: "sets-2", cases: 1, takes: 60_000, fails: true }];
  for (const t of tests) await work(t).catch(() => {});
  assert.deepEqual(tests.map((t) => t.ms), [400_000, 60_000], "a test that throws still keeps its time");
  const line = timesLine(tests, { lanes: 24, wallMs: 400_000 });
  assert.match(line, /^fd tests: 2 in 24 lanes, wall 400 s, sum 460 s, mean 230 s; slowest: wedding-trip\/sets-1 2 case\(s\) 400 s, the-flat\/sets-2/);
});

// Dev run v57ws37 (2026-11-26) took 18 minutes on a runner using under one core of four: the line now says whether the
// answer, the judge or the background jobs held a test. Sabotage: drop `splitOf`'s job count and the totals say 0 jobs.
test("each test says how its time split between answer, judge and the jobs it ran", async () => {
  const { splitOf } = await import("../bench/coreArea.mjs");
  const tests = [
    { id: "wedding-trip", name: "sets-8", cases: 2, ms: 566_000, split: { answerMs: 540_000, judgeMs: 26_000, turnS: 61.4, jobs: 2, parts: 5 } },
    { id: "the-flat", name: "sets-2", cases: 1, ms: 40_000, split: { answerMs: 30_000, judgeMs: 10_000, turnS: 22, jobs: 0, parts: 0 } },
  ];
  const line = timesLine(tests, { lanes: 24, wallMs: 566_000 });
  assert.match(line, /; answer 570 s, judge 36 s, 2 job\(s\) in 1 test\(s\); slowest: wedding-trip\/sets-8 2 case\(s\) 566 s \(answer 540 s, turns 61 s, judge 26 s, 2 job\(s\) 5 part\(s\)\)/);
  assert.match(timesLine([{ id: "x", name: "sets-1", ms: 1000 }], { lanes: 1, wallMs: 1000 }), /mean 1 s; slowest: x\/sets-1 1 case\(s\) 1 s$/, "a test with no split reads as before");
  assert.equal(typeof splitOf, "function");
});
