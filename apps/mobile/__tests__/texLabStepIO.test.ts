/**
 * Every step shows what it got and gave (Dev2, 2026-11-14: "WHY CANT I SEE WHAT IS GOING IN AND OUT OF EVERY STEP ...
 * I SHOULD ALSO SEE WHAT CONTEXT MODULES ITS GETTING"), put back from references in the chat's own ledger.
 */
import { describe, expect, test } from "@jest/globals";
import { momentAsSteps, stepIO, textById } from "../features/tex/lab/engine/stepIO";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const e = (x: Partial<LedgerEntry> & { id: string; kind: string }) => ({ at: 1_000, ...x }) as LedgerEntry;
const T = "t1";
const entries: LedgerEntry[] = [
  e({ id: "ev1000001", eid: "1000-000001", kind: "text", from: { kind: "person", name: "seyi" }, text: "wait for Instinct first" }),
  e({ id: "judge1", at: 2_000, kind: "judge", by: "moment", model: "@cf/cloudflare/clef", verdict: "respond", went: true, event: "1000-000001", why: "replies_to_tex", confidence: 0.26, ms: 1_100 }),
  e({ id: "b1", at: 2_500, kind: "brief", turn: T, asker: "seyi", ask: "wait for Instinct first", tools: [], waiting: [] }),
  e({ id: "th", at: 5_000, kind: "thinking", turn: T, ms: 2_000, text: "They want me to wait." }),
  e({ id: "tl", at: 6_000, kind: "tool", turn: T, name: "read_note", ms: 300, args: { path: "about.md" }, result: "# About" }),
  e({ id: "rv", at: 7_000, kind: "judge", turn: T, by: "review", round: 1, went: true, ms: 1_500, draft: "Will do." }),
  e({
    id: "r1",
    at: 8_000,
    kind: "reply",
    turn: T,
    text: "Will do.",
    timing: {
      v: 2,
      waitMs: 3_900,
      replyMs: 6_000,
      steps: [
        { name: "history_group_ledger", at: 100, ms: 450 },
        { name: "wait:history", at: 100, ms: 500 },
        { name: "model", at: 1_000, ms: 4_000 },
      ],
      rounds: [
        { at: 1_000, ms: 4_000, model: "anthropic/claude-haiku-5-5", input: 4, output: 557, cacheRead: 68_639, cacheWrite: 12_228, prompt: { modules: [{ id: "stable/texting", n: 92_285, h: "aa353cc6" }, { id: "context/thread", n: 16_558, h: "26cf912a" }], inputs: { timeZone: "America/New_York" } } },
        { at: 5_000, ms: 900, output: 20, prompt: { modules: [{ id: "stable/texting", n: 92_285, h: "aa353cc6" }, { id: "context/thread", n: 16_558, h: "26cf912a" }] } },
      ],
    },
  }),
];

describe("stepIO", () => {
  const all = [...entries, ...momentAsSteps(entries[1], T)];
  const io = stepIO(all, T, "wait for Instinct first", "Will do.", "seyi's text");

  test("a group's judging is Decide: the text it judged, in words, and its verdict", () => {
    expect(textById(entries, "1000-000001")).toBe("seyi: wait for Instinct first");
    expect(io.decide.find((l) => l.k === "Judged")?.v).toBe("seyi: wait for Instinct first");
    expect(io.decide.find((l) => l.k.startsWith("Said"))?.v).toMatch(/^answer · replies to tex · 26% sure/);
  });

  test("Door steps shows what it gathered, the brief it handed on and the context modules it built", () => {
    expect(io.door.map((l) => l.k)).toEqual(["Got", "Gathered", "Gave the front door (its brief)", "Context modules it built, in prompt order"]);
    expect(io.door[1].v).toBe("history group ledger · 450 ms");
    expect(io.door[3].v).toBe("stable/texting · 92,285 chars · aa353cc6\ncontext/thread · 16,558 chars · 26cf912a");
  });

  test("the front door shows each round's tokens and modules, a repeat named as such, then its thoughts and answer", () => {
    const keys = io.fd.map((l) => l.k);
    expect(keys.slice(0, 3)).toEqual(["Got", "Round 1 · 4.0 s · claude-haiku-5-5", "Round 2 · 900 ms"]);
    expect(io.fd[1].v).toMatch(/68,639 cached/);
    expect(io.fd[1].v).toMatch(/Context modules, in prompt order:\nstable\/texting/);
    expect(io.fd[2].v).toMatch(/Same context modules as the round before/);
    expect(keys).toContain("Thought · 2.0 s");
    expect(keys.at(-1)).toBe("Answer");
  });

  test("Queue, tools, reviewer and send each say what happened", () => {
    expect(io.lanes[0].v).toMatch(/3\.9 s for the turn before it/);
    expect(io.tools.map((l) => l.k)).toEqual(["read_note · got", "read_note · gave · 300 ms"]);
    expect(io.reviewer[0].k).toBe("Round 1: let it go · 1.5 s");
    expect(io.send[0].v).toBe("Will do.");
    expect(io.text[0]).toEqual({ k: "seyi's text", v: "wait for Instinct first" });
  });

  test("a tapback the judge chose is React's", () => {
    const steps = momentAsSteps(e({ id: "j2", kind: "judge", by: "moment", verdict: "react", emoji: "👍", event: "1000-000001" }), T);
    const r = stepIO([...entries, ...steps], T, "", "");
    expect(r.react).toEqual([
      { k: "On", v: "seyi: wait for Instinct first" },
      { k: "Sent", v: "👍" },
    ]);
  });
});
