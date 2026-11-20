/**
 * A check-in is shown once in the Lab's chat (`packages/lab/app/engine/mine.ts` `chatLines`) and in the chat's history
 * (`features/tex/history/historyLines.ts` `historyDays`). The gateway records the check-in twice: the note the turn wrote
 * (Background) and the Worker's text event carrying the note's `turn` and `source` (Texts). The Lab draws the note, with
 * its reason, and drops the text; history draws each under its own view, and neither a text that was not delivered nor
 * the note of one is drawn (`apps/mcp/src/agent/sentOnItsOwn.js`).
 */
import { describe, expect, test } from "@jest/globals";
import { chatLines, myTexts } from "@context/lab/app/engine/mine";
import { historyDays, type HistoryLine } from "../features/tex/history/historyLines";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const CHECK = "The Maple Street ticket was claimed by Dana at 7:58, so I left it alone.";
const TURN = "ck0123456789abcdef0123";
const T = Date.UTC(2026, 10, 18, 7, 50, 0);
const MIN = 60_000;
const eid = (at: number, n: number) => `${at}-${String(n).padStart(6, "0")}`;

function ledger({ delivered = true, withText = true }: { delivered?: boolean; withText?: boolean } = {}): LedgerEntry[] {
  const at = T + 11 * MIN;
  const entries: LedgerEntry[] = [
    { id: "ev1", eid: eid(T, 1), seq: 1, at: T, kind: "text", from: { kind: "person" }, text: "Did anyone take the Maple Street ticket?" },
    {
      id: "note1",
      seq: 2,
      at,
      kind: "note",
      turn: TURN,
      text: CHECK,
      about: "(Not a text from them. This was your own check-in: you looked through their workspace on your own and texted them what follows.) Your thinking just before you texted it: \"the board changed\"",
    },
  ];
  if (withText) entries.push({ id: `ev${eid(at + 3_000, 2).replace(/[^0-9A-Za-z]/g, "")}`, eid: eid(at + 3_000, 2), seq: 3, at: at + 3_000, kind: "text", from: { kind: "tex" }, text: CHECK, turn: TURN, source: "checkin", delivered });
  entries.push({ id: "ev3", eid: eid(T + 160 * MIN, 3), seq: 4, at: T + 160 * MIN, kind: "text", from: { kind: "person" }, text: "Can't you just check for yourself who claimed it?" });
  return entries;
}

const linesOf = (entries: LedgerEntry[]) => historyDays(entries, new Date(T + 170 * MIN)).flatMap((day) => day.turns.flatMap((turn) => turn.lines));

describe("the Lab's chat (mine.ts)", () => {
  test("the check-in is one line: the note, with its start, and the Worker's text is not drawn again", () => {
    const entries = ledger();
    const lines = chatLines(entries, myTexts(entries));
    const checkins = lines.filter((line) => line.text === CHECK);
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({ start: "checkin", turn: TURN, from: "tex" });
  });

  test("a check-in whose send was not delivered is drawn nowhere", () => {
    const entries = ledger({ delivered: false });
    expect(chatLines(entries, myTexts(entries)).filter((line) => line.text === CHECK)).toHaveLength(0);
  });

  test("an older ledger with only the note still draws it once", () => {
    const entries = ledger({ withText: false });
    expect(chatLines(entries, myTexts(entries)).filter((line) => line.text === CHECK)).toHaveLength(1);
  });

  test("a check-in that looked and texted nothing still gets its own line, and one that texted does not", () => {
    const entries = ledger();
    const looked = { id: "step1", seq: 9, at: T + 9 * MIN, kind: "step", turn: "ck99999999999999999999", step: "look" } as LedgerEntry;
    const lines = chatLines([...entries, looked], myTexts([...entries, looked]));
    expect(lines.filter((line) => line.quiet === true).map((line) => line.turn)).toEqual(["ck99999999999999999999"]);
  });
});

describe("the chat's history (historyLines.ts)", () => {
  test("the Texts view and Background each draw the check-in once; the Worker text is the Texts line", () => {
    const lines = linesOf(ledger());
    const texts = lines.filter((line: HistoryLine) => line.text === CHECK && line.tone === "tex");
    expect(texts).toHaveLength(1);
    const notes = lines.filter((line: HistoryLine) => line.text.includes(CHECK) && line.text.startsWith("check-in"));
    expect(notes).toHaveLength(1);
  });

  test("an undelivered check-in is drawn nowhere in history", () => {
    const lines = linesOf(ledger({ delivered: false }));
    expect(lines.filter((line: HistoryLine) => line.text.includes(CHECK))).toHaveLength(0);
  });
});
