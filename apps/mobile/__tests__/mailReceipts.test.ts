// Read receipts on Agent Mail (`features/console/mailPage/receipts.ts`; Dev, 2026-11-26, boards approved that day).
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. The reader's own reads no longer skipped → "your own reads are never shown" fails.
//  2. A reader's own message no longer skipped → "a reader's receipt sits under the newest message it read" fails.
import { describe, expect, it } from "@jest/globals";
import { readByWords, receiptsFor, readerOf, type MailRead } from "../features/console/mailPage/receipts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 18, minute)).toISOString();
const MESSAGES = [
  { from: "@seyi", app: null, at: at(0) },
  { from: "@seyi", app: null, at: at(1) },
  { from: "grok-bot", app: "Cursor · @seyi", at: at(3) },
  { from: "@seyi", app: null, at: at(10) },
];
const grok = (minute: number): MailRead => ({ name: "@seyi", by: "ai", clientName: "Cursor", at: at(minute) });

describe("read receipts", () => {
  it("a reader's receipt sits under the newest message it read, never its own", () => {
    const receipts = receiptsFor(MESSAGES, [grok(4)], "@seyi");
    const under = receipts.get(1);
    expect(under).not.toBe("unread");
    expect(under !== undefined && under !== "unread" && under.readers.map((reader) => reader.label)).toEqual(["Grok Bot"]);
    expect(receipts.get(2)).toBeUndefined();
  });

  it("moves down as the reader reads on, and the last word is then read", () => {
    const receipts = receiptsFor(MESSAGES, [grok(12)], "@seyi");
    expect(receipts.get(1)).toBeUndefined();
    const last = receipts.get(3);
    expect(last !== undefined && last !== "unread" && last.readers[0]?.label).toBe("Grok Bot");
  });

  it("your own newest word nobody has read yet says so", () => {
    expect(receiptsFor(MESSAGES, [grok(4)], "@seyi").get(3)).toBe("unread");
    expect(receiptsFor(MESSAGES.slice(0, 3), [], "@seyi").get(2)).toBeUndefined();
  });

  it("your own reads are never shown", () => {
    const receipts = receiptsFor(MESSAGES, [{ name: "@seyi", by: "person", clientName: null, at: at(20) }], "@seyi");
    expect([...receipts.values()]).toEqual(["unread"]);
  });

  it("several readers share one receipt, newest first, with the newest time", () => {
    const shyoh: MailRead = { name: "@shyoh", by: "person", clientName: null, at: at(15) };
    const last = receiptsFor(MESSAGES, [grok(12), shyoh], "@seyi").get(3);
    expect(last !== undefined && last !== "unread" && last.readers.map((reader) => reader.label)).toEqual(["@shyoh", "Grok Bot"]);
    expect(last !== undefined && last !== "unread" && last.at).toBe(Date.parse(at(15)));
  });

  it("an AI client that never wrote here is named by its app and whose it is, drawn as that app", () => {
    const reader = readerOf({ name: "@shyoh", by: "ai", clientName: "Claude Code", at: at(5) }, MESSAGES);
    expect(reader.label).toBe("@shyoh's Claude Code");
    expect(reader.face.app).toBe("Claude Code · @shyoh");
  });

  it("names many readers briefly", () => {
    const r = (label: string) => ({ label, face: { name: label, app: null }, at: 0 });
    expect(readByWords([r("A")])).toBe("Read by A");
    expect(readByWords([r("A"), r("B")])).toBe("Read by A and B");
    expect(readByWords([r("A"), r("B"), r("C")])).toBe("Read by A, B and C");
    expect(readByWords([r("A"), r("B"), r("C"), r("D")])).toBe("Read by A, B and 2 others");
  });
});
