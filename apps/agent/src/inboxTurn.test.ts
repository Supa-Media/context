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
 */

import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
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

function world(decision: (body: Decided) => unknown) {
  const decided: Decided[] = [];
  const asks: { question: string; covers?: string[]; chat?: string }[] = [];
  const texts: string[] = [];
  const reactions: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = parsed.pathname;
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok" });
    if (path === "/agent-texts/decide") {
      decided.push(body);
      return Response.json(decision(body));
    }
    if (path === "/agent/events") return Response.json({ written: [] });
    if (path === "/agent") {
      asks.push({ question: body.question, covers: body.covers, ...(body.chat ? { chat: body.chat } : {}) });
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path === "/api/send-reaction" || (parsed.host === "gate.whapi.cloud" && path.startsWith("/messages/") && init?.method === "PUT")) {
      reactions.push(body.reaction ?? body.emoji);
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
  return { deps, decided, asks, texts, reactions };
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

    it(`decide down: every text is answered, each on its own (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world(() => ({ ok: false, reason: "capped" }));
      await accept(storage, msg(line.chatId, "e1", "what's on today"), 1_000);
      await accept(storage, msg(line.chatId, "e2", "and tomorrow"), 1_000);
      await drain(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["what's on today", "and tomorrow"]);
    });
  }

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
