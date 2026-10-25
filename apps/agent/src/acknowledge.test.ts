/**
 * A text still being worked on gets a tapback that fits it (`ACKNOWLEDGE_AFTER_MS`, `ackEmoji.ts`),
 * because Sendblue's typing bubble is best effort: on 2026-10-19 Dev saw "Read"
 * and nothing else for two minutes.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. No `setTimeout` for the tapback → "a long turn gets one thumbs-up" fails.
 *  2. `clearTimeout(acknowledge)` dropped → "a quick answer gets no tapback" fails.
 *  3. The tapback not followed by the bubble → "...and the bubble again" fails.
 *  4. `ackEmoji` always 👍 → "a text that is upset with Tex gets a sorry face" fails (2026-10-20).
 */

import { describe, expect, it, vi } from "vitest";
import { ackEmoji } from "./ackEmoji";
import type { Fetch } from "./clients";
import { accept, ACKNOWLEDGE_AFTER_MS, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { sendblueChatId } from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

/** Sendblue, and a gateway that answers once `finish` is called. */
function fake(calls: Call[], reactionStatus = 200) {
  let finish = () => {};
  const answered = new Promise<void>((done) => (finish = done));
  const fetcher = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    if (parsed.host === "api.sendblue.com") {
      calls.push({ path: parsed.pathname, body });
      if (parsed.pathname === "/api/v2/contact-sharing/state") {
        return Response.json({ status: "OK", data: { hasProfile: true, publishRecordPresent: true } });
      }
      return new Response('{"status":"QUEUED"}', { status: parsed.pathname === "/api/send-reaction" ? reactionStatus : 200 });
    }
    if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (parsed.pathname === "/agent") {
      await answered;
      return Response.json({ answer: `answer to ${body.question}` });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
  return { fetcher, finish: () => finish() };
}

function deps(fetcher: Fetch): InboxDeps {
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "linq-key",
    sendblue: { keyId: "kid", secret: "ksecret" },
    hostPicture: async () => "https://agent.example/media/abc/card.vcf",
    now: () => 1_000,
  };
}

const message = (handle: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId: `sendblue:${handle}`,
  chatId: CHAT,
  from: PHONE,
  messageId: handle,
  text,
  ...extra,
});

/** Drain one text whose answer takes `ms`, and the Sendblue calls made. */
async function answered(text: Message, ms: number, reactionStatus = 200): Promise<Call[]> {
  vi.useFakeTimers();
  try {
    const storage = new MemoryStorage();
    await accept(storage, text, 1_000);
    const calls: Call[] = [];
    const { fetcher, finish } = fake(calls, reactionStatus);
    const draining = drain(storage, deps(fetcher));
    await vi.advanceTimersByTimeAsync(ms);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    await draining;
    // Nothing is left to fire once the text is answered.
    await vi.advanceTimersByTimeAsync(ACKNOWLEDGE_AFTER_MS * 2);
    return calls;
  } finally {
    vi.useRealTimers();
  }
}

const reactions = (calls: Call[]) => calls.filter((c) => c.path === "/api/send-reaction");

describe("a text Tex is still working on is acknowledged", () => {
  it("a long turn gets one tapback on the text, and the bubble again", async () => {
    const calls = await answered(message("mh_long", "email her"), 3 * 60_000);
    // Sending the tapback can clear the bubble, so it is asked for again at once.
    const early = await answered(message("mh_early", "email her"), ACKNOWLEDGE_AFTER_MS + 5_000);
    expect(early.filter((c) => c.path === "/api/send-typing-indicator")).toHaveLength(3);
    expect(reactions(calls).map((c) => c.body)).toEqual([{ from_number: LINE, message_handle: "mh_long", reaction: ackEmoji("email her") }]);
    const at = calls.findIndex((c) => c.path === "/api/send-reaction");
    expect(calls[at + 1]?.path).toBe("/api/send-typing-indicator");
    // Read and the bubble come first, the tapback only once the turn has run a while.
    expect(calls.slice(0, 2).map((c) => c.path)).toEqual(["/api/mark-read", "/api/send-typing-indicator"]);
    expect(calls.some((c) => c.path === "/api/send-message" && c.body.content === "answer to email her")).toBe(true);
  });

  it("a quick answer gets no tapback: the answer is the acknowledgement", async () => {
    const calls = await answered(message("mh_quick", "hi"), ACKNOWLEDGE_AFTER_MS - 2_000);
    expect(reactions(calls)).toEqual([]);
  });

  it("a tapback is never tapped back", async () => {
    const calls = await answered(message("mh_tap", "Liked", { tapback: "Liked", quoted: "Want me to?" }), 60_000);
    expect(reactions(calls)).toEqual([]);
  });

  it("a text that is upset with Tex gets a sorry face, never a thumbs-up", async () => {
    const calls = await answered(message("mh_upset", "did you see anything I said in this thread at all??? are you dumb???"), 60_000);
    expect(["☹️", "😔"]).toContain(reactions(calls)[0]?.body.reaction);
  });

  it("a refused emoji falls back to a thumbs-up, and the answer still goes", async () => {
    const calls = await answered(message("mh_refused", "email her"), 60_000, 422);
    expect(reactions(calls).map((c) => c.body.reaction)).toEqual([ackEmoji("email her"), "like"]);
    expect(calls.some((c) => c.path === "/api/send-message" && c.body.content === "answer to email her")).toBe(true);
  });
});
