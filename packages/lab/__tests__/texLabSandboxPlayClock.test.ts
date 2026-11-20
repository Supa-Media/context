/**
 * `stepPlayClock` is how a page test moves the Lab playback (`texLabSandboxDock.test.ts`). The head has to move by
 * exactly the milliseconds asked. The tick looks the run up between two reads of the clock, and on a slow runner those
 * reads are a few milliseconds apart, which is what made "500 ms / 3.5 s" come back "503 ms" (CI run 44206817085).
 *
 * Every name here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-18): `tick` taking its step from the wall clock
 * between its two reads -> this test receives 503, not 500.
 */
import { afterEach, expect, test } from "@jest/globals";
import { resetSandboxState, sandbox } from "@context/lab/app/engine/sandbox";
import { holdPlayClock, playHead, playRun, resetPlay, stepPlayClock } from "@context/lab/app/engine/sandboxPlay";
import { set } from "@context/lab/app/engine/state";

/** How far `performance.now` jumps on every read, the gap a slow tick used to add to the step. */
const DRIFT_MS = 3;

afterEach(() => {
  resetPlay();
  resetSandboxState();
  holdPlayClock(false);
  set({ speed: 0.5, sel: null, pin: false });
});

test("a stepped clock moves the head by exactly the milliseconds asked while the clock moves during the tick", () => {
  holdPlayClock(true);
  set({ speed: 1, sel: null, pin: false });
  sandbox.rows = [
    {
      id: "t1",
      who: "Maya",
      text: "add the gig",
      at: 1_000,
      steps: [{ id: "a", node: "triage", at: 0, ms: 10_000, out: "to: judge" }],
    },
  ];
  let now = 1_000_000;
  const clock = performance as { now: () => number };
  const orig = clock.now.bind(performance);
  clock.now = () => {
    now += DRIFT_MS;
    return now;
  };
  try {
    expect(playRun("t1", 0)).toBe(true);
    expect(playHead()?.t).toBe(0);
    stepPlayClock(500);
    // 500, not 500 plus the milliseconds the tick spent between its two clock reads.
    expect(playHead()?.t).toBe(500);
  } finally {
    clock.now = orig;
  }
});
