import { describe, expect, test } from "@jest/globals";
import {
  IDLE,
  isLive,
  joinDictated,
  reduce,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
} from "../features/voice/dictation";

/**
 * The one property this feature is allowed to ship on: **an unsettled word
 * never reaches the file.**
 *
 * A note lands in the customer's own bucket (non-negotiable #1) and it is
 * theirs. A speech engine's interim results are not words somebody wrote; they
 * are the engine thinking out loud, and it revises them four or five times a
 * second. The mock draws them grey and italic and says outright that they are
 * "still being heard" — so if one of them could be autosaved, the interface
 * would be lying in the one place this product cannot afford to.
 *
 * `dictation.ts` is a pure reducer precisely so that claim is checkable by
 * exhaustion rather than by talking at a browser, which is what the first two
 * tests below do.
 *
 * ## Sabotage record
 *
 * Each applied to `features/voice/dictation.ts`, the suite run, the named test
 * observed failing, then reverted.
 *
 *  1. `interim` also returns `{ do: "insert", text: event.text }`.
 *     → `no interim, in any state, ever asks for an insert` and `a phrase
 *     revised nine times is inserted once, in its settled form` fail.
 *  2. `stop` inserts the pending interim before finalizing, "so nothing is
 *     lost".
 *     → `stopping mid-phrase inserts nothing by itself` fails. Note which does
 *     *not*: `a final arriving after stop is still kept` passes either way,
 *     because the engine's own final also arrives — which is exactly why the
 *     two are separate tests rather than one.
 *  3. `discard` emits `finalize` instead of `abandon`.
 *     → `discard settles nothing` fails.
 *  4. `discard` drops its `undoRun` effect.
 *     → `discard takes back what the run put in the note` fails.
 *  5. `stop` moves straight to `idle` rather than `stopping`.
 *     → `a final arriving after stop is still kept` fails — this is the
 *     dropped-last-sentence bug, and it is the reason `stopping` exists.
 *  6. `joinDictated` always prefixes a space.
 *     → `a phrase after an opening bracket closes up` and `punctuation closes
 *     up to the word before it` fail.
 *  7. `joinDictated` never prefixes a space.
 *     → `a phrase after a word is spaced off it` fails.
 */

/** Drive a list of events through the reducer, collecting every effect. */
function run(
  events: readonly DictationEvent[],
  from: DictationState = IDLE,
): { state: DictationState; effects: DictationEffect[] } {
  let state = from;
  const effects: DictationEffect[] = [];
  for (const event of events) {
    const step = reduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const inserts = (effects: readonly DictationEffect[]) =>
  effects.filter((e): e is { do: "insert"; text: string } => e.do === "insert");

const EVERY_STATE: DictationState[] = [
  IDLE,
  { name: "listening", interim: "" },
  { name: "listening", interim: "the handover is" },
  { name: "stopping", interim: "the handover is the one" },
  { name: "failed", reason: "denied" },
];

describe("an unsettled word never reaches the document", () => {
  test("no interim, in any state, ever asks for an insert", () => {
    for (const state of EVERY_STATE) {
      for (const text of ["", "t", "the", "the handover", "the handover is the one thing"]) {
        const step = reduce(state, { type: "interim", text });
        expect(inserts(step.effects)).toEqual([]);
      }
    }
  });

  test("a phrase revised nine times is inserted once, in its settled form", () => {
    const guesses = [
      "the",
      "the hand",
      "the handover",
      "the handover is",
      "the handover is the",
      "the handover is the one",
      "the handover is the one thing",
      "the handover is the one thing I",
      "the handover is the one thing I want",
    ];
    const { effects } = run([
      { type: "start" },
      ...guesses.map((text): DictationEvent => ({ type: "interim", text })),
      { type: "final", text: "The handover is the one thing I want landed." },
    ]);
    expect(inserts(effects)).toEqual([
      { do: "insert", text: "The handover is the one thing I want landed." },
    ]);
  });

  test("every interim is drawn as a ghost, and the settled one clears it", () => {
    const { effects } = run([
      { type: "start" },
      { type: "interim", text: "the hand" },
      { type: "interim", text: "the handover" },
      { type: "final", text: "The handover." },
    ]);
    expect(effects).toEqual([
      { do: "open" },
      { do: "ghost", text: "the hand" },
      { do: "ghost", text: "the handover" },
      { do: "ghost", text: "" },
      { do: "insert", text: "The handover." },
    ]);
  });

  test("an empty final inserts nothing, but still clears the ghost", () => {
    const { effects } = run([
      { type: "start" },
      { type: "interim", text: "erm" },
      { type: "final", text: "   " },
    ]);
    expect(inserts(effects)).toEqual([]);
    expect(effects.at(-1)).toEqual({ do: "ghost", text: "" });
  });
});

describe("stopping", () => {
  test("stopping mid-phrase inserts nothing by itself", () => {
    const { state, effects } = run([
      { type: "start" },
      { type: "interim", text: "and the second thing is whether we" },
      { type: "stop" },
    ]);
    expect(inserts(effects)).toEqual([]);
    expect(state).toEqual({ name: "stopping", interim: "and the second thing is whether we" });
  });

  test("stop asks the engine to settle, never to abandon", () => {
    const { effects } = run([{ type: "start" }, { type: "stop" }]);
    expect(effects).toContainEqual({ do: "finalize" });
    expect(effects).not.toContainEqual({ do: "abandon" });
  });

  test("a final arriving after stop is still kept", () => {
    const { state, effects } = run([
      { type: "start" },
      { type: "interim", text: "and the second thing is whether we" },
      { type: "stop" },
      { type: "final", text: "And the second thing is whether we say no now." },
      { type: "ended" },
    ]);
    expect(inserts(effects)).toEqual([
      { do: "insert", text: "And the second thing is whether we say no now." },
    ]);
    expect(state).toEqual(IDLE);
  });

  test("the ghost is gone once the engine has closed", () => {
    const { state, effects } = run([
      { type: "start" },
      { type: "interim", text: "half a sentence" },
      { type: "stop" },
      { type: "ended" },
    ]);
    expect(effects.at(-1)).toEqual({ do: "ghost", text: "" });
    expect(state).toEqual(IDLE);
  });
});

describe("discarding", () => {
  test("discard settles nothing", () => {
    const { effects } = run([
      { type: "start" },
      { type: "interim", text: "scratch that" },
      { type: "discard" },
    ]);
    expect(effects).toContainEqual({ do: "abandon" });
    expect(effects).not.toContainEqual({ do: "finalize" });
    expect(inserts(effects)).toEqual([]);
  });

  test("discard takes back what the run put in the note", () => {
    const { state, effects } = run([
      { type: "start" },
      { type: "final", text: "One sentence that landed." },
      { type: "discard" },
    ]);
    expect(effects).toContainEqual({ do: "undoRun" });
    expect(state).toEqual(IDLE);
  });
});

describe("failing", () => {
  test("a refused microphone closes the engine and clears the ghost", () => {
    const { state, effects } = run([
      { type: "start" },
      { type: "interim", text: "hello" },
      { type: "error", reason: "denied" },
    ]);
    expect(state).toEqual({ name: "failed", reason: "denied" });
    expect(effects).toContainEqual({ do: "abandon" });
    expect(effects).toContainEqual({ do: "ghost", text: "" });
    expect(inserts(effects)).toEqual([]);
  });

  test("a failure is not sticky: pressing the button again opens the microphone", () => {
    const { state, effects } = run([{ type: "start" }], { name: "failed", reason: "denied" });
    expect(state).toEqual({ name: "listening", interim: "" });
    expect(effects).toEqual([{ do: "open" }]);
  });

  test("pressing start while already listening opens nothing twice", () => {
    const { effects } = run([{ type: "start" }, { type: "start" }]);
    expect(effects.filter((e) => e.do === "open")).toHaveLength(1);
  });
});

describe("isLive", () => {
  test("is true exactly while the microphone is open or owes words", () => {
    expect(isLive(IDLE)).toBe(false);
    expect(isLive({ name: "listening", interim: "" })).toBe(true);
    expect(isLive({ name: "stopping", interim: "x" })).toBe(true);
    expect(isLive({ name: "failed", reason: "unreachable" })).toBe(false);
  });
});

describe("joining a dictated phrase to what is already there", () => {
  test("a phrase after a word is spaced off it", () => {
    expect(joinDictated("the probe", "is still the blocker")).toBe(" is still the blocker");
  });

  test("a phrase at the very start of a document gets no leading space", () => {
    expect(joinDictated("", "Standing agenda first.")).toBe("Standing agenda first.");
  });

  test("a phrase after whitespace or a newline gets no leading space", () => {
    expect(joinDictated("## Today\n", "The handover")).toBe("The handover");
    expect(joinDictated("a list of ", "things")).toBe("things");
  });

  test("a phrase after an opening bracket closes up", () => {
    expect(joinDictated("the probe (", "see the runbook")).toBe("see the runbook");
    expect(joinDictated("he said “", "no")).toBe("no");
  });

  test("punctuation closes up to the word before it", () => {
    expect(joinDictated("the probe", ", and the second thing")).toBe(", and the second thing");
    expect(joinDictated("done", ".")).toBe(".");
  });

  test("an empty or whitespace-only phrase inserts nothing at all", () => {
    expect(joinDictated("anything", "")).toBe("");
    expect(joinDictated("anything", "   \n ")).toBe("");
  });

  test("the phrase is trimmed, so an engine's own padding never doubles a space", () => {
    expect(joinDictated("the probe", "  is still the blocker  ")).toBe(" is still the blocker");
  });
});
