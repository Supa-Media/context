/**
 * Yes or Not now on Tex's ask from the web page a card's tap opened (`pageAnswer.ts`): queued in the chat the person
 * last texted from as their own "yes" or "no" on that ask, exactly as the card's own answer; only the ask still waiting.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `answerFromPage` not comparing the key → "a key that is not the waiting ask's is refused" fails.
 *   `eventId` with a time in it → "a second tap is the same answer" fails.
 */

import { describe, expect, it } from "vitest";

import { askKey } from "./cardChats";
import { accept } from "./inbox";
import type { Pending } from "./inboxTurn";
import { MemoryStorage } from "./memoryStorage.testing";
import { answerFromPage, readPageAnswer } from "./pageAnswer";
import type { Message } from "./reply";
import { rememberAskReply } from "./thumbs";

const PHONE = "+15555550100";
const CHAT = "photon:any;-;+15555550100";
const ASK = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\nGive it a 👍 and I'll send it.";

async function chatWithAsk(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  const hi: Message = { kind: "message", eventId: "e1", chatId: CHAT, from: PHONE, messageId: "m1", text: "write Jo back" };
  await accept(storage, hi, 1_000);
  for (const key of (await storage.list({ prefix: "pending:" })).keys()) await storage.delete(key);
  await rememberAskReply(storage, [ASK], 2_000);
  return storage;
}

async function queued(storage: MemoryStorage): Promise<Message[]> {
  return [...(await storage.list<Pending>({ prefix: "pending:" })).values()].map((item) => item.message);
}

describe("answerFromPage", () => {
  it("queues the person's yes on the waiting ask in the chat they texted from", async () => {
    const storage = await chatWithAsk();
    expect(await answerFromPage(storage, { phone: PHONE, ask: askKey(ASK), yes: true }, 3_000)).toEqual({ taken: true });
    const [message] = await queued(storage);
    expect(message).toMatchObject({ chatId: CHAT, from: PHONE, text: "yes", viaCard: { ask: askKey(ASK) } });
  });

  it("Not now is a no", async () => {
    const storage = await chatWithAsk();
    await answerFromPage(storage, { phone: PHONE, ask: askKey(ASK), yes: false }, 3_000);
    expect((await queued(storage))[0]?.text).toBe("no");
  });

  it("a second tap is the same answer, already in", async () => {
    const storage = await chatWithAsk();
    await answerFromPage(storage, { phone: PHONE, ask: askKey(ASK), yes: true }, 3_000);
    expect(await answerFromPage(storage, { phone: PHONE, ask: askKey(ASK), yes: false }, 4_000)).toEqual({ taken: true });
    expect((await queued(storage)).map((m) => m.text)).toEqual(["yes"]);
  });

  it("a key that is not the waiting ask's is refused, and so is a tap with no ask waiting", async () => {
    const storage = await chatWithAsk();
    expect(await answerFromPage(storage, { phone: PHONE, ask: "zzz", yes: true }, 3_000)).toEqual({ taken: false, why: "stale" });
    expect(await answerFromPage(new MemoryStorage(), { phone: PHONE, ask: askKey(ASK), yes: true }, 3_000)).toEqual({ taken: false, why: "no_ask" });
    expect(await queued(storage)).toEqual([]);
  });

  it("reads only a phone, a short key and a boolean", () => {
    expect(readPageAnswer({ phone: PHONE, ask: "abc1", yes: true })).toEqual({ phone: PHONE, ask: "abc1", yes: true });
    for (const bad of [null, [], { phone: "555", ask: "abc1", yes: true }, { phone: PHONE, ask: "../x", yes: true }, { phone: PHONE, ask: "abc1", yes: "yes" }]) {
      expect(readPageAnswer(bad)).toBeNull();
    }
  });
});
