import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptGroup, drainGroup } from "./groupInbox";
import { groupCommand } from "./groupWords";
import { ADA, BO, LINES, setup } from "./groupWorld.testing";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { sharingReply, sharingWords, type SharingAnswer } from "./reviewSharing";
import { checkReview, SHARED_KEY } from "./reviewWatch";

/**
 * SHARING CHATS WITH THE DEVS, BY TEXT (Dev2, 2026-10-29; `reviewSharing.ts`).
 *
 * "Tex, share my chats with the devs" sets the same switch as Settings →
 * Feedback, read from the person's own words by code, never by the model. A
 * 1:1 yes also files the history Tex keeps of that chat, once. "Stop sharing
 * with the devs" turns it off; "am I sharing with the devs?" asks.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `sharingWords` reading "share my notes with the team" as a yes         1
 *   `isSettingsText` not counting sharing words (decide reads it)        1
 *   `reply.ts` backfilling on an unchanged yes                             1
 *   `checkShared` asking without `whole`                                   1
 */

const PHONE = "+15555550100";
const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: PHONE, messageId: `m_${eventId}`, text });

type Seen = { sharing: Record<string, unknown>[]; reviews: Record<string, unknown>[]; sent: string[]; asked: number; decided?: number };

function deps(now: () => number, seen: Seen, answer: (body: Record<string, unknown>) => SharingAnswer): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body ?? "{}"));
    if (path.endsWith("/typing") || path.endsWith("/read") || path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok-fake" });
    if (path === "/agent-texts/review-sharing") {
      seen.sharing.push(body);
      return Response.json(answer(body));
    }
    if (path === "/agent") {
      seen.asked += 1;
      return Response.json({ answer: "Model answer." });
    }
    if (path === "/agent/review") {
      seen.reviews.push(body);
      return Response.json({ filed: "full" });
    }
    if (path.endsWith("/messages")) {
      seen.sent.push(JSON.stringify(body));
      return new Response("{}", { status: 200 });
    }
    if (path === "/agent-texts/decide") {
      seen.decided = (seen.decided ?? 0) + 1;
      return Response.json({ action: "answer" });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now };
}

describe("the words for the switch", () => {
  it.each([
    "Tex, share my chats with the devs",
    "share my chats with the devs",
    "Opt into sharing with devs",
    "opt in to sharing my history with the developers!",
    "Tex share my history with the dev team",
    "yes, share with the devs",
    "“share my conversations with the Tex team”",
    "start sharing my texts with the devs",
    "the devs can read my chats",
    "use my chats to improve Tex",
  ])("%s is a yes", (text) => expect(sharingWords(text)).toBe("on"));

  it.each([
    "stop sharing with the devs",
    "Tex, stop sharing my chats with the devs.",
    "opt out of sharing",
    "opt out of sharing my history with the devs",
    "stop sharing my chats",
    "don't share my chats with the devs",
    "turn off sharing with devs",
  ])("%s is a no", (text) => expect(sharingWords(text)).toBe("off"));

  it.each(["am I sharing with the devs?", "Tex are you sharing my chats with the devs", "what do the devs see?", "can the devs read my chats?"])("%s asks", (text) =>
    expect(sharingWords(text)).toBe("ask"),
  );

  it.each([
    "share my notes with the team",
    "share my chats with the team",
    "share this with Sam",
    "can you share the doc with the devs and tell them it's ready",
    "stop",
    "stop sharing",
    "stop sharing that note",
    "opt out",
    "turn off sharing",
    "stop sharing my mail here",
    "the devs shipped a fix, can you check my chats are working",
    "opt in",
  ])("%s is not about the switch", (text) => expect(sharingWords(text)).toBeNull());

  it("a group reads it after Tex's name, as the sender's own switch", () => {
    expect(groupCommand("Tex, share my chats with the devs")).toEqual({ kind: "review_sharing", sharing: "on" });
    expect(groupCommand("Tex stop sharing with the devs")).toEqual({ kind: "review_sharing", sharing: "off" });
    // Sharing mail with the chat is still its own command.
    expect(groupCommand("Tex, stop sharing my mail")?.kind).toBe("unshare_mail");
  });
});

describe("what Tex says back", () => {
  const ok = (over: Partial<Extract<SharingAnswer, { status: "ok" }>> = {}): SharingAnswer => ({ status: "ok", sharing: true, changed: true, team: false, ...over });

  it("a yes says who reads what, that it is never public or sold, and how to stop", () => {
    const text = sharingReply("on", ok(), { backfill: true });
    expect(text).toContain("the Context team (the people who build Tex) can read the whole thing");
    expect(text).toContain("never public, never sold, never used for ads");
    expect(text).toContain("past texts");
    expect(text).toContain('"stop sharing with the devs"');
  });

  it("a group yes says the whole chat must agree, and whether it has, naming nobody", () => {
    expect(sharingReply("on", ok({ chatShared: false }), { inGroup: true })).toContain("Not everyone here has yet");
    expect(sharingReply("on", ok({ chatShared: true }), { inGroup: true })).toContain("Everyone here has");
    expect(sharingReply("on", ok({ chatShared: true }), { inGroup: true })).not.toContain("past texts");
  });

  it("a no says what is kept instead, and that what went already stays", () => {
    const text = sharingReply("off", ok({ sharing: false }));
    expect(text).toContain("no words and no name");
    expect(text).toContain("already shared stays");
    expect(sharingReply("off", ok({ sharing: false, changed: false }))).toContain("weren't sharing");
  });

  it("the team is told their chats go to reviews either way", () => {
    expect(sharingReply("off", ok({ sharing: false, team: true }))).toContain("on the Context team");
  });

  it("a control plane that can't be reached changes nothing and says so", () => {
    expect(sharingReply("on", null)).toContain("couldn't change that");
  });
});

describe("a 1:1 text sets it by code, and a yes files the kept history once", () => {
  it("yes: saved for the phone, answered without the model, history asked with whole once", async () => {
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const seen: Seen = { sharing: [], reviews: [], sent: [], asked: 0 };
    const d = deps(() => now, seen, () => ({ status: "ok", sharing: true, changed: true, team: false }));
    await accept(storage, msg("e1", "Tex, share my chats with the devs"), now);
    await drain(storage, d);
    expect(seen.sharing).toEqual([{ phone: PHONE, share: true }]);
    // Code's to answer: neither the model nor decide (which may stay silent) reads it.
    expect(seen.asked).toBe(0);
    expect(seen.decided ?? 0).toBe(0);
    expect(seen.sent.join("\n")).toContain("sharing your chats with the devs");
    expect(await storage.get(SHARED_KEY)).toEqual({ phone: PHONE });

    await checkReview(storage, d);
    expect(seen.reviews).toEqual([{ conversation: "texts", whole: true }]);
    expect(await storage.get(SHARED_KEY)).toBeUndefined();
    await checkReview(storage, d);
    expect(seen.reviews).toHaveLength(1);
  });

  it("a yes already given files nothing again", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { sharing: [], reviews: [], sent: [], asked: 0 };
    const d = deps(() => 1_000_000, seen, () => ({ status: "ok", sharing: true, changed: false, team: false }));
    await accept(storage, msg("e1", "share with the devs"), 1_000_000);
    await drain(storage, d);
    expect(seen.sent.join("\n")).toContain("already sharing");
    expect(await storage.get(SHARED_KEY)).toBeUndefined();
  });

  it("no: saved off, nothing filed", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { sharing: [], reviews: [], sent: [], asked: 0 };
    const d = deps(() => 1_000_000, seen, () => ({ status: "ok", sharing: false, changed: true, team: false }));
    await accept(storage, msg("e1", "stop sharing with the devs"), 1_000_000);
    await drain(storage, d);
    expect(seen.sharing).toEqual([{ phone: PHONE, share: false }]);
    expect(seen.asked).toBe(0);
    expect(await storage.get(SHARED_KEY)).toBeUndefined();
  });

  it("a question only reads it", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { sharing: [], reviews: [], sent: [], asked: 0 };
    const d = deps(() => 1_000_000, seen, () => ({ status: "ok", sharing: false, changed: false, team: false }));
    await accept(storage, msg("e1", "am I sharing with the devs?"), 1_000_000);
    await drain(storage, d);
    expect(seen.sharing).toEqual([{ phone: PHONE }]);
    expect(seen.sent.join("\n")).toContain("not sharing");
  });
});

for (const { name, groupId } of LINES) {
  describe(`in a group, ${name}`, () => {
    it("the sender's own switch, with the chat's people for whether it counts, and no model", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, share my chats with the devs"), 0);
      await drainGroup(storage, w.deps);
      expect(w.sharing).toHaveLength(1);
      expect(w.sharing[0]!.phone).toBe(ADA);
      expect(w.sharing[0]!.share).toBe(true);
      expect([...(w.sharing[0]!.participants as string[])].sort()).toEqual([ADA, BO].sort());
      expect(w.asks).toEqual([]);
      expect(w.texts[0]).toContain("Not everyone here has yet");
    });
  });
}
