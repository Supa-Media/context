/**
 * Tex answers inside an iMessage thread (docs.sendblue.com, iMessage inline
 * replies): every answer goes in the thread of the text it answers, inline
 * reply or not, so each answer reads next to what it answers.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `threadFor` returning undefined → "an inline reply is answered inside its
 *     thread" and "a plain text is answered inside its thread too" fail.
 *  2. `sendMessage` throwing on a refused threaded send instead of sending it
 *     plain → "a thread Sendblue refuses still gets the answer" fails.
 *  3. `index.ts` not setting `threaded` → "an inline reply is queued as one"
 *     fails (worker.test.ts).
 */

import { describe, expect, it } from "vitest";
import { askAgent, type Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { parseSendblueInbound, repliedToText, sendblueChatId, sendSendblueText } from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };
const CHAT = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

/** Sendblue and the gateway, answering each question with words only. */
function fake(calls: Call[], agent: Record<string, unknown>[] = [], status: (body: Record<string, unknown>) => number = () => 200): Fetch {
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

  it("a plain text is answered inside its thread too", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_p", "Make me a poster for a picnic on sunday"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_p" }]);
  });

  it("each of several texts is answered under its own message", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_a", "first"), 1_000);
    await accept(storage, message("mh_b", "second"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(answers(calls).map((c) => [c.body.content, c.body.reply_to])).toEqual([
      ["answer to first", { message_handle: "mh_a" }],
      ["answer to second", { message_handle: "mh_b" }],
    ]);
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

  it("never answers a Spanish tapback", () => {
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
    expect(parseSendblueInbound(base)).toEqual({ kind: "ignored", reason: "reaction" });
    expect(parseSendblueInbound({ ...base, content: "Le encantó “x”" })).toEqual({ kind: "ignored", reason: "reaction" });
    expect(parseSendblueInbound({ ...base, content: "Le gustó la película" })).toMatchObject({ kind: "message" });
  });
});
