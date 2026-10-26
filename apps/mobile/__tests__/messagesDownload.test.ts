/**
 * The Messages backup in a whole-workspace Download as folders
 * (`features/console/files/messagesDownload.ts`).
 *
 * Sabotage, each confirmed to fail a case here (2026-10-26):
 *  - stop after the first page: the second page's texts are missing;
 *  - treat a page that does not move as the end: the archive is short unsaid;
 *  - drop the name check in `messagesFolderFor`: a person's own Messages folder is written into.
 */

import { describe, expect, test } from "@jest/globals";
import { collectMessages, messagesFolderFor, MOST_PAGES, type LogPage } from "../features/console/files/messagesDownload";

const line = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: "message", id, chat: "chat-ada", at: "2026-10-21T09:00:00.000Z", me: false, from: "+15550100", text, service: "iMessage", ...extra });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("collectMessages", () => {
  test("every page is read, folded, and written as one text file per conversation per month", async () => {
    const pages: Record<string, LogPage> = {
      start: { objects: [{ key: "a", text: `${line("m-1", "Dinner at 4")}\nnot json\n` }], next: "a" },
      a: {
        objects: [{ key: "b", text: `${line("m-1", "Dinner at 5")}\n${line("m-2", "", { files: [{ id: "0123456789abcdef0123456789abcdef", name: "IMG_1.HEIC" }] })}\n` }],
        next: null,
      },
    };
    const asked: (string | undefined)[] = [];
    const outcome = await collectMessages(async (after) => {
      asked.push(after);
      return pages[after ?? "start"];
    });
    expect(asked).toEqual([undefined, "a"]);
    expect(outcome.short).toBe(false);
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["Messages/chat-ada/2026-10.md"]);
    const text = decode(outcome.entries[0].bytes);
    expect(text).toContain("Dinner at 5");
    expect(text).not.toContain("Dinner at 4");
    expect(text).toContain("(IMG_1.HEIC)");
    expect(text).not.toContain("](files/");
  });

  test("a log that could not be read to the end puts nothing in and says so", async () => {
    expect(await collectMessages(async () => { throw new Error("offline"); })).toEqual({ entries: [], short: true });
    expect(await collectMessages(async () => ({ objects: [], next: "stuck" }))).toEqual({ entries: [], short: true });
    let pages = 0;
    const endless = await collectMessages(async () => ({ objects: [], next: `k${(pages += 1)}` }));
    expect(endless).toEqual({ entries: [], short: true });
    expect(pages).toBe(MOST_PAGES);
  });

  test("anyone but the owner is answered an empty log, and the archive gains nothing", async () => {
    expect(await collectMessages(async () => ({ objects: [], next: null }))).toEqual({ entries: [], short: false });
  });
});

describe("messagesFolderFor", () => {
  test("never writes into a folder of the person's own", () => {
    expect(messagesFolderFor(["Projects/a.md"])).toBe("Messages");
    expect(messagesFolderFor(["messages/plan.md"])).toBe("Messages (backup)");
    expect(messagesFolderFor(["Messages"])).toBe("Messages (backup)");
    expect(messagesFolderFor(["Messages old/x.md"])).toBe("Messages");
  });
});
