/**
 * A text Tex is working on shows the typing bubble, renewed, and gets no
 * tapback beside the answer: a tapback goes only in place of a text (Dev2,
 * 2026-11-10: "Tex spams and uses emojis way too much"; the after-10-seconds
 * tapback of 2026-10-19 put an emoji next to every slow answer).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. The old 10-second tapback timer put back in `presence.ts` → "a long turn gets no tapback" fails.
 *  2. The bubble's renewal dropped → "...and the bubble renewed" fails.
 *  3. `reactionFor`'s fallback dropped → "a refused emoji falls back to a thumbs-up" fails.
 */

import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, TYPING_REFRESH_MS, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { sendblueChatId } from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

/** Sendblue, and a gateway that answers once `finish` is called. */
function fake(calls: Call[], reactionStatus = 200, react?: string) {
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
      return Response.json(react === undefined ? { answer: `answer to ${body.question}` } : { answer: "", quiet: true, react });
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
async function answered(text: Message, ms: number, reactionStatus = 200, react?: string): Promise<Call[]> {
  vi.useFakeTimers();
  try {
    const storage = new MemoryStorage();
    await accept(storage, text, 1_000);
    const calls: Call[] = [];
    const { fetcher, finish } = fake(calls, reactionStatus, react);
    const draining = drain(storage, deps(fetcher));
    await vi.advanceTimersByTimeAsync(ms);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    await draining;
    // Nothing is left to fire once the text is answered.
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    return calls;
  } finally {
    vi.useRealTimers();
  }
}

const reactions = (calls: Call[]) => calls.filter((c) => c.path === "/api/send-reaction");

describe("a text Tex is working on shows the bubble, never a tapback beside the answer", () => {
  it("a long turn gets no tapback, and the bubble renewed", async () => {
    const calls = await answered(message("mh_long", "email her"), 3 * 60_000);
    expect(reactions(calls)).toEqual([]);
    // Read and the bubble first, asked again shortly after, then renewed while the turn runs.
    expect(calls.slice(0, 2).map((c) => c.path)).toEqual(["/api/mark-read", "/api/send-typing-indicator"]);
    expect(calls.filter((c) => c.path === "/api/send-typing-indicator").length).toBeGreaterThanOrEqual(4);
    expect(calls.some((c) => c.path === "/api/send-message" && c.body.content === "answer to email her")).toBe(true);
  });

  it("a quick answer gets no tapback", async () => {
    const calls = await answered(message("mh_quick", "hi"), 2_000);
    expect(reactions(calls)).toEqual([]);
  });

  it("a text that is upset with Tex gets no tapback beside the answer either", async () => {
    const calls = await answered(message("mh_upset", "did you see anything I said in this thread at all??? are you dumb???"), 60_000);
    expect(reactions(calls)).toEqual([]);
  });

  it("a tapback in place of a text goes, and a refused emoji falls back to a thumbs-up", async () => {
    const calls = await answered(message("mh_refused", "ok cool"), 2_000, 422, "🎉");
    expect(reactions(calls).map((c) => c.body.reaction)).toEqual(["🎉", "like"]);
    expect(calls.some((c) => c.path === "/api/send-message" && String(c.body.content ?? "").includes("answer"))).toBe(false);
  });
});
