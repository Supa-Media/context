/**
 * Tex answers the way it was texted (docs.sendblue.com, iMessage inline
 * replies; the owner, 2026-10-20): a text typed inside a thread is answered
 * there, a new topic (a plain text after a quiet spell) in a thread under
 * it, any other plain text plainly, and a text a newer one overtook in its
 * thread, so the answer reads next to what it answers.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `threadFor` returning undefined → "an inline reply is answered inside its
 *     thread" and "a text a newer one overtook…" fail; returning the handle
 *     always → "a plain text in a running conversation…" fails; ignoring
 *     `newTopic` → "a plain text after a quiet spell starts a topic…" fails.
 *  2. `sendMessage` throwing on a refused threaded send instead of sending it
 *     plain → "a thread Sendblue refuses still gets the answer" fails.
 *  3. `index.ts` not setting `threaded` → "an inline reply is queued as one"
 *     fails (worker.test.ts).
 *  4. `threadContext` keeping a parent from another thread → "a reply typed
 *     inside a thread is about that thread" fails.
 *  5. `chooseTurn` (`inboxTurn.ts`) answering only the first text decide
 *     covers → "inline replies sent back to back…" and "plain texts sent
 *     back to back…" fail; joining texts decide left out → "a reply to other
 *     words…" fails. (Which texts are one turn is decide's since 2026-10-26.)
 */

import { describe, expect, it, vi } from "vitest";
import { askAgent, type Fetch } from "./clients";
import { accept, CHAT_KEY, drain, NEW_TOPIC_AFTER_MS, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { coverAll, coverNewest } from "./decideStub.testing";
import type { Message } from "./reply";
import { parseSendblueInbound, repliedToText, sendblueChatId, sendSendblueText, threadContext } from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };
const CHAT = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

/** Sendblue and the gateway, answering each question with words only. */
function fake(
  calls: Call[],
  agent: Record<string, unknown>[] = [],
  status: (body: Record<string, unknown>) => number = () => 200,
  decided: (init: RequestInit) => Response = coverNewest,
): Fetch {
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    if (parsed.host === "api.sendblue.com") {
      calls.push({ path: parsed.pathname, body });
      if (parsed.pathname === "/api/v2/contact-sharing/state") {
        return Response.json({ status: "OK", data: { hasProfile: true, publishRecordPresent: true } });
      }
      return new Response('{"status":"QUEUED"}', { status: status(body) });
    }
    if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (parsed.pathname === "/agent-texts/decide") return decided(init);
    if (parsed.pathname === "/agent/events") return Response.json({ written: [] });
    if (parsed.pathname === "/agent") {
      agent.push(body);
      return Response.json({ answer: `answer to ${body.question}` });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
}

function deps(fetcher: Fetch): InboxDeps {
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "linq-key",
    sendblue: KEYS,
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

const answers = (calls: Call[]) =>
  calls.filter((c) => c.path === "/api/send-message" && typeof c.body.content === "string" && String(c.body.content).startsWith("answer"));

describe("Tex answers inside iMessage threads", () => {
  it("an inline reply is answered inside its thread", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_r", "try again", { threaded: true, quoted: "The Oct 30 price isn't in your notes." }), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_r" }]);
  });

  it("a plain text in a running conversation is answered plainly", async () => {
    const storage = new MemoryStorage();
    await storage.put(CHAT_KEY, { chatId: CHAT, at: 1_000 - NEW_TOPIC_AFTER_MS + 1 });
    await accept(storage, message("mh_p", "and make it blue"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => c.body.reply_to)).toEqual([undefined]);
  });

  it("a plain text after a quiet spell starts a topic, answered in a thread under it", async () => {
    const storage = new MemoryStorage();
    await storage.put(CHAT_KEY, { chatId: CHAT, at: 1_000 - NEW_TOPIC_AFTER_MS });
    await accept(storage, message("mh_t", "Make me a poster for a picnic on sunday"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_t" }]);
  });

  it("a text a newer one overtook is answered in its thread, and the newest plainly", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_a", "first"), 1_000);
    // Quoting other words, so it is not folded into the first (`sameBurst`).
    await accept(storage, message("mh_b", "second", { quoted: "other words" }), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => [c.body.content, c.body.reply_to])).toEqual([
      ["answer to first", { message_handle: "mh_a" }],
      ["answer to second", undefined],
    ]);
  });

  it("inline replies sent back to back to the same message get one answer, in the newest one's thread", async () => {
    const storage = new MemoryStorage();
    const quoted = "Want me to add these to your list?";
    await accept(storage, message("mh_1", "yes", { threaded: true, quoted }), 1_000);
    await accept(storage, message("mh_2", "and the receipts go to Ada", { threaded: true, quoted }), 1_000);
    await accept(storage, message("mh_3", "not me", { threaded: true, quoted }), 1_000);
    const calls: Call[] = [];
    const agent: Record<string, unknown>[] = [];
    await drain(storage, deps(fake(calls, agent, undefined, coverAll)));
    expect(agent.map((a) => a.question)).toEqual(["yes\nand the receipts go to Ada\nnot me"]);
    expect(agent[0]).toMatchObject({ quoted });
    expect(answers(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_3" }]);
    expect([...(await storage.list({ prefix: "pending:" }))]).toEqual([]);
  });

  it("plain texts sent back to back get one answer", async () => {
    const storage = new MemoryStorage();
    await storage.put(CHAT_KEY, { chatId: CHAT, at: 1_000 - NEW_TOPIC_AFTER_MS + 1 });
    await accept(storage, message("mh_p1", "what's on my list"), 1_000);
    await accept(storage, message("mh_p2", "for today"), 1_000);
    const agent: Record<string, unknown>[] = [];
    await drain(storage, deps(fake([], agent, undefined, coverAll)));
    expect(agent.map((a) => a.question)).toEqual(["what's on my list\nfor today"]);
  });

  it("a reply to other words, a plain text after a reply, a tapback or an SMS that decide leaves apart is answered on its own", async () => {
    for (const second of [
      message("mh_b", "this one", { threaded: true, quoted: "other words" }),
      message("mh_b", "this one"),
      message("mh_b", "Loved", { quoted: "the first words", tapback: "love" as Message["tapback"] }),
      message("mh_b", "this one", { threaded: true, quoted: "the first words", sms: true }),
    ]) {
      const storage = new MemoryStorage();
      await accept(storage, message("mh_a", "that one", { threaded: true, quoted: "the first words" }), 1_000);
      await accept(storage, second, 1_000);
      const agent: Record<string, unknown>[] = [];
      await drain(storage, deps(fake([], agent)));
      expect(agent.map((a) => a.question)[0]).toBe("that one");
    }
  });

  it("a thread Sendblue refuses still gets the answer, as a plain text", async () => {
    const calls: Call[] = [];
    await sendSendblueText(fake(calls, [], (body) => (body.reply_to ? 400 : 200)), KEYS, CHAT, "hi", "mh_gone");
    expect(calls.map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_gone" }, undefined]);
    // Any other failure is a failure, retried with the reply, never sent twice now.
    const failed: Call[] = [];
    await expect(sendSendblueText(fake(failed, [], () => 503), KEYS, CHAT, "hi", "mh_x")).rejects.toThrow();
    expect(failed).toHaveLength(1);
  });

  it("the turn is told it was a reply even when the replied-to words could not be read", async () => {
    const agent: Record<string, unknown>[] = [];
    await askAgent(fake([], agent), "https://gw.example", "t", "try again", undefined, undefined, [], "");
    expect(agent[0]).toMatchObject({ question: "try again", replied: true });
    expect(agent[0]).not.toHaveProperty("quoted");
    await askAgent(fake([], agent), "https://gw.example", "t", "try again", undefined, undefined, [], "earlier words");
    expect(agent[1]).toMatchObject({ quoted: "earlier words" });
    expect(agent[1]).not.toHaveProperty("replied");
  });

  it("quotes Tex's own message when Sendblue leaves out `number`", async () => {
    const parent = { content: "Want me to book it?", from_number: LINE, to_number: PHONE, is_outbound: true, group_id: "" };
    const answering = (async () => Response.json({ status: "OK", data: parent })) as unknown as Fetch;
    expect(await repliedToText(answering, KEYS, "mh_0", CHAT)).toBe("Want me to book it?");
    const stranger = (async () => Response.json({ data: { ...parent, to_number: "+15555550111" } })) as unknown as Fetch;
    expect(await repliedToText(stranger, KEYS, "mh_0", CHAT)).toBeNull();
  });

  it("a reply typed inside a thread is about that thread, even when Sendblue names a parent from another", async () => {
    // Seen 2026-10-19: "location central park", typed in the picnic poster's
    // thread, came with the person's last text in the photo thread as parent.
    const messages: Record<string, Record<string, unknown>> = {
      mh_poster: { content: "Make me a poster for a picnic on sunday", from_number: PHONE, to_number: LINE, number: PHONE, group_id: "" },
      mh_swap: { content: "Tell me the real time and place", from_number: LINE, to_number: PHONE, is_outbound: true, group_id: "", thread_originator: { message_handle: "mh_poster" } },
      mh_retry: { content: "try again", from_number: PHONE, to_number: LINE, number: PHONE, group_id: "", thread_originator: { message_handle: "mh_photo" } },
      mh_bare: { content: "sounds good", from_number: PHONE, to_number: LINE, number: PHONE, group_id: "" },
    };
    const sendblue = (async (url: string) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      return messages[handle] ? Response.json({ data: messages[handle] }) : new Response("{}", { status: 404 });
    }) as unknown as Fetch;
    expect(await threadContext(sendblue, KEYS, "mh_retry", "mh_poster", CHAT)).toEqual({ quoted: "Make me a poster for a picnic on sunday" });
    expect(await threadContext(sendblue, KEYS, "mh_swap", "mh_poster", CHAT)).toEqual({
      quoted: "Tell me the real time and place",
      threadStart: "Make me a poster for a picnic on sunday",
    });
    // A parent that says nothing of its thread is kept, beside the thread's start.
    expect(await threadContext(sendblue, KEYS, "mh_bare", "mh_poster", CHAT)).toEqual({
      quoted: "sounds good",
      threadStart: "Make me a poster for a picnic on sunday",
    });
    expect(await threadContext(sendblue, KEYS, "mh_poster", "mh_poster", CHAT)).toEqual({ quoted: "Make me a poster for a picnic on sunday" });
    expect(await threadContext(sendblue, KEYS, "mh_swap", undefined, CHAT)).toEqual({ quoted: "Tell me the real time and place" });
    expect(await threadContext(sendblue, KEYS, "mh_gone", "mh_poster", CHAT)).toEqual({ quoted: "Make me a poster for a picnic on sunday" });
    expect(await threadContext(sendblue, KEYS, "mh_gone", "mh_lost", CHAT)).toEqual({});
  });

  it("carries the thread an inline reply was typed in, and sends its start to the turn", async () => {
    const inbound = {
      content: "location central park",
      is_outbound: false,
      message_handle: "mh_loc",
      from_number: PHONE,
      number: PHONE,
      to_number: LINE,
      sendblue_number: LINE,
      service: "iMessage",
      group_id: "",
      reply_to: { message_handle: "mh_retry", part_index: 0 },
      thread_originator: { message_handle: "mh_poster" },
    };
    expect(parseSendblueInbound(inbound)).toMatchObject({ replyTo: "mh_retry", threadRoot: "mh_poster" });
    expect(parseSendblueInbound({ ...inbound, reply_to: undefined })).not.toHaveProperty("threadRoot");
    const agent: Record<string, unknown>[] = [];
    await askAgent(fake([], agent), "https://gw.example", "t", "location central park", undefined, undefined, [], "swap them in", "Make me a poster");
    expect(agent[0]).toMatchObject({ quoted: "swap them in", threadStart: "Make me a poster" });
    await askAgent(fake([], agent), "https://gw.example", "t", "hi", undefined, undefined, [], "", "Make me a poster");
    expect(agent[1]).not.toHaveProperty("threadStart");
  });

  it("a long turn sends no fixed 'on it' text while it works", async () => {
    // Dev, 2026-10-19, of "On it. This one takes a few steps, so I'll text you
    // when it's done.": "I don't want to see it ever again".
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      await accept(storage, message("mh_long", "plan my week"), 1_000);
      const calls: Call[] = [];
      let finish = () => {};
      const slow = (async (url: string, init: RequestInit) => {
        if (new URL(url).pathname === "/agent") await new Promise<void>((done) => (finish = done));
        return fake(calls)(url, init);
      }) as unknown as Fetch;
      const draining = drain(storage, deps(slow));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(calls.filter((c) => c.path === "/api/send-message")).toEqual([]);
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      await draining;
      const words = calls.filter((c) => c.path === "/api/send-message" && typeof c.body.content === "string");
      expect(words.map((c) => c.body.content)).toEqual(["answer to plan my week"]);
    } finally {
      vi.useRealTimers();
    }
    // Five fake minutes of typing bubbles run every timer in between: seconds of
    // wall time on a busy runner (it overran 5 s on main's staging run, 2026-10-29).
  }, 30_000);

  it("reads a Spanish tapback as a reaction, never a text", () => {
    const base = {
      content: "Le gustó “Want me to put Friday on your calendar?”",
      is_outbound: false,
      message_handle: "mh_t",
      from_number: PHONE,
      number: PHONE,
      to_number: LINE,
      sendblue_number: LINE,
      service: "iMessage",
      group_id: "",
    };
    expect(parseSendblueInbound(base)).toMatchObject({ kind: "reaction", reaction: { how: "Liked", words: "Want me to put Friday on your calendar?" } });
    expect(parseSendblueInbound({ ...base, content: "Le encantó “x”" })).toMatchObject({ kind: "reaction", reaction: { how: "Loved", words: "x" } });
    expect(parseSendblueInbound({ ...base, content: "Le gustó la película" })).toMatchObject({ kind: "message" });
  });
});
