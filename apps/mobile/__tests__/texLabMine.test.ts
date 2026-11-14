/**
 * The Lab's "You" (`features/tex/lab/engine/mine.ts`; Dev2, 2026-11-13: change the test user to their own and replay
 * old texts, read only): their texts joined to what Tex said then and which Tex that was, the notes a turn read, the
 * run config's replays, and a pasted "## Lab replay" read back.
 */
import { describe, expect, test } from "@jest/globals";
import { myTexts, parseReplay, readsOf, replayConfig, shortVersion } from "../features/tex/lab/engine/mine";
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
