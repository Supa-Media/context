/**
 * Which of a person's texts one turn answers is decide's (`inboxTurn.ts`,
 * style "direct"), on Sendblue and Whapi alike.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `chooseTurn` ignoring `covers` (answering the first text alone) → "a
 *     split request…" fails.
 *  2. `pureAck` true for everything → "silent never leaves a real question
 *     unanswered" fails.
 *  3. `chooseTurn` answering on `react` → "react sends a tapback…" fails.
 *  4. the `!decision.ok` branch dropping the text → "decide down: every
 *     text is answered" fails.
 *  5. `decidedByCode` false for LINK → "LINK is never put to decide" fails.
 *  6. presence started after decide, not before (2026-10-27) → "decide too
 *     slow…" fails.
 *  7. the idle decide given the 30s default, not `IDLE_DECIDE_MS` → "decide
 *     too slow…" fails.
 *  8. `fallbackTurn` without `sameBurst` → "decide down: split words…" fails.
 *  9. `fallbackTurn` without the photo rule → "decide down: a photo then its
 *     words…" fails; `!decision.ok` answering the first text alone fails both.
 * 10. a fixed reply logged under the turn → "a fixed text (no model…" fails.
 * 11. the simulator put to decide → "the simulator is answered directly…"
 *     fails.
 * 12. `drain` starting presence for a burst of pure acks (W16) → "only
 *     'ok', decide silent…" fails.
 * 13. `presence.aim` not called (W17) → "decide react with an answer…"
 *     fails (tapback on the dropped "thanks"); `dropTapback` a no-op →
 *     "presence's tapback, once dropped…" fails.
 */

import { describe, expect, it, vi } from "vitest";
import { IDLE_DECIDE_MS } from "./decide";
import { ACKNOWLEDGE_AFTER_MS, startPresence } from "./presence";
import type { Line } from "./line";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { keptEvents } from "./events";
import { sendblueChatId } from "./sendblue";
import { whapiChatId } from "./whapi";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const LINES = [
  { name: "Sendblue", chatId: sendblueChatId(LINE, PHONE), reaction: "/api/send-reaction" },
  { name: "Whapi", chatId: whapiChatId(LINE, PHONE), reaction: "/messages/" },
];

const msg = (chatId: string, eventId: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId,
  chatId,
  from: PHONE,
  messageId: `m_${eventId}`,
  text,
  ...extra,
});

type Decided = { style: string; candidates: string[]; newest: string; running: boolean; transcript: string; sender?: string };

function world(decision: (body: Decided) => unknown, opts: { decideNeverAnswers?: boolean; agentTakes?: number } = {}) {
  const decided: Decided[] = [];
  const asks: { question: string; covers?: string[]; chat?: string }[] = [];
  const agentBodies: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const reactions: string[] = [];
  /** The message each tapback went on: Sendblue's handle, or Whapi's id in the path. */
  const reactedOn: string[] = [];
  /** The order of what the person can see and what was asked: read, typing, decide, agent. */
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = parsed.pathname;
    if (path === "/api/mark-read" || (parsed.host === "gate.whapi.cloud" && init?.method === "PUT" && path.startsWith("/messages/") && !path.endsWith("/reaction"))) calls.push("read");
    if (/typing|presences/.test(path)) calls.push("typing");
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok" });
    if (path === "/agent-texts/decide") {
      calls.push("decide");
      decided.push(body);
      // A decide that never answers: only the caller's timeout ends the wait.
      if (opts.decideNeverAnswers) {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return Response.json(decision(body));
    }
    if (path === "/agent/events") return Response.json({ written: [] });
    if (path === "/agent") {
      calls.push("agent");
      agentBodies.push(body);
      if (opts.agentTakes) await new Promise((resolve) => setTimeout(resolve, opts.agentTakes));
      asks.push({ question: body.question, covers: body.covers, ...(body.chat ? { chat: body.chat } : {}) });
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path === "/api/send-reaction" || (parsed.host === "gate.whapi.cloud" && path.endsWith("/reaction"))) {
      reactions.push(body.reaction ?? body.emoji);
      reactedOn.push(body.message_handle ?? decodeURIComponent(path.split("/")[2]));
      return Response.json({ status: "OK", sent: true });
    }
    if (path === "/api/send-message" || path === "/messages/text") {
      texts.push(body.content ?? body.body);
      return Response.json({ status: "QUEUED", message_handle: `h_${texts.length}`, sent: true, message: { id: `wa_${texts.length}` } });
    }
    return new Response("{}", { status: path.endsWith("/typing") ? 204 : 200 });
  }) as unknown as Fetch;
  const deps: InboxDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    sendblue: { keyId: "id", secret: "key" },
    whapi: { token: "wt", line: LINE },
    now: () => 5_000,
  };
  return { deps, decided, asks, agentBodies, texts, reactions, reactedOn, calls };
}

const all = (body: Decided) => ({ ok: true, act: "answer", covers: body.candidates, stale: [], movedOn: false, confidence: 0.9 });
const act = (what: "silent" | "react") => () => ({ ok: true, act: what, covers: [], stale: [], movedOn: false, confidence: 0.9 });

describe("decide in a person's own chat", () => {
  for (const line of LINES) {
    it(`a split request, a text then a link a second later, is decided together and answered once (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(all);
      await accept(storage, msg(line.chatId, "e1", "Tex check this link out"), 1_000);
      await accept(storage, msg(line.chatId, "e2", "https://reasonmachines.example/page"), 2_000);
      await drain(storage, w.deps);
      expect(w.decided).toHaveLength(1);
      expect(w.decided[0]).toMatchObject({ style: "direct", running: false, sender: PHONE });
      expect(w.decided[0].candidates).toHaveLength(2);
      expect(w.decided[0].newest).toBe(w.decided[0].candidates[1]);
      expect(w.decided[0].transcript).toContain("Tex check this link out");
      // `covers` goes with the chat key the events carry, so the gateway reads this chat's log.
      expect(w.asks).toEqual([{ question: "Tex check this link out\nhttps://reasonmachines.example/page", covers: w.decided[0].candidates, chat: line.chatId }]);
      // One answer (its link goes as a text of its own, as every link does).
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toHaveLength(1);
    });

    it(`react sends a tapback picked from the words, and no answer (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(act("react"));
      await accept(storage, msg(line.chatId, "e1", "thanks"), 1_000);
      await drain(storage, w.deps);
      expect(w.reactions).toHaveLength(1);
      expect(w.asks).toEqual([]);
      expect(w.texts).toEqual([]);
    });

    it(`react sends decide's emoji when it is one of the 64; wait is answered at once (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(() => ({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.9, emoji: "🙏" }));
      await accept(storage, msg(line.chatId, "e1", "thanks"), 1_000);
      await drain(storage, w.deps);
      expect(w.reactions).toEqual(["🙏"]);
      const waited = new MemoryStorage();
      const v = world(() => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9 }));
      await accept(waited, msg(line.chatId, "e1", "what's on today"), 1_000);
      await drain(waited, v.deps);
      expect(v.asks.map((ask) => ask.question)).toEqual(["what's on today"]);
    });

    it(`silent on "ok" sends nothing at all (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(act("silent"));
      await accept(storage, msg(line.chatId, "e1", "ok"), 1_000);
      await drain(storage, w.deps);
      expect(w.reactions).toEqual([]);
      expect(w.asks).toEqual([]);
      expect(w.texts).toEqual([]);
      expect([...(await storage.list({ prefix: "pending:" }))]).toEqual([]);
    });

    it(`decide down: split words are one text, as before decide; a quoted reply stays its own (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(() => ({ ok: false, reason: "capped" }));
      await accept(storage, msg(line.chatId, "e1", "what's on"), 1_000);
      await accept(storage, msg(line.chatId, "e2", "today"), 1_000);
      await accept(storage, msg(line.chatId, "e3", "and this?", { quoted: "the venue" }), 1_000);
      await drain(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["what's on\ntoday", "and this?"]);
    });

    it(`decide down: a photo then its words is one turn about the photo (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(() => ({ ok: false, reason: "unavailable" }));
      const photo = { attachments: [{ url: "https://cdn.example/p.jpg", filename: "p.jpg", mimeType: "image/jpeg", size: null }] };
      await accept(storage, msg(line.chatId, "e1", "", photo), 1_000);
      await accept(storage, msg(line.chatId, "e2", "what is this"), 1_000);
      await drain(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["what is this"]);
      expect(w.agentBodies[0].attachments).toHaveLength(1);
    });

    it(`decide too slow: past ${IDLE_DECIDE_MS / 1000}s the fallback answers, and the text was read and the bubble up before decide was asked (${line.name})`, async () => {
      vi.useFakeTimers();
      try {
        const storage = new MemoryStorage();
        const w = world(() => ({ ok: false, reason: "unavailable" }), { decideNeverAnswers: true });
        await accept(storage, msg(line.chatId, "e1", "what's on"), 1_000);
        await accept(storage, msg(line.chatId, "e2", "today"), 1_000);
        const draining = drain(storage, w.deps);
        await vi.advanceTimersByTimeAsync(IDLE_DECIDE_MS + 100);
        await draining;
        const first = (name: string) => w.calls.findIndex((call) => call === name);
        expect(first("decide")).toBeGreaterThan(first("read"));
        expect(first("decide")).toBeGreaterThan(first("typing"));
        expect(w.asks.map((ask) => ask.question)).toEqual(["what's on\ntoday"]);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("only 'ok', decide silent: read, never the bubble, no reply", async () => {
    const storage = new MemoryStorage();
    const w = world(act("silent"));
    await accept(storage, msg(LINES[0].chatId, "e1", "ok"), 1_000);
    await drain(storage, w.deps);
    expect(w.calls).toEqual(["read", "decide"]);
    expect(w.texts).toEqual([]);
  });

  it("only 'thanks', decide answers: the bubble starts once decide picked the answer", async () => {
    const storage = new MemoryStorage();
    const w = world(all);
    await accept(storage, msg(LINES[0].chatId, "e1", "thanks"), 1_000);
    await drain(storage, w.deps);
    expect(w.calls.indexOf("typing")).toBeGreaterThan(w.calls.indexOf("decide"));
    expect(w.asks).toHaveLength(1);
  });

  it("decide react with an answer over 10s: exactly one tapback, on the text being answered", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const w = world(act("react"), { agentTakes: 12_000 });
      await accept(storage, msg(LINES[0].chatId, "e1", "thanks"), 1_000);
      await accept(storage, msg(LINES[0].chatId, "e2", "what's on today", { quoted: "x" }), 1_000);
      const draining = drain(storage, w.deps);
      await vi.advanceTimersByTimeAsync(15_000);
      await draining;
      expect(w.asks.map((ask) => ask.question)).toEqual(["what's on today"]);
      expect(w.reactedOn).toEqual(["m_e2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("presence's tapback, once dropped (decide's react went), never goes; aimed, it goes on the aimed text", async () => {
    vi.useFakeTimers();
    try {
      const acks: string[] = [];
      const line = { markRead: async () => {}, startTyping: async () => {}, acknowledge: async (_chat: string, id: string) => void acks.push(id) } as unknown as Line;
      const dropped = await startPresence(line, msg("c", "e1", "thanks"));
      dropped.dropTapback();
      const aimed = await startPresence(line, msg("c", "e2", "thanks"));
      aimed.aim(msg("c", "e3", "what's on"));
      await vi.advanceTimersByTimeAsync(ACKNOWLEDGE_AFTER_MS + 100);
      await dropped.stop();
      await aimed.stop();
      expect(acks).toEqual(["m_e3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("silent never leaves a real question unanswered in a person's own chat", async () => {
    const storage = new MemoryStorage();
    const w = world(act("silent"));
    await accept(storage, msg("chat_1", "e1", "what's on my calendar"), 1_000);
    await drain(storage, w.deps);
    expect(w.asks.map((ask) => ask.question)).toEqual(["what's on my calendar"]);
  });

  it("covers that leave an older text out answer it first, on its own, in order", async () => {
    const storage = new MemoryStorage();
    const w = world((body) => ({ ok: true, act: "answer", covers: [body.newest], stale: [], movedOn: false, confidence: 0.9 }));
    await accept(storage, msg("chat_1", "e1", "first question"), 1_000);
    await accept(storage, msg("chat_1", "e2", "second question", { quoted: "x" }), 1_000);
    await drain(storage, w.deps);
    expect(w.asks.map((ask) => ask.question)).toEqual(["first question", "second question"]);
  });

  it("a fixed text (no model, the daily limit, a failure) is logged as the system's with no turn; the model's answer as Tex's under its turn", async () => {
    for (const [status, body] of [
      [409, { error: "no_provider" }],
      [429, { error: "daily_limit" }],
      [500, {}],
    ] as const) {
      const storage = new MemoryStorage();
      const w = world(all);
      const fixed = (async (url: string, init?: RequestInit) =>
        new URL(url).pathname === "/agent" ? Response.json(body, { status }) : w.deps.fetch(url, init)) as unknown as Fetch;
      await accept(storage, msg("chat_1", "e1", "what's on"), 1_000);
      await drain(storage, { ...w.deps, fetch: fixed });
      const out = (await keptEvents(storage, "chat_1")).filter((event) => event.from.kind !== "person");
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ from: { kind: "system" }, delivered: true });
      expect(out[0].turn).toBeUndefined();
      expect(out[0].covers).toBeUndefined();
    }
    const storage = new MemoryStorage();
    const w = world(all);
    await accept(storage, msg("chat_1", "e1", "what's on"), 1_000);
    await drain(storage, w.deps);
    const [answer] = (await keptEvents(storage, "chat_1")).filter((event) => event.from.kind !== "person");
    expect(answer).toMatchObject({ from: { kind: "tex" }, text: "answer to what's on" });
    expect(typeof answer.turn).toBe("string");
  });

  it("the simulator is answered directly, never put to decide", async () => {
    const storage = new MemoryStorage();
    const w = world(act("silent"));
    await accept(storage, msg("sim_1", "e1", "what's on", { channel: "simulator" }), 1_000);
    await drain(storage, w.deps);
    expect(w.decided).toEqual([]);
    expect(w.asks.map((ask) => ask.question)).toEqual(["what's on"]);
  });

  it("LINK is never put to decide", async () => {
    const storage = new MemoryStorage();
    const w = world(act("silent"));
    await accept(storage, msg("chat_1", "e1", "link ABCD2345"), 1_000);
    const linked = (async (url: string, init?: RequestInit) =>
      new URL(url).pathname === "/agent-texts/link" ? Response.json({ status: "linked", handle: "ada" }) : w.deps.fetch(url, init)) as unknown as Fetch;
    await drain(storage, { ...w.deps, fetch: linked });
    expect(w.decided).toEqual([]);
  });
});
