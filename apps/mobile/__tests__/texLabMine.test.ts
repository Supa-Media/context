/**
 * The Lab's "You" (`features/tex/lab/engine/mine.ts`; Dev2, 2026-11-13: change the test user to their own and replay
 * old texts, read only): their texts joined to what Tex said then and which Tex that was, the notes a turn read, the
 * run config's replays, and a pasted "## Lab replay" read back.
 */
import { describe, expect, test } from "@jest/globals";
import { chatLines, myTexts, parseReplay, readsOf, replayConfig, shortVersion } from "../features/tex/lab/engine/mine";
import { judgeWords, momentsOf, turnAt } from "../features/tex/lab/engine/replay";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const e = (x: Partial<LedgerEntry> & { id: string; kind: string }): LedgerEntry => ({ at: 1_000, ...x }) as LedgerEntry;

const ledger: LedgerEntry[] = [
  e({ id: "ev1", eid: "0001-000001", seq: 1, at: 1_000, kind: "text", from: { kind: "person" }, text: "hey" }),
  e({ id: "ev2", seq: 2, at: 2_000, kind: "text", from: { kind: "tex" }, text: "Hi.", turn: "t1", covers: ["0001-000001"] }),
  e({ id: "r1", seq: 3, at: 2_000, kind: "reply", turn: "t1", text: "Hi.", version: { code: "abc1234def56", setup: "a1b2c3d4e5f6", deploy: "<x>" } }),
  e({ id: "ev3", eid: "0003-000002", seq: 4, at: 3_000, kind: "text", from: { kind: "person" }, text: "remind me about the shelves" }),
  e({ id: "ev4", seq: 5, at: 4_000, kind: "text", from: { kind: "tex" }, text: "Done.", turn: "t2", covers: ["0003-000002"] }),
  e({ id: "r2", seq: 6, at: 4_000, kind: "reply", turn: "t2", text: "Done." }),
  e({ id: "j1", seq: 7, at: 5_000, kind: "text", from: { kind: "person" }, text: "a job's own text", job: "job1" }),
];

describe("the Lab's You", () => {
  test("each of their texts, newest first, with what Tex said then and which Tex that was", () => {
    const list = myTexts(ledger);
    expect(list.map((t) => t.id)).toEqual(["ev3", "ev1"]);
    expect(list[1].then).toEqual({ text: "Hi.", version: { code: "abc1234def56", setup: "a1b2c3d4e5f6" } });
    expect(list[0].then.version).toBeNull();
    expect(list[0].earlier).toEqual([{ from: "person", text: "hey" }, { from: "tex", text: "Hi." }]);
    expect(list[0].turn).toBe("t2");
    expect(shortVersion(list[1].then.version)).toBe("abc1234 · setup a1b2c3");
    expect(shortVersion(null)).toBe("no version");
  });

  test("a turn's reads are the notes it fetched by name in its own workspace, never another's or a path out", () => {
    const tools = [
      e({ id: "a", kind: "tool", turn: "t2", name: "fetch", args: { id: "projects/shelves.md" } }),
      e({ id: "b", kind: "tool", turn: "t2", name: "fetch", args: { id: "notes.md", context: "@other" } }),
      e({ id: "c", kind: "tool", turn: "t2", name: "fetch", args: { id: "../x.md" } }),
      e({ id: "d", kind: "tool", turn: "t1", name: "fetch", args: { id: "elsewhere.md" } }),
      e({ id: "f", kind: "tool", turn: "t2", name: "search", args: { query: "shelves" } }),
      e({ id: "g", kind: "tool", turn: "t2", name: "fetch", args: { id: ".context/secret.md" } }),
    ];
    expect(readsOf(tools, "t2")).toEqual(["projects/shelves.md"]);
    expect(readsOf(tools, null)).toEqual([]);
  });

  test("the run config carries the picked texts only when there is someone to run them as", () => {
    const [t] = myTexts(ledger);
    expect(replayConfig([t], { ev3: ["projects/shelves.md"] }, null)).toEqual({});
    const c = replayConfig([t], { ev3: ["projects/shelves.md"] }, { handle: "sam", name: "Sam" }) as { replays: Array<{ reads: string[] }>; replayAs: unknown };
    expect(c.replayAs).toEqual({ handle: "sam", name: "Sam" });
    expect(c.replays[0].reads).toEqual(["projects/shelves.md"]);
  });

  test("a pasted replay block reads back each text's Now, a failed one too", () => {
    const pasted = ['## Lab replay: My version', '', '### ev3', '', '**Text:** "remind me"', '', '**Then** (no version): "Done."', '', '**Now:** "Saturday, \\"9am\\"."', '', '### ev1', '', '**Now:** failed (socket closed)', ''].join("\n");
    expect(parseReplay(pasted)).toEqual([{ id: "ev3", now: 'Saturday, "9am".' }, { id: "ev1", now: "", failed: "socket closed" }]);
    expect(parseReplay("## Tex replay: ✅")).toEqual([]);
  });
});

describe("Replay's moments (Dev2, 2026-11-14: \"replay sequences of text, like see how queuing works\")", () => {
  const T = Date.UTC(2026, 10, 14, 1);
  const e = (x: Partial<LedgerEntry> & { id: string; at: number; kind: string }) => x as LedgerEntry;
  // Two texts close together, the second while the first's turn ran and queued; then a later one on its own.
  const entries: LedgerEntry[] = [
    e({ id: "a", at: T, seq: 1, kind: "text", eid: "ea", from: { kind: "person", name: "Ada" }, text: "book a table" }),
    e({ id: "d1", at: T + 300, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 280, output: { act: "answer" } } }),
    e({ id: "b", at: T + 2_000, seq: 2, kind: "text", eid: "eb", from: { kind: "person", name: "Ada" }, text: "also the weather" }),
    e({ id: "d2", at: T + 2_400, kind: "step", step: { name: "decide", of: "running", ok: true, ms: 400, output: { act: "answer", midTurn: "queue" } } }),
    e({ id: "r1", at: T + 6_000, kind: "reply", turn: "t1", text: "Booked.", timing: { waitMs: 500, replyMs: 5_000 } }),
    e({ id: "x", at: T + 6_100, seq: 3, kind: "text", turn: "t1", covers: ["ea"], from: { kind: "tex" }, text: "Booked." }),
    e({ id: "r2", at: T + 9_000, kind: "reply", turn: "t2", text: "Sunny.", timing: { waitMs: 3_900, replyMs: 2_900 } }),
    e({ id: "y", at: T + 9_100, seq: 4, kind: "text", turn: "t2", covers: ["eb"], from: { kind: "tex" }, text: "Sunny." }),
    e({ id: "c", at: T + 600_000, seq: 5, kind: "text", eid: "ec", from: { kind: "person", name: "Ada" }, text: "thanks" }),
  ];
  const lines = chatLines(entries, myTexts(entries), { group: true });

  test("a moment is the texts in a row and what Tex said back, with its judgings and turns on one clock", () => {
    const ms = momentsOf(lines, entries);
    expect(ms.map((m) => m.lines.map((l) => l.text))).toEqual([["book a table", "also the weather", "Booked.", "Sunny."], ["thanks"]]);
    const [m] = ms;
    expect(m.lanes.Texts.map((b) => b.start)).toEqual([0, 2_000]);
    expect(m.lanes.Judge.map((b) => [b.start, b.end, b.label, b.detail])).toEqual([
      [20, 300, "answer", "waiting texts"],
      [2_000, 2_400, "queue it", "while a turn ran"],
    ]);
    // Each turn: its wait in the queue, then the turn; the second waited for the first.
    expect(m.lanes.Turn.map((b) => [b.kind, b.start, b.end, b.turn])).toEqual([
      ["wait", 500, 1_000, "t1"],
      ["turn", 1_000, 6_000, "t1"],
      ["wait", 2_200, 6_100, "t2"],
      ["turn", 6_100, 9_000, "t2"],
    ]);
    expect(m.turns).toEqual(["t1", "t2"]);
    expect(m.of).toBe(9_500);
    expect(m.lines[0].who).toBe("Ada");
    // The head picks the turn whose timeline it is in, from that turn's own start.
    expect(turnAt(m, 100)).toBeNull();
    expect(turnAt(m, 1_500)).toEqual({ turn: "t1", start: 500 });
    expect(turnAt(m, 7_000)).toEqual({ turn: "t2", start: 2_200 });
  });

  test("the judge's calls in a few words", () => {
    expect(judgeWords({ act: "answer" }, false)).toBe("answer");
    expect(judgeWords({ act: "answer", midTurn: "fold" }, true)).toBe("fold it in");
    expect(judgeWords({ act: "answer", midTurn: "restart" }, true)).toBe("restart");
    expect(judgeWords({ act: "answer" }, true)).toBe("queue it");
    expect(judgeWords({ act: "react" }, false)).toBe("tapback");
    expect(judgeWords(null, false)).toBe("no answer");
  });
});
