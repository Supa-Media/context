/**
 * THE ORGANIZATION SCORE: does a sweep actually tidy a messy workspace?
 *
 * Dev2, 2026-10-05: auto-organize "just never really worked". Each piece had
 * its own tests, but nothing ran a whole sweep over a whole workspace and
 * looked at the result. This does: `organizerEval/workspace.helpers.ts` is a
 * messy workspace where every note has one right end state, and the score is
 * the share that end up there.
 *
 * The model is a stand-in here, so this proves the plumbing and the rules: a
 * reader that answers every question correctly must take the workspace to 90%
 * or better, and a model that answers nothing must leave it exactly as it was.
 * Whether the real model reads well enough is `organizerEval.live.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { NOTES, NOW, OWNER, messyWorkspace, misses, organizationScore } from "./organizerEval/workspace.helpers";
import { gatherOrganizerWork } from "../functions/lib/organizer/sweepOps";
import { type AiBinding, knowsTheAnswers, localWorker, runSweep } from "./organizerEval/sweep.helpers";

const failsEveryTime: AiBinding = {
  async run() {
    throw new Error("upstream unavailable");
  },
};

describe("the organization score", () => {
  test("the messy workspace starts out badly organized", () => {
    const { store } = messyWorkspace();
    const { score } = organizationScore(store.snapshot());
    expect(score).toBeGreaterThan(0.15);
    expect(score).toBeLessThan(0.4);
  });

  test("a sweep with a reader that answers correctly organizes it to 90% or better", async () => {
    const { store } = messyWorkspace();
    const report = await runSweep(store, localWorker(knowsTheAnswers));
    expect(report.refusals).toEqual([]);
    expect(report.finish).toBe("done");
    const { score, items } = organizationScore(store.snapshot());
    expect(score, misses(items)).toBeGreaterThanOrEqual(0.9);
  });

  test("a model that answers nothing moves nothing it would have had to ask about, and the sweep says it failed", async () => {
    const { store } = messyWorkspace();
    const before = store.snapshot();
    const report = await runSweep(store, localWorker(failsEveryTime));
    expect(report.answered).toBe(0);
    expect(report.finish).toBe("failed");
    expect(report.why).toBe("no_answers");
    const after = store.snapshot();
    // Archiving a finished, quiet project asks no question, so only it still happens.
    for (const fixture of NOTES) {
      if (fixture.expected?.kind === "archive") continue;
      expect(after[fixture.path], fixture.path).toBe(before[fixture.path]);
    }
  });
});

describe("what a sweep reads", () => {
  test("inbox notes past one batch's byte budget are still read, not silently skipped", async () => {
    const { store } = messyWorkspace();
    // Three notes of 1.5 MB: a batch reads two before its 4 MB budget is spent.
    for (const name of ["big-a", "big-b", "big-c"]) {
      store.seed(`0-inbox/${name}.md`, `# ${name}\n\n${"word ".repeat(300_000)}\n`);
    }
    const work = await gatherOrganizerWork(store, OWNER, NOW);
    const inbox = work.items.filter((item) => item.kind === "inbox").map((item) => (item as { note: { path: string } }).note.path);
    expect(inbox).toEqual(expect.arrayContaining(["0-inbox/big-a.md", "0-inbox/big-b.md", "0-inbox/big-c.md"]));
  });
});
