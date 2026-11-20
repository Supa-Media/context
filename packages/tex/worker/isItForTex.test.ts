/**
 * THE DOOR'S FIRST STEP, isItForTex, FOR A 1:1 CHAT AND A GROUP
 * (`isItForTex.ts`, Dev2's one-door plan, 2026-11-05, "Chat's queue, same steps").
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  3. the 1:1's sharing check without `!message.sms` → "an SMS never sets a setting" fails.
 *  4. (2026-11-11) `commandTo` without its name check → "a command said to Tex by name is code's" fails.
 */

import { describe, expect, it } from "vitest";
import { sha256Hex } from "./groupChat";
import { ASK_KEY, isItForTexAlone, isItForTexInGroup, type OpenAsk } from "./isItForTex";
import { MemoryStorage } from "./memoryStorage.testing";
import { SENT_KEY } from "./groupSay";
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
    // "settings" is the model's since the menu was retired (2026-11-11); sharing chats with the devs is still code's.
    expect(await isItForTexAlone(storage, text("settings"), NOW)).toMatchObject({ forTex: true, byCode: false });
    const sharing = await isItForTexAlone(storage, text("share my chats with the devs"), NOW);
    expect(sharing).toMatchObject({ forTex: true, byCode: true });
    expect(sharing.message.setting).toBe(true);
  });

  it("an SMS never sets a setting, and is code's all the same", async () => {
    const out = await isItForTexAlone(new MemoryStorage(), text("share my chats with the devs", { sms: true }), NOW);
    expect(out.message.setting).toBeUndefined();
    expect(out.byCode).toBe(true);
  });
});

describe("isItForTex, a group (Dev2, 2026-11-11: whether a message is for Tex is the one judge's, never a word rule)", () => {
  it("chatter, a tag, a bare yes and a voice message naming Tex are all the judge's, not code's", async () => {
    const storage = new MemoryStorage();
    await storage.put<OpenAsk>(ASK_KEY, { from: await sha256Hex(ADA), at: NOW - 1_000 });
    for (const message of [group("anyone up for tacos?"), group("Tex, find us a dinner spot for Friday"), group("@Tex what's 2+2"), group("yes"), group("", { heard: "hey Tex can you book us a table" })]) {
      expect(await isItForTexInGroup(storage, message, NOW), message.text || "voice").toMatchObject({ forTex: false, byCode: false });
    }
  });

  it("a command said to Tex by name is code's; the same words without the name are not", async () => {
    expect(await isItForTexInGroup(new MemoryStorage(), group("Tex stop"), NOW)).toMatchObject({ forTex: true, byCode: true });
    expect(await isItForTexInGroup(new MemoryStorage(), group("@Tex, start"), NOW)).toMatchObject({ forTex: true, byCode: true });
    expect(await isItForTexInGroup(new MemoryStorage(), group("@Tex, settings"), NOW)).toMatchObject({ forTex: false, byCode: false });
    expect(await isItForTexInGroup(new MemoryStorage(), group("stop"), NOW)).toMatchObject({ forTex: false, byCode: false });
  });

  it("a reply under one of Tex's texts is marked for the judge, and stays the judge's", async () => {
    const storage = new MemoryStorage();
    await storage.put(SENT_KEY, ["h_out_1"]);
    expect(await isItForTexInGroup(storage, group("and saturday?", { replyTo: "h_out_1" }), NOW)).toMatchObject({ forTex: false, repliesToTex: true });
    expect(await isItForTexInGroup(storage, group("and saturday?", { replyTo: "h_other" }), NOW)).toMatchObject({ repliesToTex: false });
  });
});
