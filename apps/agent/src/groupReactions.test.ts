/**
 * Every reaction in a group is input (Dev2, 2026-11-01; bug reports 705d8954
 * and 70c05f: a 👍 on Tex's settings question, "👍 or 👎?", was dropped as
 * `group_reaction`). `groupInbox.ts` `acceptReaction`;
 * docs/decisions/texting-assistant/reactions-as-input.md.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `acceptReaction` holding anybody's 👍 on the ask (no `asker` check).
 *     → "somebody else's 👍 never releases the asker's email" and "a guest's
 *     👍 never approves" fail.
 *  2. `answersTex` always false. → "a 👍 on Tex's settings question is
 *     answered as yes" and "a 👎 is answered as no" fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import { keptEvents } from "./events";
import { MemoryStorage } from "./memoryStorage.testing";
import { parseWhapiWebhook } from "./whapiInbound";
import type { GroupMessage } from "./sendblueGroups";
import type { Reaction } from "./reactions";
import type { Fetch } from "./clients";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const SETTINGS = "I'd make this chat's humor 30% and emoji off. 👍 or 👎?";
const EMAIL = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\n@ada, give it a 👍 and I'll send it.";

const msg = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  kind: "group-message",
  eventId: `sendblue:${extra.messageId ?? "in"}`,
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants: [ADA, BO, LINE],
  messageId: extra.messageId ?? "in",
  text,
  ...extra,
});
const reacted = (from: string, id: string, reaction: Reaction) => msg(`${reaction.how} “${reaction.words}”`, { from, messageId: id, reaction });

type Answer = { answer: string; verbatim?: string[] };

/** A bound chat whose decide stays silent on everything it is asked, so only what code answers gets a turn. */
function groupDeps(asks: Record<string, unknown>[], answer: Answer, control: Record<string, unknown> = {}): GroupDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) return Response.json({ participants: [{ number: ADA }, { number: BO }] });
    const body = JSON.parse(String(init.body));
    if (path === "/agent-texts/group") return Response.json({ status: "ready", slug: "band", intro: false, bound: true, handle: "ada", accessToken: "cat", ...control });
    if (path === "/agent-texts/decide") return Response.json({ ok: true, act: "silent", covers: [], stale: [], movedOn: false, confidence: 0.9 });
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent") {
      asks.push(body);
      return Response.json(answer);
    }
    return Response.json({ message_handle: `out_${asks.length}` });
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://c.test", workerSecret: "s", gatewayOrigin: "https://g.test", sendblue: { keyId: "i", secret: "k" }, now: () => 1_000 };
}

/** Tex says `text` in the chat as Ada's turn, so the chat is bound and its words are Tex's in the log. */
async function texSaid(storage: MemoryStorage, asks: Record<string, unknown>[], text: string, control: Record<string, unknown> = {}): Promise<void> {
  await acceptGroup(storage, msg("Tex, settings for this chat?", { messageId: "tag" }), 0);
  await drainGroup(storage, groupDeps(asks, { answer: text, ...(text === EMAIL ? { verbatim: [text] } : {}) }, control));
}

afterEach(() => vi.restoreAllMocks());

describe("a reaction in a group", () => {
  for (const [how, emoji, answer] of [["Liked", "👍", "yes"], ["Disliked", "👎", "no"]] as const) {
    it(`a ${emoji} on Tex's settings question is answered as ${answer}, whatever decide says`, async () => {
      const storage = new MemoryStorage();
      const asks: Record<string, unknown>[] = [];
      await texSaid(storage, asks, SETTINGS);
      expect(await acceptGroup(storage, reacted(ADA, "r1", { how, words: SETTINGS }), 1_000)).toBe("queued");
      await drainGroup(storage, groupDeps(asks, { answer: "Done." }));
      expect(asks).toHaveLength(2);
      expect(asks[1].question).toBe(`${emoji} (${answer}) on Tex's message "${SETTINGS}"`);
      // Its line alone: no tapback reaches the gateway, so it can release nothing held.
      expect(asks[1]).not.toHaveProperty("tapback");
      expect((await keptEvents(storage, GROUP)).some((event) => event.kind === "reaction" && event.text === asks[1].question)).toBe(true);
    });
  }

  it("a heart on somebody's statement is a line of the chat, never a turn of its own", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    await texSaid(storage, asks, SETTINGS);
    const logs = vi.spyOn(console, "log");
    expect(await acceptGroup(storage, reacted(BO, "r1", { how: "Loved", words: "drinks after load in" }), 1_000)).not.toBe("queued");
    await drainGroup(storage, groupDeps(asks, { answer: "Hm." }));
    expect(asks).toHaveLength(1);
    expect((await keptEvents(storage, GROUP)).map((event) => event.text)).toContain(`❤️ (yes) on the message "drinks after load in"`);
    expect(logs.mock.calls.flat().join("\n")).toContain('"outcome":"reaction_context"');
  });

  it("somebody else's 👍 never releases the asker's email", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    await texSaid(storage, asks, EMAIL);
    expect(await acceptGroup(storage, reacted(BO, "bo", { how: "Liked", words: EMAIL }), 1_000)).not.toBe("queued");
    expect(await storage.get("gthumb")).toBeUndefined();
    await drainGroup(storage, groupDeps(asks, { answer: "Sent." }));
    expect(asks.filter((ask) => ask.tapback !== undefined)).toEqual([]);
  });

  it("a guest's 👍 never approves", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    const guests = { guests: [{ phone: BO, label: "guest-1a2b" }] };
    await texSaid(storage, asks, EMAIL, guests);
    await acceptGroup(storage, reacted(BO, "bo", { how: "Liked", words: EMAIL }), 1_000);
    await acceptGroup(storage, reacted(BO, "bo2", { how: "Liked", words: SETTINGS }), 1_000);
    expect(await storage.get("gthumb")).toBeUndefined();
    await drainGroup(storage, groupDeps(asks, { answer: "Sure." }, guests));
    expect(asks.filter((ask) => ask.tapback !== undefined)).toEqual([]);
  });

  it("a tapback taken back is logged, and drops nothing of anybody else's", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    await texSaid(storage, asks, EMAIL);
    expect(await acceptGroup(storage, reacted(ADA, "ada", { how: "Liked", words: EMAIL }), 1_000)).toBe("queued");
    const logs = vi.spyOn(console, "log");
    expect(await acceptGroup(storage, reacted(BO, "bo", { how: "Liked", words: EMAIL, removed: true }), 1_000)).toBe("ignored");
    expect(await storage.get("gthumb")).toBeDefined();
    expect((await keptEvents(storage, GROUP)).some((event) => event.kind === "reaction" && event.text?.startsWith("took back 👍 on Tex's message"))).toBe(true);
    expect(logs.mock.calls.flat().join("\n")).toContain('"outcome":"reaction_removed"');
  });
});

describe("a WhatsApp group reaction", () => {
  it("is read whatever the emoji, not only a like or a love", () => {
    const read = (emoji: string) =>
      parseWhapiWebhook(
        { messages: [{ id: "3EB0ABCD-EF121234", from_me: false, type: "action", chat_id: "120363012345678901@g.us", from: "15555550100", timestamp: 1, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji } }] },
        LINE,
      )[0];
    expect(read("😂")).toMatchObject({ kind: "group-message", reaction: { how: "Laughed at" }, reactionOn: "3EB0TARGET-ABCD7777" });
    expect(read("🎉")).toMatchObject({ kind: "group-message", reaction: { how: "Reacted", emoji: "🎉" } });
  });
});
