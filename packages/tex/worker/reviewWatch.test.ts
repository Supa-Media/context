import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { checkReview, REVIEW_KEY, REVIEW_QUIET_MS, watchConversation, type Watch } from "./reviewWatch";
import type { GroupMessage } from "./sendblueGroups";

/**
 * A CONVERSATION THAT WENT QUIET IS SCORED (the owner, 2026-10-24;
 * `apps/mcp/src/agent/selfReview.js`).
 *
 * Every answered text starts the watch over; once the chat has been quiet for
 * `REVIEW_QUIET_MS`, the alarm asks the gateway for one review, with a token
 * minted the way a turn's is, and drops the watch. Nothing it keeps is a word.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `answering` not starting the watch                                   1
 *   `checkReview` asking before the chat went quiet                      2
 *   `checkReview` keeping the watch after asking                         1
 */

const PHONE = "+15555550100";
const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: PHONE, messageId: `m_${eventId}`, text });

type Seen = { reviews: { token: string; body: Record<string, unknown> }[] };

function deps(now: () => number, seen: Seen): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read") || path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok-fake" });
    if (path === "/agent") return Response.json({ answer: "Here it is." });
    if (path === "/agent/review") {
      seen.reviews.push({ token: new Headers(init.headers).get("authorization") ?? "", body });
      return Response.json({ filed: "scores" });
    }
    if (path.endsWith("/messages")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now };
}

describe("a quiet chat's conversation is scored once", () => {
  it("an answered text starts the watch, a later one starts it over, and quiet asks the gateway once", async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const seen: Seen = { reviews: [] };
    const d = deps(() => now, seen);
    await accept(storage, msg("e1", "find my avocado note"), now);
    await drain(storage, d);
    const first = await storage.get<Watch>(REVIEW_KEY);
    expect(first).toEqual({ kind: "one", phone: PHONE, dueAt: now + REVIEW_QUIET_MS });

    now += REVIEW_QUIET_MS - 60_000;
    await accept(storage, msg("e2", "and the banana one?"), now);
    await drain(storage, d);
    expect(await checkReview(storage, d)).toBe(false);
    expect(seen.reviews).toEqual([]);

    now += REVIEW_QUIET_MS;
    expect(await checkReview(storage, d)).toBe(true);
    expect(seen.reviews).toEqual([{ token: "Bearer tok-fake", body: { conversation: "texts" } }]);
    expect(await storage.get(REVIEW_KEY)).toBeUndefined();
    expect(await checkReview(storage, d)).toBe(false);
    expect(seen.reviews).toHaveLength(1);
  });

  it("not yet quiet: the alarm is set for when it will be", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { reviews: [] };
    await watchConversation(storage, { kind: "one", phone: PHONE }, 5_000);
    expect(storage.alarms.at(-1)).toBe(5_000 + REVIEW_QUIET_MS);
    expect(await checkReview(storage, deps(() => 6_000, seen))).toBe(false);
    expect(seen.reviews).toEqual([]);
  });

  it("a group keeps who and where, never the words, and asks with the group's own minted token", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { reviews: [] };
    const message: GroupMessage = {
      kind: "group-message",
      eventId: "g1",
      groupId: "group-fake",
      line: "+15555550199",
      from: PHONE,
      participants: [PHONE, "+15555550101"],
      messageId: "m_g1",
      text: "Tex open the avocado login",
    };
    await watchConversation(storage, { kind: "group", message, people: [PHONE, "+15555550101"] }, 0);
    expect(JSON.stringify(await storage.get(REVIEW_KEY))).not.toContain("avocado");
    const asked = await checkReview(storage, {
      ...deps(() => REVIEW_QUIET_MS, seen),
      mintGroup: async () => ({ accessToken: "group-tok-fake", handle: "alice-handle", names: [{ phone: PHONE, handle: "alice-handle" }] }),
    });
    expect(asked).toBe(true);
    const [review] = seen.reviews;
    expect(review!.token).toBe("Bearer group-tok-fake");
    const group = review!.body.group as Record<string, unknown>;
    expect(group.from).toBe("alice-handle");
    expect(group.key).toMatch(/^[0-9a-f]{64}$/);
    expect(group.members).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the log says whether an asked review was filed, or why not", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    for (const answer of [{ filed: "scores" }, { filed: null, why: "nothing_new" }]) {
      const storage = new MemoryStorage();
      await watchConversation(storage, { kind: "one", phone: PHONE }, 0);
      const d = deps(() => REVIEW_QUIET_MS, { reviews: [] });
      const fetcher = d.fetch;
      d.fetch = (async (url: string, init: RequestInit) => (new URL(url).pathname === "/agent/review" ? Response.json(answer) : fetcher(url, init))) as unknown as Fetch;
      expect(await checkReview(storage, d)).toBe(true);
    }
    spy.mockRestore();
    const outcomes = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "review_watch");
    expect(outcomes).toEqual([
      { event: "review_watch", outcome: "asked", filed: "scores" },
      { event: "review_watch", outcome: "asked", why: "nothing_new" },
    ]);
  });

  it("a group that is no longer ready is not reviewed", async () => {
    const storage = new MemoryStorage();
    const seen: Seen = { reviews: [] };
    const message = { kind: "group-message", eventId: "g1", groupId: "g", line: "+15555550199", from: PHONE, participants: [PHONE], messageId: "m", text: "" } as GroupMessage;
    await watchConversation(storage, { kind: "group", message, people: [PHONE] }, 0);
    expect(await checkReview(storage, { ...deps(() => REVIEW_QUIET_MS, seen), mintGroup: async () => null })).toBe(false);
    expect(seen.reviews).toEqual([]);
    expect(await storage.get(REVIEW_KEY)).toBeUndefined();
  });
});
