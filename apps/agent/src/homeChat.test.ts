import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { HOME_KEY } from "./homeChat";
import { accept, CHAT_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { textRoutine } from "./routines";
import { whapiChatId } from "./whapi";

const PHONE = "+15555550100";
const LINE = "+15555550199";
const WHATSAPP = whapiChatId(LINE, PHONE);
const IMESSAGE = "chat_imessage";

const msg = (eventId: string, chatId: string): Message => ({
  kind: "message",
  eventId,
  chatId,
  from: PHONE,
  messageId: `m_${eventId}`,
  text: "a question",
});

/** Records which provider each text went to: Linq for the iMessage chat, Whapi for WhatsApp. */
function recorder(sent: string[]): Fetch {
  return (async (url: string) => {
    sent.push(String(url).includes("whapi") ? "whatsapp" : "imessage");
    return new Response(JSON.stringify({ sent: true, message: { id: "wamid_1" } }), { status: 200 });
  }) as unknown as Fetch;
}

const deps = (sent: string[]) => ({
  fetch: recorder(sent),
  linqApiKey: "k",
  whapi: { token: "tok", line: LINE },
  now: () => 9_000,
  simulator: false,
});

describe("the chat Tex texts first", () => {
  it("stays on iMessage after the person texts Tex on WhatsApp", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", IMESSAGE), 1_000);
    await accept(storage, msg("e2", WHATSAPP), 2_000);
    // Replies still follow the chat a text came from.
    expect(storage.data.get(CHAT_KEY)).toMatchObject({ chatId: WHATSAPP });
    const sent: string[] = [];
    expect(await textRoutine(storage, { text: "check-in", idempotencyKey: "k" }, deps(sent))).toBe("texted");
    expect(sent).toEqual(["imessage"]);
  });

  it("is WhatsApp for someone who has only ever texted there", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", WHATSAPP), 1_000);
    expect(storage.data.get(HOME_KEY)).toBeUndefined();
    const sent: string[] = [];
    expect(await textRoutine(storage, { text: "check-in", idempotencyKey: "k" }, deps(sent))).toBe("texted");
    expect(sent).toEqual(["whatsapp"]);
  });

  it("moves to iMessage the moment they text there", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", WHATSAPP), 1_000);
    await accept(storage, msg("e2", IMESSAGE), 2_000);
    await accept(storage, msg("e3", WHATSAPP), 3_000);
    expect(storage.data.get(HOME_KEY)).toEqual({ chatId: IMESSAGE, at: 2_000 });
    const sent: string[] = [];
    await textRoutine(storage, { text: "check-in", idempotencyKey: "k" }, deps(sent));
    expect(sent).toEqual(["imessage"]);
  });
});
