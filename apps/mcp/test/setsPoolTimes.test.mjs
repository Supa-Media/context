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
