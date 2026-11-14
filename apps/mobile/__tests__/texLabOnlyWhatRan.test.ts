/**
 * Replay draws only what ran (Dev2, 2026-11-14: "If the step never ran, then why is it logged as running? ... Are you
 * telling me that the replay is false?"). A step the turn's log does not show gets no bar and no lit node; the Lab's
 * estimate never stands in for it. Made-up texts throughout.
 */
import { describe, expect, test } from "@jest/globals";
import { momentsOf } from "../features/tex/lab/engine/replay";
import { stepRows } from "../features/tex/lab/engine/replaySteps";
import { onlyWhatRan, realTimes, withReal } from "../features/tex/lab/engine/realTimes";
import { simulate } from "../features/tex/lab/engine/sim";
import { G } from "../features/tex/lab/engine/state";
import { chatLines, myTexts } from "../features/tex/lab/engine/mine";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const e = (x: Partial<LedgerEntry> & { id: string; kind: string }): LedgerEntry => ({ at: 1_000, ...x }) as LedgerEntry;
const T = "turn-0001";
const base: LedgerEntry[] = [
  e({ id: "ev1000000000001000001", eid: "1000000000001-000001", seq: 1, at: 1_000_000_000_001, kind: "text", from: { kind: "person" }, text: "whats on the cal tomorrow" }),
  e({ id: "d1", seq: 2, at: 1_000_000_002_000, kind: "step", turn: T, step: "door", ok: true, input: { covers: ["1000000000001-000001"] }, output: { model: "haiku" } }),
  e({ id: "tl", seq: 3, at: 1_000_000_004_000, kind: "tool", turn: T, name: "read_calendar", ms: 700, args: {}, result: "3 events" }),
  e({ id: "rv", seq: 4, at: 1_000_000_007_000, kind: "judge", turn: T, by: "review", round: 1, went: true, ms: 2_000, draft: "Three things." }),
  e({
    id: "r1",
    seq: 5,
    at: 1_000_000_008_000,
    kind: "reply",
    turn: T,
    text: "Three things.",
    covers: ["1000000000001-000001"],
    timing: { v: 2, waitMs: 1_300, replyMs: 6_500, rounds: [{ at: 1_000, ms: 3_300, model: "anthropic/claude-haiku-5-5" }], tools: [{ at: 2_000, ms: 700 }] },
  }),
  e({ id: "ev2", seq: 6, at: 1_000_000_008_100, kind: "text", from: { kind: "tex" }, text: "Three things.", turn: T, covers: ["1000000000001-000001"] }),
];
// What the Worker now keeps when code sends one text straight to Tex (`apps/agent/src/stepEvents.ts` `codeDecideStep`).
const codeDecide = e({
  id: "ev1000000000001500002",
  seq: 7,
  at: 1_000_000_000_500,
  kind: "step",
  step: { name: "decide", of: "waiting", ok: true, ms: 0, input: { candidates: ["1000000000001-000001"] }, output: { act: "answer", by: "code", why: "one text and nothing of Tex's waiting on it: it goes straight to Tex" } },
} as unknown as Partial<LedgerEntry> & { id: string; kind: string });

const rowsOf = (entries: LedgerEntry[]) => {
  const m = momentsOf(chatLines(entries, myTexts(entries)), entries)[0];
  return stepRows(m, entries, G()).map((r) => r.id);
};

describe("Replay draws only what ran", () => {
  test("a step the log does not show gets no row, however the Lab would estimate it", () => {
    const ids = rowsOf(base);
    for (const ran of ["door", "fd", "tools", "reviewer", "send"]) expect(ids).toContain(ran);
    for (const never of ["decide", "react", "checks", "router", "classifier", "planner"]) expect(ids).not.toContain(never);
  });

  test("Decide gets its row when the Worker logged it, even decided by code in no time", () => {
    expect(rowsOf([...base, codeDecide])).toContain("decide");
  });

  test("the canvas's run keeps only measured steps and what started it", () => {
    const real = realTimes(base, T)!;
    const sim = withReal(simulate(G(), "own", null, real), real, G());
    expect(Object.keys(sim.T)).toContain("decide"); // the Lab's estimate, as Lab mode draws it
    const ran = onlyWhatRan(sim, G());
    expect(Object.keys(ran.T)).not.toContain("decide");
    expect(Object.keys(ran.T)).not.toContain("react");
    expect(Object.keys(ran.T)).toContain("fd");
    expect(Object.keys(ran.T)).toContain("text");
  });
});
