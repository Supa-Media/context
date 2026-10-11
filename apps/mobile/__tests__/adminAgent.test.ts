/**
 * The Agent tab's arithmetic and words (`features/admin/agent.ts`).
 *
 * The figures come from `agentReport`; what these check is that a person
 * reads them right: a faster week is good news, a step's bar starts where the
 * one before it ended, and the slowest step is named against its own typical
 * time rather than against the turn.
 */

import { describe, expect, test } from "@jest/globals";
import {
  countChange,
  formatSeconds,
  outcomeLabel,
  outcomeTone,
  percentOf,
  slowestStep,
  stepStrip,
  timeChange,
  timeShares,
  toolLabel,
  waterfall,
} from "../features/admin/agent";

describe("times", () => {
  test("seconds read the way a person says them", () => {
    expect(formatSeconds(0)).toBe("—");
    expect(formatSeconds(Number.NaN)).toBe("—");
    expect(formatSeconds(420)).toBe("0.4 s");
    expect(formatSeconds(4_240)).toBe("4.2 s");
    expect(formatSeconds(42_000)).toBe("42 s");
    expect(formatSeconds(72_000)).toBe("1 m 12 s");
  });

  test("faster than before is good news, slower is bad, a hair is the same", () => {
    expect(timeChange(3_000, 3_600, 10, 7)).toEqual({ text: "0.6 s faster than the 7 days before", tone: "ok" });
    expect(timeChange(5_000, 3_000, 10, 1)).toEqual({ text: "2.0 s slower than the day before", tone: "crit" });
    expect(timeChange(3_000, 3_020, 10, 7).text).toBe("Same as the 7 days before");
    // Nothing before is not "infinitely faster".
    expect(timeChange(3_000, 0, 0, 30)).toEqual({ text: "Nothing to compare with the 30 days before", tone: "neutral" });
  });

  test("question counts change by a signed whole number", () => {
    expect(countChange(12, 4, 7)).toBe("+8 vs the 7 days before");
    expect(countChange(2, 4, 7)).toBe("−2 vs the 7 days before");
    expect(countChange(4, 4, 1)).toBe("±0 vs the day before");
    expect(percentOf(1, 0)).toBe(0);
    expect(percentOf(1, 3)).toBe(33);
  });

  test("where the time goes adds up, and Other is never negative", () => {
    const base = { turns: 2, workspaces: 1, p50: 0, p95: 0, answered: 2, exhausted: 0, failed: 0, toolCalls: 1 };
    const shares = timeShares({ ...base, totalMs: 10_000, modelMs: 6_000, toolMs: 3_000 });
    expect(shares.map((share) => share.percent)).toEqual([60, 30, 10]);
    const over = timeShares({ ...base, totalMs: 1_000, modelMs: 800, toolMs: 400 });
    expect(over[2].ms).toBe(0);
  });
});

describe("names", () => {
  test("tools get plain names, and an unknown one is still readable", () => {
    expect(toolLabel("search_web")).toBe("Search the web");
    expect(toolLabel("read_note")).toBe("Read a note");
    expect(toolLabel("brand_new_tool")).toBe("Brand new tool");
  });

  test("each ending has its words and its tone", () => {
    expect([outcomeLabel("answered"), outcomeTone("answered")]).toEqual(["Answered", "ok"]);
    expect([outcomeLabel("exhausted"), outcomeTone("exhausted")]).toEqual(["Ran out of steps", "warn"]);
    expect([outcomeLabel("failed"), outcomeTone("failed")]).toEqual(["Failed", "crit"]);
  });
});

describe("one question, step by step", () => {
  const turn = {
    ms: 10_000,
    trace: [
      { kind: "model" as const, ok: true, ms: 2_000 },
      { kind: "tool" as const, tool: "search_web", ok: true, ms: 3_000 },
      { kind: "tool" as const, tool: "read_note", ok: false, ms: 1_000 },
      { kind: "model" as const, ok: true, ms: 2_000 },
    ],
  };

  test("each step starts where the one before ended, on the whole answer's axis", () => {
    const steps = waterfall(turn);
    expect(steps.map((step) => [step.left, step.width])).toEqual([
      [0, 20],
      [20, 30],
      [50, 10],
      [60, 20],
    ]);
    // What no step accounts for is space at the end, not stretched bars.
    expect(steps[3].left + steps[3].width).toBe(80);
    expect(steps.map((step) => step.label)).toEqual(["Thinking", "Search the web", "Read a note", "Thinking"]);
    expect(stepStrip(turn).map((step) => step.kind)).toEqual(["model", "tool", "tool", "model"]);
  });

  test("a trace longer than the recorded time still fits the axis", () => {
    const steps = waterfall({ ms: 1_000, trace: [{ kind: "model", ok: true, ms: 1_500 }, { kind: "tool", tool: "x", ok: true, ms: 500 }] });
    expect(steps[1].left + steps[1].width).toBe(100);
  });

  test("the slowest step is named against that lookup's typical time", () => {
    expect(slowestStep(turn.trace, new Map([["search_web", 1_000]]))).toEqual({
      index: 1,
      sentence: "Search the web took 3.0 s here, about 3× its typical 1.0 s.",
    });
    expect(slowestStep(turn.trace, new Map([["search_web", 2_800]]))?.sentence).toBe(
      "Search the web took 3.0 s here, close to its typical 2.8 s.",
    );
    expect(slowestStep(turn.trace, new Map())?.sentence).toBe("Search the web was the slowest step, at 3.0 s.");
    expect(slowestStep([{ kind: "model", ok: true, ms: 900 }], new Map())?.sentence).toBe(
      "A thinking round was the slowest step, at 0.9 s.",
    );
    expect(slowestStep([], new Map())).toBeNull();
  });
});
