/**
 * The person's chat with Tex in a whole-workspace Download as folders
 * (`features/console/files/ledgerDownload.ts`).
 *
 * Sabotage, each confirmed to fail a case here (2026-11-02):
 *  - stop after the first page: the second page's entries are missing;
 *  - treat a page that does not move as the end: the archive is short unsaid;
 *  - read only the person's own chat: the group chats' files are missing;
 *  - let one group's failure drop the others: the good group is missing.
 */

import { describe, expect, test } from "@jest/globals";
import { collectChatLedger, collectChatLedgers, groupLedgerPath, LEDGER_PATH, type LedgerPage } from "../features/console/files/ledgerDownload";

const manifest = JSON.stringify({ schema: "tex-ledger", version: 1, chat: "texts", count: 3 });
const entry = (seq: number) => JSON.stringify({ v: 1, id: `e${seq}`, kind: "text", at: 1_700_000_000_000 + seq, text: `text ${seq}`, seq });

describe("collectChatLedger", () => {
  test("every page is read, and the chat is one JSON file with its manifest first", async () => {
    const pages: Record<string, LedgerPage> = {
      start: { manifest, lines: [entry(1), entry(2)], next: 2 },
      "2": { manifest, lines: [entry(3)], next: null },
    };
    const asked: (number | undefined)[] = [];
    const outcome = await collectChatLedger(async (after) => {
      asked.push(after);
      return pages[after === undefined ? "start" : String(after)];
    });
    expect(asked).toEqual([undefined, 2]);
    expect(outcome.short).toBe(false);
    expect(outcome.entries.map((e) => e.path)).toEqual([LEDGER_PATH]);
    const file = JSON.parse(new TextDecoder().decode(outcome.entries[0].bytes));
    expect(file.manifest).toMatchObject({ schema: "tex-ledger", version: 1 });
    expect(file.entries.map((e: { text: string }) => e.text)).toEqual(["text 1", "text 2", "text 3"]);
  });

  test("a chat with no ledger writes nothing and is not short", async () => {
    expect(await collectChatLedger(async () => ({ manifest: null, lines: [], next: null }))).toEqual({ entries: [], short: false });
  });

  test("a failed read or a page that does not move is short, with none of it in the archive", async () => {
    expect(await collectChatLedger(async () => { throw new Error("down"); })).toEqual({ entries: [], short: true });
    expect(await collectChatLedger(async () => ({ manifest, lines: [entry(1)], next: 1 }))).toEqual({ entries: [], short: true });
  });
});

describe("collectChatLedgers", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const one = (chat: string): LedgerPage => ({ manifest: JSON.stringify({ schema: "tex-ledger", version: 1, chat, count: 1 }), lines: [entry(1)], next: null });

  test("the person's own chat and each group chat they are in, one file each", async () => {
    const asked: (string | undefined)[] = [];
    const outcome = await collectChatLedgers(
      async () => ({ chats: [A, B, "../escape"] }),
      async (chat) => (asked.push(chat), one(chat ?? "texts")),
    );
    expect(asked).toEqual([undefined, A, B]);
    expect(outcome).toMatchObject({ short: false });
    expect(outcome.entries.map((e) => e.path)).toEqual([LEDGER_PATH, groupLedgerPath(A), groupLedgerPath(B)]);
    expect(JSON.parse(new TextDecoder().decode(outcome.entries[1].bytes)).manifest.chat).toBe(A);
  });

  test("a group that cannot be read is short and left out; the rest are kept", async () => {
    const outcome = await collectChatLedgers(
      async () => ({ chats: [A, B] }),
      async (chat) => {
        if (chat === A) throw new Error("down");
        return one(chat ?? "texts");
      },
    );
    expect(outcome.short).toBe(true);
    expect(outcome.entries.map((e) => e.path)).toEqual([LEDGER_PATH, groupLedgerPath(B)]);
  });

  test("a list that fails keeps the person's own chat and says it is short", async () => {
    const outcome = await collectChatLedgers(async () => { throw new Error("down"); }, async () => one("texts"));
    expect(outcome).toMatchObject({ short: true });
    expect(outcome.entries.map((e) => e.path)).toEqual([LEDGER_PATH]);
  });
});
