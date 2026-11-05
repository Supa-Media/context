/**
 * THE DOOR'S FIRST STEP, isItForTex, FOR A 1:1 CHAT AND A GROUP
 * (`isItForTex.ts`, Dev2's one-door plan, 2026-11-05, "Chat's queue, same steps").
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. the group's `byCode` without `message.sms` → "an SMS tag is code's" fails.
 *  2. the group's yes without `isAsker` → "somebody else's yes is chat" fails.
 *  3. the 1:1's settings check without `!message.sms` → "an SMS never sets a setting" fails.
 */

import { describe, expect, it } from "vitest";
import { sha256Hex } from "./groupChat";
import { ASK_KEY, isItForTexAlone, isItForTexInGroup, type OpenAsk } from "./isItForTex";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import type { GroupMessage } from "./sendblueGroups";

const NOW = 1_000_000;
const ADA = "+15555550101";
const BO = "+15555550102";
const LINE = "+15555550100";

const text = (words: string, extra: Partial<Message> = {}): Message => ({ kind: "message", eventId: "e1", chatId: "chat_1", from: ADA, messageId: "m1", text: words, ...extra });
const group = (words: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({ kind: "group-message", eventId: "g1", groupId: "grp", line: LINE, from: ADA, participants: [ADA, BO, LINE], messageId: "h1", text: words, ...extra });

describe("isItForTex, a 1:1 chat", () => {
  it("every text is for Tex, and only code's texts are code's", async () => {
    const storage = new MemoryStorage();
    expect(await isItForTexAlone(storage, text("find us a dinner spot"), NOW)).toMatchObject({ forTex: true, byCode: false });
    const settings = await isItForTexAlone(storage, text("settings"), NOW);
    expect(settings).toMatchObject({ forTex: true, byCode: true });
    expect(settings.message.setting).toBe(true);
  });

  it("an SMS never sets a setting, and is code's all the same", async () => {
    const out = await isItForTexAlone(new MemoryStorage(), text("settings", { sms: true }), NOW);
    expect(out.message.setting).toBeUndefined();
    expect(out.byCode).toBe(true);
  });
});

describe("isItForTex, a group", () => {
  it("chatter is not for Tex; a tag is, and is the model's", async () => {
    const storage = new MemoryStorage();
    expect(await isItForTexInGroup(storage, group("anyone up for tacos?"), NOW, false)).toMatchObject({ forTex: false, byCode: false });
    expect(await isItForTexInGroup(storage, group("Tex, find us a dinner spot for Friday"), NOW, false)).toMatchObject({ forTex: true, byCode: false });
  });

  it("a command after Tex's name is code's", async () => {
    expect(await isItForTexInGroup(new MemoryStorage(), group("Tex stop"), NOW, false)).toMatchObject({ forTex: true, byCode: true });
  });

  it("an SMS tag is code's: anyone can fake its sender", async () => {
    expect(await isItForTexInGroup(new MemoryStorage(), group("Tex, find us a dinner spot", { sms: true }), NOW, false)).toMatchObject({ forTex: true, byCode: true });
  });

  it("the asker's bare yes is for Tex and code's; somebody else's yes is chat", async () => {
    const storage = new MemoryStorage();
    await storage.put<OpenAsk>(ASK_KEY, { from: await sha256Hex(ADA), at: NOW - 1_000 });
    expect(await isItForTexInGroup(storage, group("yes"), NOW, false)).toMatchObject({ forTex: true, byCode: true });
    expect(await isItForTexInGroup(storage, group("yes", { from: BO }), NOW, false)).toMatchObject({ forTex: false, byCode: false });
  });

  it("a voice message that says Tex's name is for Tex", async () => {
    expect(await isItForTexInGroup(new MemoryStorage(), group("", { heard: "hey Tex can you book us a table" }), NOW, false)).toMatchObject({ forTex: true });
  });
});
