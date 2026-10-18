import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { checkReady, oweReadyText, READY_COPY, READY_FIRST_MS } from "./ready";
import { textRoutine } from "./routines";
import {
  parseSendblueChat,
  parseSendblueInbound,
  sendblueChatId,
  sendblueKeys,
  sendSendblueText,
  verifySendblueSecret,
} from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };

const received = (over: Record<string, unknown> = {}) => ({
  accountEmail: "ops@example.com",
  content: "hello",
  is_outbound: false,
  status: "RECEIVED",
  message_handle: "mh_1",
  from_number: PHONE,
  number: PHONE,
  to_number: LINE,
  sendblue_number: LINE,
  media_url: "",
  message_type: "message",
  group_id: "",
  participants: [],
  service: "iMessage",
  ...over,
});

describe("sendblue chat ids", () => {
  it("round-trips a line and a phone, and refuses anything else", () => {
    expect(parseSendblueChat(sendblueChatId(LINE, PHONE))).toEqual({ line: LINE, phone: PHONE });
    expect(parseSendblueChat("chat_1")).toBeNull();
    expect(parseSendblueChat(`sendblue:${LINE}`)).toBeNull();
    expect(parseSendblueChat(`sendblue:${LINE}:${PHONE}:extra`)).toBeNull();
    expect(parseSendblueChat(`sendblue:${LINE}:someone@example.com`)).toBeNull();
  });

  it("needs both keys", () => {
    expect(sendblueKeys("a", "b")).toEqual({ keyId: "a", secret: "b" });
    expect(sendblueKeys("a", " ")).toBeNull();
    expect(sendblueKeys(undefined, "b")).toBeNull();
  });
});

describe("sendblue webhook", () => {
  it("takes an inbound iMessage in a direct chat", () => {
    expect(parseSendblueInbound(received())).toEqual({
      kind: "message",
      eventId: "sendblue:mh_1",
      chatId: `sendblue:${LINE}:${PHONE}`,
      from: PHONE,
      messageId: "mh_1",
      text: "hello",
    });
  });

  it("drops what Tex must not answer: SMS, groups, email senders, its own sends, nothing at all", () => {
    expect(parseSendblueInbound(received({ service: "SMS" }))).toEqual({ kind: "ignored", reason: "service" });
    expect(parseSendblueInbound(received({ service: undefined }))).toEqual({ kind: "ignored", reason: "service" });
    expect(parseSendblueInbound(received({ group_id: "g1" }))).toEqual({ kind: "ignored", reason: "group" });
    expect(parseSendblueInbound(received({ message_type: "group" }))).toEqual({ kind: "ignored", reason: "group" });
    expect(parseSendblueInbound(received({ from_number: "a@example.com" }))).toEqual({ kind: "ignored", reason: "sender" });
    expect(parseSendblueInbound(received({ is_outbound: true }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parseSendblueInbound(received({ content: "  " }))).toEqual({ kind: "ignored", reason: "empty" });
    expect(parseSendblueInbound(received({ message_handle: "" }))).toEqual({ kind: "invalid" });
    expect(parseSendblueInbound(received({ sendblue_number: null, to_number: "x" }))).toEqual({ kind: "invalid" });
    expect(parseSendblueInbound("nope")).toEqual({ kind: "invalid" });
  });

  it("keeps a picture's address and name, and only an https one", () => {
    const parsed = parseSendblueInbound(received({ content: "", media_url: "https://cdn.example/f/IMG_1.heic" }));
    expect(parsed).toMatchObject({ kind: "message", attachments: [{ url: "https://cdn.example/f/IMG_1.heic", filename: "IMG_1.heic", mimeType: "" }] });
    expect(parseSendblueInbound(received({ content: "", media_url: "http://cdn.example/a.jpg" }))).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("checks the secret, and refuses everything when ours is missing or short", async () => {
    const secret = "0123456789abcdef0123";
    const headers = (value?: string) => new Headers(value === undefined ? {} : { "sb-signing-secret": value });
    expect(await verifySendblueSecret(secret, headers(secret))).toBe(true);
    expect(await verifySendblueSecret(secret, headers(`${secret}x`))).toBe(false);
    expect(await verifySendblueSecret(secret, headers())).toBe(false);
    expect(await verifySendblueSecret("", headers(""))).toBe(false);
    expect(await verifySendblueSecret("short", headers("short"))).toBe(false);
  });
});

type Call = { path: string; headers: Headers; body: Record<string, unknown> };

function fakeSendblue(calls: Call[], status: (path: string, n: number) => number = () => 200): Fetch {
  let n = 0;
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const body = JSON.parse(String(init.body));
    if (parsed.host === "api.sendblue.co") {
      calls.push({ path: parsed.pathname, headers: new Headers(init.headers), body });
      return new Response('{"status":"QUEUED"}', { status: status(parsed.pathname, ++n) });
    }
    if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (parsed.pathname === "/agent") {
      return Response.json({
        answer: `answer to ${body.question}`,
        pictures: [{ name: "p.png", mediaType: "image/png", data: btoa("png-bytes") }],
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
}

describe("sendblue sending", () => {
  it("sends from the line the person texted, with both keys", async () => {
    const calls: Call[] = [];
    await sendSendblueText(fakeSendblue(calls), KEYS, sendblueChatId(LINE, PHONE), "hi");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/send-message");
    expect(calls[0].body).toEqual({ number: PHONE, from_number: LINE, content: "hi" });
    expect(calls[0].headers.get("sb-api-key-id")).toBe("kid");
    expect(calls[0].headers.get("sb-api-secret-key")).toBe("ksecret");
  });

  it("refuses to send to a chat that is not Sendblue's", async () => {
    await expect(sendSendblueText(fakeSendblue([]), KEYS, "chat_1", "hi")).rejects.toThrow();
  });

  const message = (eventId: string): Message => ({
    kind: "message",
    eventId,
    chatId: sendblueChatId(LINE, PHONE),
    from: PHONE,
    messageId: eventId,
    text: "q",
  });

  function deps(fetcher: Fetch, hosted: string[]): InboxDeps {
    return {
      fetch: fetcher,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "linq-key",
      sendblue: KEYS,
      hostPicture: async (picture) => {
        hosted.push(picture.name);
        return "https://agent.example/media/abc/def.png";
      },
      now: () => 1_000,
    };
  }

  it("answers a Sendblue chat through Sendblue: read, typing, words, then the picture by address", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_1"), 1_000);
    const calls: Call[] = [];
    const hosted: string[] = [];
    await drain(storage, deps(fakeSendblue(calls), hosted));
    expect(calls.map((c) => c.path)).toEqual([
      "/api/mark-read",
      "/api/send-typing-indicator",
      "/api/send-message",
      "/api/send-message",
    ]);
    expect(calls[2].body).toEqual({ number: PHONE, from_number: LINE, content: "answer to q" });
    expect(calls[3].body).toEqual({ number: PHONE, from_number: LINE, media_url: "https://agent.example/media/abc/def.png" });
    expect(hosted).toEqual(["p.png"]);
    // No Linq contact card on a Sendblue chat.
    expect(calls.some((c) => c.path.includes("contact"))).toBe(false);
  });

  it("never sends the same text twice when a later part fails and is retried", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_2"), 1_000);
    const calls: Call[] = [];
    // The picture fails once with a 503; the words already went.
    let pictureTries = 0;
    const flaky = fakeSendblue(calls, (path) => (path === "/api/send-message" && calls.at(-1)?.body.media_url && ++pictureTries === 1 ? 503 : 200));
    await drain(storage, deps(flaky, []));
    await drain(storage, deps(flaky, []));
    const sends = calls.filter((c) => c.path === "/api/send-message");
    expect(sends.map((c) => c.body.content ?? c.body.media_url)).toEqual([
      "answer to q",
      "https://agent.example/media/abc/def.png",
      "https://agent.example/media/abc/def.png",
    ]);
  });

  it("texts a routine on the Sendblue line the person last texted from", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_3"), 1_000);
    const calls: Call[] = [];
    const status = await textRoutine(storage, { text: "morning", idempotencyKey: "r1" }, {
      fetch: fakeSendblue(calls),
      linqApiKey: "linq-key",
      sendblue: KEYS,
      now: () => 1_000,
      simulator: false,
    });
    expect(status).toBe("texted");
    expect(calls.map((c) => c.body)).toEqual([{ number: PHONE, from_number: LINE, content: "morning" }]);
  });

  it("fails a Sendblue chat's send when the keys are not set, rather than trying Linq", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_4"), 1_000);
    const status = await textRoutine(storage, { text: "morning", idempotencyKey: "r1" }, {
      fetch: (async () => {
        throw new Error("no request should be made");
      }) as unknown as Fetch,
      linqApiKey: "linq-key",
      sendblue: null,
      now: () => 1_000,
      simulator: false,
    });
    expect(status).toBe("failed");
  });

  it("texts the ready text on the Sendblue line, and a retry never repeats the first text", async () => {
    const storage = new MemoryStorage();
    await oweReadyText(storage, { phone: PHONE, chatId: sendblueChatId(LINE, PHONE) }, 1_000);
    const sent: unknown[] = [];
    let tries = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/agent-texts/ready") return Response.json({ status: "ready", url: "https://app.example/s/abc" });
      const body = JSON.parse(String(init.body));
      // The link fails the first time it is sent.
      if (body.content === "https://app.example/s/abc" && ++tries === 1) return new Response(null, { status: 503 });
      sent.push(body);
      return new Response("{}", { status: 200 });
    }) as unknown as Fetch;
    const readyDeps = (now: number) => ({
      fetch: fetcher,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      linqApiKey: "linq-key",
      sendblue: KEYS,
      now: () => now,
    });
    await checkReady(storage, readyDeps(1_000 + READY_FIRST_MS));
    await checkReady(storage, readyDeps(1_000 + READY_FIRST_MS + 60_000));
    expect(sent).toEqual([
      { number: PHONE, from_number: LINE, content: READY_COPY.ready },
      { number: PHONE, from_number: LINE, content: "https://app.example/s/abc" },
    ]);
  });
});
