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
import { NOTES, messyWorkspace, misses, organizationScore } from "./organizerEval/workspace.helpers";
import { type AiBinding, localWorker, runSweep } from "./organizerEval/sweep.helpers";

function humanize(segment: string): string {
  const words = segment.replace(/\.md$/i, "").replace(/^\d+-/, "").replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function headingOf(text: string): string {
  return /^# (.+)$/m.exec(text)?.[1]?.trim() ?? "";
}

/**
 * A reader that knows the right answer to every question, from the fixture.
 * It answers in Clef's output shape, probabilities and all.
 */
const knowsTheAnswers: AiBinding = {
  async run(_model, input) {
    const { state, questions } = input as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
    const first = state.split("\n")[0] ?? "";
    const heading = first.replace(/^(Project|Note): /, "");
    const fixture = NOTES.find((note) => headingOf(note.text) === heading);
    if (!fixture?.expected) throw new Error(`no fixture for ${first}`);
    const expected = fixture.expected;
    if (first.startsWith("Project: ")) {
      const done = expected.kind === "done";
      const stage = done ? "done" : /status: blocked/.test(fixture.text) ? "blocked" : "active";
      const probabilities = { active: 0.05, blocked: 0.05, done: 0.05, unclear: 0.05, [stage]: 0.85 };
      return {
        model: "clef",
        answers: {
          stage: { type: "choice", choice: stage, confidence: 0.85, probabilities },
          shipped: { type: "noul", noul: done ? 0.9 : 0.1 },
          open_steps: { type: "noul", noul: done ? 0.1 : 0.9 },
        },
        usage: { input_tokens: 400, output_tokens: 3 },
      };
    }
    const options = questions.destination!.criteria;
    const choice =
      expected.kind === "file"
        ? Object.keys(options).find((key) => options[key]!.startsWith(`${humanize(expected.folder.split("/").pop()!)} (`))
        : "stay";
    if (!choice) throw new Error(`no option for ${expected.kind === "file" ? expected.folder : "stay"}`);
    const keys = Object.keys(options);
    const rest = (1 - 0.8) / (keys.length - 1);
    const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.8 : rest]));
    return {
      model: "clef",
      answers: { destination: { type: "choice", choice, confidence: 0.8, probabilities } },
      usage: { input_tokens: 300, output_tokens: 1 },
    };
  },
};

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
    const after = store.snapshot();
    // Archiving a finished, quiet project asks no question, so only it still happens.
    for (const fixture of NOTES) {
      if (fixture.expected?.kind === "archive") continue;
      expect(after[fixture.path], fixture.path).toBe(before[fixture.path]);
    }
  });
});
