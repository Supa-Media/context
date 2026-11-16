/**
 * A sandbox text as the one run shape every Lab playback uses (`engine/sandboxRun.ts`; Lab live sandbox, approved by
 * Dev2 2026-11-16): logged times when the gateway sends them, the old back-to-back order when it doesn't, a running
 * text that grows by the clock, and the steps behind one of Tex's texts only from its logged `cause`.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `sandboxRun` ignoring a step's logged `at` -> "logged start times are kept" (and three more) fail;
 *  2. `litAt` lighting a step before its `at` -> "the canvas lights only what started" fails;
 *  3. `packSteps` ignoring `minMs` -> "density ... packed rows" fails.
 */
import { describe, expect, test } from "@jest/globals";
import { densityFor, litAt, packSteps, runById, runStart, sandboxRun, scaleOf, stepsAt, texCauseRun, trackOrder, type RunRowIn } from "../features/tex/lab/engine/sandboxRun";
import { rowOf } from "../features/tex/lab/engine/sandbox";

const old: RunRowIn[] = [
  { id: "t1", text: "add the gig", at: 1_000, steps: [{ node: "triage", ms: 2 }, { node: "decide", ms: 400 }, { node: "fd", ms: null }, { node: "send", ms: 30 }] },
  { id: "t1r", text: "Added it.", tex: true, reply: "t1", at: 1_600 },
];

const logged: RunRowIn[] = [
  {
    id: "t2",
    text: "email jo",
    at: 10_000,
    steps: [
      { id: "s1", node: "text", at: 850, ms: 3 },
      { id: "s2", node: "decide", at: 860, ms: 390, model: "clef" },
      { id: "s3", node: "fd", at: 1_300, ms: 3_900, tokIn: 17_900, cost: 0.0031, calls: [{ tool: "email.send", kind: "write", ms: 410, d: "held in the sandbox" }] },
      { id: "s4", node: "tools", at: 2_100, ms: 410, parent: "s3" },
      { id: "s5", node: "send", at: 5_300, ms: 8 },
      { id: "s6", node: "selfreview", at: 5_400, ms: 1_200, bg: true },
    ],
  },
  { id: "t2r", text: "Sent it to Jo.", tex: true, reply: "t2", at: 16_150, cause: ["s1", "s2", "s3", "s5"] },
  { id: "t2q", text: "", tex: true, reply: "t2", at: 16_200, quiet: true },
];

describe("sandboxRun", () => {
  test("a row without `at` plays back to back, as the Lab always played it", () => {
    const r = sandboxRun(old[0], old)!;
    expect(r.steps.map((s) => [s.node, s.at, s.ms])).toEqual([
      ["triage", 0, 2],
      ["decide", 2, 400],
      ["fd", 402, 1],
      ["send", 403, 30],
    ]);
    expect(r.texts).toEqual([{ rowId: "t1r", at: 600 }]);
    expect(r.total).toBe(600);
    expect(r.running).toBe(false);
    expect(r.steps[0].id).toBe("t1.0");
  });

  test("logged start times are kept, with every field a step logged", () => {
    const r = sandboxRun(logged[0], logged)!;
    expect(r.steps.map((s) => s.at)).toEqual([850, 860, 1_300, 2_100, 5_300, 5_400]);
    expect(r.steps[2]).toMatchObject({ id: "s3", tokIn: 17_900, cost: 0.0031, calls: [{ tool: "email.send", kind: "write" }] });
    expect(r.steps[3].parent).toBe("s3");
    expect(r.steps[5].bg).toBe(true);
    // A quiet reply was not delivered.
    expect(r.texts).toEqual([{ rowId: "t2r", at: 6_150 }]);
    expect(r.total).toBe(6_600);
    expect(trackOrder(r)).toEqual(["text", "decide", "fd", "tools", "send", "selfreview"]);
  });

  test("a running text grows by the clock, its running step has no time yet, and the step the gateway names counts", () => {
    const rows: RunRowIn[] = [{ id: "t3", at: 50_000, steps: [{ id: "a", node: "text", at: 0, ms: 3 }, { id: "b", node: "decide", at: 10, ms: null }] }];
    const r = sandboxRun(rows[0], rows, { running: "t3", hot: "decide", now: 52_000 })!;
    expect(r.running).toBe(true);
    expect(r.steps[1].ms).toBeUndefined();
    expect(r.steps.length).toBe(2);
    expect(r.total).toBe(2_000);
    // An old running row (no `at`): the step named running starts after the last one logged.
    const o: RunRowIn[] = [{ id: "t4", at: 0, steps: [{ node: "triage", ms: 2 }] }];
    const r2 = sandboxRun(o[0], o, { running: "t4", hot: "decide", now: 900 })!;
    expect(r2.steps.map((s) => [s.node, s.at, s.ms])).toEqual([
      ["triage", 0, 2],
      ["decide", 2, undefined],
    ]);
    expect(sandboxRun({ id: "x" }, [])).toBeNull();
  });

  test("the canvas lights only what started, each running step part way", () => {
    const r = sandboxRun(logged[0], logged)!;
    expect([...litAt(r, 0).lit]).toEqual([]);
    const at = litAt(r, 2_300);
    expect(at.lit.get("decide")).toBe(1);
    expect(at.lit.get("fd")).toBeCloseTo(1_000 / 3_900);
    expect(at.lit.has("send")).toBe(false);
    expect(at.running).toBe("tools");
    expect(stepsAt(r, 2_300).map((s) => [s.node, s.running, s.elapsed])).toEqual([
      ["text", false, 3],
      ["decide", false, 390],
      ["fd", true, 1_000],
      ["tools", true, 200],
    ]);
  });

  test("Tex's text plays only the steps its `cause` names; no cause, no run", () => {
    const r = texCauseRun("t2r", logged)!;
    expect(r.id).toBe("t2#t2r");
    expect(r.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s5"]);
    expect(r.of).toBe("t2");
    expect(runStart(r)).toBe(850);
    expect(runById("t2#t2r", logged)?.steps.length).toBe(4);
    expect(texCauseRun("t1r", old)).toBeNull();
    expect(texCauseRun("t2q", logged)).toBeNull();
    expect(runById("t1", old)?.id).toBe("t1");
    expect(runById("t1r", old)).toBeNull();
  });

  test("density by the height the tracks have, packed rows, and a scale that grows while live", () => {
    expect(densityFor(200, 9)).toBe("full");
    expect(densityFor(120, 9)).toBe("compact");
    expect(densityFor(90, 9)).toBe("packed");
    const r = sandboxRun(logged[0], logged)!;
    // fd overlaps tools and the background step overlaps nothing: two rows.
    expect(packSteps(r.steps, 0).map((x) => x.map((s) => s.node))).toEqual([["text", "decide", "fd", "send", "selfreview"], ["tools"]]);
    // A short step holds its minimum, so the next one goes under it.
    expect(packSteps(r.steps, 300).map((x) => x.map((s) => s.node))).toEqual([["text", "fd", "send"], ["decide", "tools", "selfreview"]]);
    expect(scaleOf(r, 1_000, true)).toBe(4_000);
    expect(scaleOf(r, 10_000, true)).toBe(11_500);
    expect(scaleOf(r, 1_000, false)).toBe(6_600);
  });

  test("the gateway's row keeps the contract's fields, and a JSON output reads as one line in the grid", () => {
    const row = rowOf({ id: "t9r", who: "Tex", text: "hi", reply: "t9", cause: ["a", 3, "b"], from: "job", steps: [{ id: "a", node: "fd", at: 5, ms: 9, out: { reply: "hi" }, in: { text: "yo" }, think: "short", bg: true, calls: [{ tool: "notes.read", kind: "read", ms: 3, d: "ran" }] }] });
    expect(row).toMatchObject({ reply: "t9", cause: ["a", "b"], from: "job" });
    expect(row.steps![0]).toMatchObject({ id: "a", at: 5, out: '{"reply":"hi"}', data: { reply: "hi" }, in: { text: "yo" }, think: "short", bg: true });
    expect(row.steps![0].calls).toEqual([{ tool: "notes.read", kind: "read", ms: 3, d: "ran" }]);
    expect(rowOf({ id: "x", who: "Sam", text: "a", steps: [{ node: "fd", out: "words", ms: 1 }] }).steps).toEqual([{ node: "fd", out: "words", ms: 1, ok: true }]);
  });
});
