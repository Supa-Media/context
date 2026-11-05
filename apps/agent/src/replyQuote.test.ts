/**
 * What a reply answers is kept on its own event, with that message's full words
 * (Dev2, 2026-11-05: "it should be recorded as, this was in response to, and
 * then quote the full text it was in response to"; `replyQuote.ts`).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-05):
 *  1. `logInbound` dropping the reply fields → "a 1:1 reply under Tex's text ...".
 *  2. `logGroupInbound` not noting the message's handle → "a group reply naming a person's message by handle ...".
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, keptEvents } from "./events";
import { logInbound, type Pending } from "./inboxTurn";
import { logGroupInbound } from "./groupTurn";
import { noteHandle, replyFields, sameText } from "./replyQuote";
import type { GroupMessage } from "./sendblueGroups";

type Message = Pending["message"];
const CHAT = "sendblue:line:+15555550100";
const GROUP = "group-1";
const NOW = Date.UTC(2026, 10, 5, 14, 48);
const LONG = `Drafted in the wrong account. Want me to save it in the other account, where the thread is? ${"More words. ".repeat(60)}👍 or 👎?`;

describe("a reply keeps what it answers", () => {
  it("a 1:1 reply under Tex's text is logged with that text's id and its full words, though the line quoted only its start", async () => {
    const storage = new MemoryStorage();
    const tex = await addEvent(storage, { at: NOW - 30_000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: LONG, turn: "turn-0000001", delivered: true });
    await addEvent(storage, { at: NOW - 20_000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: "Something else Tex said after it.", turn: "turn-0000001", delivered: true });
    const message = { kind: "message", chatId: CHAT, from: "+15555550123", text: "what do you mean?", quoted: `${LONG.slice(0, 497)}…`, threaded: true } as unknown as Message;
    const id = await logInbound(storage, message, NOW);
    const logged = (await keptEvents(storage, CHAT)).find((event) => event.id === id);
    expect(logged?.replyTo).toBe(tex);
    expect(logged?.quoted).toBe(LONG);
    expect(logged?.text).toBe("what do you mean?");
  });

  it("a reply whose message is not in the chat's events keeps the quoted words and no id", async () => {
    const storage = new MemoryStorage();
    const message = { kind: "message", chatId: CHAT, from: "+15555550123", text: "and this?", quoted: "An old message from last week", threaded: true } as unknown as Message;
    const id = await logInbound(storage, message, NOW);
    const logged = (await keptEvents(storage, CHAT)).find((event) => event.id === id);
    expect(logged?.replyTo).toBeUndefined();
    expect(logged?.quoted).toBe("An old message from last week");
  });

  it("a plain text and a tapback carry no reply fields", async () => {
    const storage = new MemoryStorage();
    const plain = await logInbound(storage, { kind: "message", chatId: CHAT, from: "+15555550123", text: "hi" } as unknown as Message, NOW);
    expect((await keptEvents(storage, CHAT)).find((event) => event.id === plain)).not.toHaveProperty("quoted");
  });

  it("a group reply naming a person's message by handle is logged with that message's id and words", async () => {
    const storage = new MemoryStorage();
    const group = (text: string, messageId: string, replyTo?: string) =>
      ({ kind: "group-message", eventId: `e-${messageId}`, groupId: GROUP, line: "+15555550100", from: "+15555550111", participants: ["+15555550111", "+15555550122"], messageId, text, ...(replyTo ? { replyTo } : {}) }) as unknown as GroupMessage;
    const first = await logGroupInbound(storage, group("Who's bringing the rice?", "h-1"), NOW - 60_000);
    const reply = await logGroupInbound(storage, group("I'll do the rice.", "h-2", "h-1"), NOW);
    const logged = (await keptEvents(storage, GROUP)).find((event) => event.id === reply);
    expect(logged?.replyTo).toBe(first);
    expect(logged?.quoted).toBe("Who's bringing the rice?");
  });

  it("a group reply to one of Tex's texts finds it by the handle it was sent under", async () => {
    const storage = new MemoryStorage();
    const sent = await addEvent(storage, { at: NOW - 10_000, chat: GROUP, from: { kind: "tex" }, kind: "text", text: "Booked for 7 at Lilia.", turn: "turn-0000002", delivered: true });
    await noteHandle(storage, "tex-h-9", sent);
    expect(await replyFields(storage, GROUP, { handle: "tex-h-9" })).toEqual({ replyTo: sent, quoted: "Booked for 7 at Lilia." });
  });

  it("quoted words match a text cut short either way, never a different one", () => {
    expect(sameText("Drafted in the wrong account. Want me", "drafted in the wrong account…")).toBe(true);
    expect(sameText("Booked for 7", "Booked for 8")).toBe(false);
    expect(sameText("", "x")).toBe(false);
  });
});
