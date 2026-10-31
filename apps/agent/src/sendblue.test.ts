import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { accept, CARD_KEY, cardOfferedKey, cardSentKey, CHAT_KEY, drain, NEW_LINE_TEXT, type InboxDeps } from "./inbox";
import { afterRepliesSettled } from "./afterReply";
import { CARD_VERSION } from "./card";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { checkReady, oweReadyText, READY_COPY, READY_FIRST_MS } from "./ready";
import { textRoutine } from "./routines";
import {
  MAX_QUOTED_TEXT,
  PROFILE_PHOTO_URL,
  parseSendblueChat,
  parseSendblueInbound,
  repliedToText,
  shareSendblueProfile,
  sendblueChatId,
  sendblueKeys,
  sendSendblueText,
  verifySendblueSecret,
  markSendblueRead,
  startSendblueTyping,
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

  it("takes an SMS only as an SMS: no file, no inline reply, flagged so its words decide nothing", () => {
    const sms = { service: "SMS", media_url: "https://cdn.example/f/IMG_1.heic", reply_to: { message_handle: "mh_0" } };
    expect(parseSendblueInbound(received(sms))).toEqual({
      kind: "message",
      eventId: "sendblue:mh_1",
      chatId: `sendblue:${LINE}:${PHONE}`,
      from: PHONE,
      messageId: "mh_1",
      text: "hello",
      sms: true,
    });
    // A picture alone is still answered, never fetched.
    expect(parseSendblueInbound(received({ ...sms, content: "" }))).toMatchObject({ kind: "message", text: "", sms: true });
    expect(parseSendblueInbound(received({ ...sms, content: "" }))).not.toHaveProperty("attachments");
    expect(parseSendblueInbound(received({ service: "SMS", group_id: "g1" }))).toEqual({ kind: "ignored", reason: "group" });
    expect(parseSendblueInbound(received({ service: "SMS", content: " " }))).toEqual({ kind: "ignored", reason: "empty" });
    expect(parseSendblueInbound(received({ service: "SMS", content: "Loved “hi”" }))).toEqual({ kind: "ignored", reason: "reaction" });
    expect(parseSendblueInbound(received({ service: "SMS", sendblue_number: null, to_number: "x" }))).toEqual({ kind: "invalid" });
    // An iMessage is never flagged.
    expect(parseSendblueInbound(received())).not.toHaveProperty("sms");
  });

  it("drops what Tex must not answer: other services, groups, email senders, its own sends, nothing at all", () => {
    expect(parseSendblueInbound(received({ service: "RCS" }))).toEqual({ kind: "ignored", reason: "service" });
    expect(parseSendblueInbound(received({ service: "sms" }))).toEqual({ kind: "ignored", reason: "service" });
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

  it("reads a tapback that arrives as words as a reaction, never a text", () => {
    for (const [content, how, words] of [
      ["Loved “see you at 6”", "Loved", "see you at 6"],
      ["Laughed at “ha”", "Laughed at", "ha"],
      ['Emphasized "ok"', "Emphasized", "ok"],
      ["Reacted 🎉 to “done”", "Reacted", "done"],
    ]) {
      expect(parseSendblueInbound(received({ content }))).toMatchObject({ kind: "reaction", reaction: { how, words } });
    }
    // A taken-back heart reaches the inbox, which drops it only if it was being held as a yes (`thumbs.ts`).
    expect(parseSendblueInbound(received({ content: "Removed a heart from “x”" }))).toMatchObject({ kind: "reaction", reaction: { removed: true } });
    expect(parseSendblueInbound(received({ content: "Loved the movie" }))).toMatchObject({ kind: "message" });
    expect(parseSendblueInbound(received({ content: "Liked “x” but why?" }))).toMatchObject({ kind: "message" });
  });

  it("keeps the handle an inline reply answers, and nothing odd", () => {
    expect(parseSendblueInbound(received({ reply_to: { message_handle: "mh_0" } }))).toMatchObject({ kind: "message", replyTo: "mh_0" });
    expect(parseSendblueInbound(received({ reply_to: { message_handle: "" } }))).not.toHaveProperty("replyTo");
    expect(parseSendblueInbound(received({ reply_to: "mh_0" }))).not.toHaveProperty("replyTo");
    expect(parseSendblueInbound(received({ reply_to: { message_handle: "x".repeat(201) } }))).not.toHaveProperty("replyTo");
  });

  it("keeps a picture's address and name, and only an https one", () => {
    const parsed = parseSendblueInbound(received({ content: "", media_url: "https://cdn.example/f/IMG_1.heic" }));
    expect(parsed).toMatchObject({ kind: "message", attachments: [{ url: "https://cdn.example/f/IMG_1.heic", filename: "IMG_1.heic", mimeType: "" }] });
    expect(parseSendblueInbound(received({ content: "", media_url: "http://cdn.example/a.jpg" }))).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("drops a link's preview card: a .pluginPayloadAttachment, or a file that came with an address in the words", () => {
    // Owner's report, 2026-10-21: a pasted context.lc link's card reached Tex as "just a hashtag icon".
    expect(parseSendblueInbound(received({ content: "https://context.lc/note/@seyi/a.md", media_url: "https://cdn.example/f/preview.png" }))).toEqual({
      kind: "message",
      eventId: "sendblue:mh_1",
      chatId: sendblueChatId(LINE, PHONE),
      from: PHONE,
      messageId: "mh_1",
      text: "https://context.lc/note/@seyi/a.md",
    });
    expect(parseSendblueInbound(received({ content: "", media_url: "https://cdn.example/f/ABC.pluginPayloadAttachment" }))).toEqual({ kind: "ignored", reason: "empty" });
    // A photo with no address in the words is still a photo.
    expect(parseSendblueInbound(received({ content: "this one", media_url: "https://cdn.example/f/IMG_2.png" }))).toMatchObject({ attachments: [{ filename: "IMG_2.png" }] });
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

function fakeSendblue(calls: Call[], status: (path: string, n: number) => number = () => 200, pictures = 1): Fetch {
  let n = 0;
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    if (parsed.host === "api.sendblue.com") {
      calls.push({ path: parsed.pathname, headers: new Headers(init.headers), body });
      if (parsed.pathname === "/api/v2/contact-sharing/state") {
        return Response.json({ status: "OK", data: { hasProfile: true, publishRecordPresent: true } }, { status: status(parsed.pathname, ++n) });
      }
      return new Response('{"status":"QUEUED"}', { status: status(parsed.pathname, ++n) });
    }
    if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (parsed.pathname === "/agent") {
      return Response.json({
        answer: `answer to ${body.question}${body.quoted ? ` [quoting ${body.quoted}]` : ""}`,
        pictures: Array.from({ length: pictures }, (_, i) => ({ name: pictures === 1 ? "p.png" : `p${i + 1}.png`, mediaType: "image/png", data: btoa(`png-bytes-${i}`) })),
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
}

describe("sendblue replied-to words", () => {
  const chatId = sendblueChatId(LINE, PHONE);
  const answering = (parent: unknown, status = 200): Fetch =>
    (async () => new Response(JSON.stringify(parent), { status })) as unknown as Fetch;
  const tex = { content: "Want me to book it?", number: PHONE, from_number: LINE, is_outbound: true, group_id: "" };

  it("quotes a message in this person's own chat, Tex's or theirs", async () => {
    expect(await repliedToText(answering({ status: "OK", data: tex }), KEYS, "mh_0", chatId)).toBe("Want me to book it?");
    const theirs = { content: "  my flight is at 6  ", number: PHONE, from_number: PHONE, to_number: LINE, is_outbound: false };
    expect(await repliedToText(answering(theirs), KEYS, "mh_0", chatId)).toBe("my flight is at 6");
    const long = { ...tex, content: "a".repeat(MAX_QUOTED_TEXT + 50) };
    expect(await repliedToText(answering(long), KEYS, "mh_0", chatId)).toHaveLength(MAX_QUOTED_TEXT);
  });

  it("never quotes another person's message, a group's, another line's, or a failed read", async () => {
    expect(await repliedToText(answering({ data: { ...tex, number: "+15555550111" } }), KEYS, "mh_0", chatId)).toBeNull();
    expect(await repliedToText(answering({ data: { ...tex, group_id: "g1" } }), KEYS, "mh_0", chatId)).toBeNull();
    expect(await repliedToText(answering({ data: { ...tex, from_number: "+15555550177", sendblue_number: null } }), KEYS, "mh_0", chatId)).toBeNull();
    expect(await repliedToText(answering({ data: tex }, 404), KEYS, "mh_0", chatId)).toBeNull();
    expect(await repliedToText(answering({ data: { ...tex, content: "" } }), KEYS, "mh_0", chatId)).toBeNull();
    expect(await repliedToText(answering({ data: tex }), KEYS, "mh_0", "chat_1")).toBeNull();
    const throwing = (async () => {
      throw new Error("down");
    }) as unknown as Fetch;
    expect(await repliedToText(throwing, KEYS, "mh_0", chatId)).toBeNull();
  });
});

describe("sendblue Name & Photo", () => {
  const chatId = sendblueChatId(LINE, PHONE);
  function profileApi(state: Record<string, unknown> | null, calls: Call[]): Fetch {
    return (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      calls.push({ path: `${parsed.pathname}${parsed.search}`, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : {} });
      if (parsed.pathname === "/api/v2/contact-sharing/state") {
        return state === null ? new Response(null, { status: 503 }) : Response.json({ status: "OK", data: state });
      }
      return Response.json({ status: "OK" });
    }) as unknown as Fetch;
  }

  it("sets Tex's name and photo on a line that has none, and shares nothing yet", async () => {
    const calls: Call[] = [];
    expect(await shareSendblueProfile(profileApi({ hasProfile: false, sharingEnabled: false }, calls), KEYS, chatId)).toBe("not_yet");
    expect(calls.map((c) => c.path)).toEqual([`/api/v2/contact-sharing/state?fromNumber=${encodeURIComponent(LINE)}`, "/api/v2/contact-sharing/profile"]);
    expect(calls[1].body).toEqual({ fromNumber: LINE, firstName: "Tex", lastName: "", photoUrl: PROFILE_PHOTO_URL });
  });

  it("leaves a profile still being applied alone", async () => {
    const calls: Call[] = [];
    expect(await shareSendblueProfile(profileApi({ hasProfile: true, publishRecordPresent: false }, calls), KEYS, chatId)).toBe("not_yet");
    expect(calls).toHaveLength(1);
  });

  it("shares a published profile into the chat", async () => {
    const calls: Call[] = [];
    expect(await shareSendblueProfile(profileApi({ hasProfile: true, publishRecordPresent: true }, calls), KEYS, chatId)).toBe("shared");
    expect(calls[1]).toMatchObject({ path: "/api/v2/contact-sharing/share", body: { fromNumber: LINE, toNumber: PHONE } });
  });

  it("does nothing when the state cannot be read, or the chat is not Sendblue's", async () => {
    const calls: Call[] = [];
    expect(await shareSendblueProfile(profileApi(null, calls), KEYS, chatId)).toBe("not_yet");
    expect(calls).toHaveLength(1);
    expect(await shareSendblueProfile(profileApi({ publishRecordPresent: true }, calls), KEYS, "chat_1")).toBe("not_yet");
    expect(calls).toHaveLength(1);
  });

  it("sets the profile again, new photo and all, when asked to refresh, and shares nothing yet", async () => {
    const calls: Call[] = [];
    expect(await shareSendblueProfile(profileApi({ hasProfile: true, publishRecordPresent: true }, calls), KEYS, chatId, true)).toBe("refreshed");
    expect(calls.map((c) => c.path)).toEqual(["/api/v2/contact-sharing/profile"]);
    expect(calls[0].body).toEqual({ fromNumber: LINE, firstName: "Tex", lastName: "", photoUrl: PROFILE_PHOTO_URL });
    expect(PROFILE_PHOTO_URL).toBe(`https://context.lc/texts-card.png?v=${CARD_VERSION}`);
  });
});

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
        return picture.mediaType === "text/vcard"
          ? "https://agent.example/media/abc/card.vcf"
          : "https://agent.example/media/abc/def.png";
      },
      now: () => 1_000,
    };
  }

  it("answers a Sendblue chat through Sendblue: read, typing, words, the picture by address, then Tex's card", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_1"), 1_000);
    const calls: Call[] = [];
    const hosted: string[] = [];
    await drain(storage, deps(fakeSendblue(calls), hosted));
    await afterRepliesSettled(storage);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/mark-read",
      "/api/send-typing-indicator",
      "/api/send-message",
      "/api/send-message",
      "/api/send-message",
      "/api/v2/contact-sharing/state",
      "/api/v2/contact-sharing/share",
    ]);
    expect(calls[6].body).toEqual({ fromNumber: LINE, toNumber: PHONE });
    // The chat's first text starts a topic, so its answer opens a thread under it (`threadFor`).
    expect(calls[2].body).toEqual({ number: PHONE, from_number: LINE, content: "answer to q", reply_to: { message_handle: "sendblue:mh_1" } });
    expect(calls[3].body).toEqual({
      number: PHONE,
      from_number: LINE,
      media_url: "https://agent.example/media/abc/def.png",
      reply_to: { message_handle: "sendblue:mh_1" },
    });
    expect(calls[4].body).toEqual({ number: PHONE, from_number: LINE, media_url: "https://agent.example/media/abc/card.vcf" });
    expect(hosted).toEqual(["p.png", "Tex.vcf"]);
  });

  it("sends the card once per chat, even days later, but tries again after one that failed", async () => {
    const day = 24 * 60 * 60 * 1000;
    const storage = new MemoryStorage();
    const calls: Call[] = [];
    const cards = () => calls.filter((c) => String(c.body.media_url ?? "").endsWith(".vcf")).length;
    // The first card is refused by Sendblue.
    const refusing = fakeSendblue(calls, (path) => (calls.at(-1)?.body.media_url === "https://agent.example/media/abc/card.vcf" && cards() === 1 ? 500 : 200));
    const at = (now: number): InboxDeps => ({ ...deps(refusing, []), now: () => now });
    await accept(storage, message("sendblue:mh_c1"), 1_000);
    await drain(storage, at(1_000));
    await afterRepliesSettled(storage);
    expect(cards()).toBe(1);
    await accept(storage, message("sendblue:mh_c2"), 1_000 + day + 1);
    await drain(storage, at(1_000 + day + 1));
    await afterRepliesSettled(storage);
    expect(cards()).toBe(2);
    await accept(storage, message("sendblue:mh_c3"), 1_000 + 3 * day);
    await drain(storage, at(1_000 + 3 * day));
    await afterRepliesSettled(storage);
    expect(cards()).toBe(2);
  });

  it("keeps sharing the Name & Photo daily until Sendblue takes it, without sending the card again", async () => {
    const day = 24 * 60 * 60 * 1000;
    const storage = new MemoryStorage();
    const calls: Call[] = [];
    let published = false;
    const base = fakeSendblue(calls);
    const fetcher = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/api/v2/contact-sharing/state") {
        calls.push({ path: "/api/v2/contact-sharing/state", headers: new Headers(), body: {} });
        return Response.json({ status: "OK", data: { hasProfile: published, publishRecordPresent: published } });
      }
      return base(url, init);
    }) as unknown as Fetch;
    const at = (now: number): InboxDeps => ({ ...deps(fetcher, []), now: () => now });
    const count = (path: string) => calls.filter((c) => c.path === path).length;
    await accept(storage, message("sendblue:mh_p1"), 1_000);
    await drain(storage, at(1_000));
    await afterRepliesSettled(storage);
    expect(count("/api/v2/contact-sharing/profile")).toBe(1);
    expect(count("/api/v2/contact-sharing/share")).toBe(0);
    published = true;
    await accept(storage, message("sendblue:mh_p2"), 1_000 + day + 1);
    await drain(storage, at(1_000 + day + 1));
    await afterRepliesSettled(storage);
    expect(count("/api/v2/contact-sharing/share")).toBe(1);
    expect(calls.filter((c) => String(c.body.media_url ?? "").endsWith(".vcf"))).toHaveLength(1);
    // Both done: nothing more, ever, in this chat.
    await accept(storage, message("sendblue:mh_p3"), 1_000 + 3 * day);
    await drain(storage, at(1_000 + 3 * day));
    await afterRepliesSettled(storage);
    expect(count("/api/v2/contact-sharing/state")).toBe(2);
  });

  it("never sends a newer card into a chat that had the old one, and sets the new photo before sharing it", async () => {
    const day = 24 * 60 * 60 * 1000;
    const storage = new MemoryStorage();
    const chat = sendblueChatId(LINE, PHONE);
    // What a chat looked like before cards had versions: card sent and offered an hour ago.
    await storage.put(cardSentKey(chat), true);
    await storage.put(cardOfferedKey(chat), 1_000 - 60 * 60 * 1000);
    const calls: Call[] = [];
    const at = (now: number): InboxDeps => ({ ...deps(fakeSendblue(calls), []), now: () => now });
    const cards = () => calls.filter((c) => String(c.body.media_url ?? "").endsWith(".vcf")).length;
    const count = (path: string) => calls.filter((c) => c.path === path).length;
    await accept(storage, message("sendblue:mh_v1"), 1_000);
    await drain(storage, at(1_000));
    await afterRepliesSettled(storage);
    expect(cards()).toBe(0);
    expect(count("/api/v2/contact-sharing/profile")).toBe(1);
    expect(count("/api/v2/contact-sharing/share")).toBe(0);
    // The same day: nothing more.
    await accept(storage, message("sendblue:mh_v2"), 2_000);
    await drain(storage, at(2_000));
    await afterRepliesSettled(storage);
    expect(cards()).toBe(0);
    expect(count("/api/v2/contact-sharing/profile")).toBe(1);
    // The next day: the new photo is shared, without setting it again or resending the card.
    await accept(storage, message("sendblue:mh_v3"), 1_000 + day + 1);
    await drain(storage, at(1_000 + day + 1));
    await afterRepliesSettled(storage);
    expect(count("/api/v2/contact-sharing/share")).toBe(1);
    expect(count("/api/v2/contact-sharing/profile")).toBe(1);
    expect(cards()).toBe(0);
  });

  it("never sets the photo again for someone new to Tex", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_f1"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    expect(calls.filter((c) => c.path === "/api/v2/contact-sharing/profile")).toHaveLength(0);
    expect(calls.filter((c) => c.path === "/api/v2/contact-sharing/share")).toHaveLength(1);
  });

  it("sends two or more pictures as one swipeable carousel, in the answer's thread", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_c1"), 1_000);
    const calls: Call[] = [];
    let hostedN = 0;
    const d = deps(fakeSendblue(calls, () => 200, 3), []);
    await drain(storage, { ...d, hostPicture: async (p) => (p.mediaType === "text/vcard" ? "https://agent.example/media/abc/card.vcf" : `https://agent.example/media/abc/${++hostedN}.png`) });
    await afterRepliesSettled(storage);
    const carousel = calls.filter((c) => c.path === "/api/send-carousel");
    expect(carousel).toHaveLength(1);
    expect(carousel[0].body).toEqual({
      number: PHONE,
      from_number: LINE,
      media_urls: ["https://agent.example/media/abc/1.png", "https://agent.example/media/abc/2.png", "https://agent.example/media/abc/3.png"],
      reply_to: { message_handle: "sendblue:mh_c1" },
    });
    // No picture also went one by one.
    expect(calls.filter((c) => c.path === "/api/send-message" && c.body.media_url !== undefined && !String(c.body.media_url).endsWith(".vcf"))).toHaveLength(0);
  });

  it("sends the pictures one by one when the line has no carousels", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_c2"), 1_000);
    const calls: Call[] = [];
    let hostedN = 0;
    // A V1 line: Sendblue refuses the carousel with a 400, threaded or not.
    const d = deps(fakeSendblue(calls, (path) => (path === "/api/send-carousel" ? 400 : 200), 3), []);
    await drain(storage, { ...d, hostPicture: async (p) => (p.mediaType === "text/vcard" ? "https://agent.example/media/abc/card.vcf" : `https://agent.example/media/abc/${++hostedN}.png`) });
    await afterRepliesSettled(storage);
    const one = calls.filter((c) => c.path === "/api/send-message" && String(c.body.media_url ?? "").endsWith("png"));
    expect(one.map((c) => c.body.media_url)).toEqual(["https://agent.example/media/abc/1.png", "https://agent.example/media/abc/2.png", "https://agent.example/media/abc/3.png"]);
    // Asked once (threaded, then plain), never again for the rest of the answer.
    expect(calls.filter((c) => c.path === "/api/send-carousel")).toHaveLength(2);
    expect(await storage.list({ prefix: "pending:" })).toHaveProperty("size", 0);
  });

  it("sends one picture as a plain photo, never a carousel", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_c3"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    expect(calls.some((c) => c.path === "/api/send-carousel")).toBe(false);
  });

  it("sends the card on the new line even when the old line's card went out today", async () => {
    const storage = new MemoryStorage();
    await storage.put(CARD_KEY, 900);
    await accept(storage, message("sendblue:mh_n1"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    expect(calls.filter((c) => String(c.body.media_url ?? "").endsWith(".vcf"))).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/api/v2/contact-sharing/share")).toHaveLength(1);
  });

  it("says once that this is Tex's new number to someone who texted the old line", async () => {
    const storage = new MemoryStorage();
    await storage.put(CHAT_KEY, { chatId: "chat_linq", at: 500 });
    await accept(storage, message("sendblue:mh_m1"), 1_000);
    // Quoting other words, so the two are answered apart (`sameBurst`).
    await accept(storage, { ...message("sendblue:mh_m2"), quoted: "x" }, 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    const texts = calls.filter((c) => c.path === "/api/send-message" && c.body.content).map((c) => c.body.content);
    expect(texts).toEqual([NEW_LINE_TEXT, "answer to q", "answer to q [quoting x]"]);
  });

  it("never says it to someone coming back from WhatsApp, and says it only once", async () => {
    const back = new MemoryStorage();
    await back.put(CHAT_KEY, { chatId: "whapi:+15555550199:+15555550100", at: 500 });
    await accept(back, message("sendblue:mh_w1"), 1_000);
    const calls: Call[] = [];
    await drain(back, deps(fakeSendblue(calls), []));
    expect(calls.some((c) => c.body.content === NEW_LINE_TEXT)).toBe(false);

    const twice = new MemoryStorage();
    await twice.put(CHAT_KEY, { chatId: "chat_linq", at: 500 });
    await accept(twice, message("sendblue:mh_t1"), 1_000);
    await drain(twice, deps(fakeSendblue([]), []));
    await twice.put(CHAT_KEY, { chatId: "chat_linq", at: 2_000 });
    await accept(twice, message("sendblue:mh_t2"), 3_000);
    const later: Call[] = [];
    await drain(twice, deps(fakeSendblue(later), []));
    expect(later.some((c) => c.body.content === NEW_LINE_TEXT)).toBe(false);
  });

  it("never says it to someone new to Tex, or on the old line", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_f1"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    expect(calls.some((c) => c.body.content === NEW_LINE_TEXT)).toBe(false);
  });

  // The replied-to words reach Tex, but apart from the question: the gateway's guards vouch from
  // the person's own words, and the message picked may be one Tex sent (`apps/mcp/src/agent/quoted.js`).
  it("sends the replied-to words apart from the person's own", async () => {
    const storage = new MemoryStorage();
    await accept(storage, { ...message("sendblue:mh_q"), text: "yes", quoted: "Want me to book it?" }, 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fakeSendblue(calls), []));
    await afterRepliesSettled(storage);
    expect(calls.find((c) => c.path === "/api/send-message")?.body.content).toBe(
      "answer to yes [quoting Want me to book it?]",
    );
  });

  it("never sends the same text twice when a later part fails and is retried", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_2"), 1_000);
    const calls: Call[] = [];
    // The picture fails once with a 503; the words already went.
    let pictureTries = 0;
    const flaky = fakeSendblue(calls, (path) => (path === "/api/send-message" && calls.at(-1)?.body.media_url && ++pictureTries === 1 ? 503 : 200));
    await drain(storage, deps(flaky, []));
    await afterRepliesSettled(storage);
    await drain(storage, deps(flaky, []));
    await afterRepliesSettled(storage);
    const sends = calls.filter((c) => c.path === "/api/send-message");
    expect(sends.map((c) => c.body.content ?? c.body.media_url)).toEqual([
      "answer to q",
      "https://agent.example/media/abc/def.png",
      "https://agent.example/media/abc/def.png",
      // The card, once, after the reply finally went.
      "https://agent.example/media/abc/card.vcf",
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
      { number: PHONE, from_number: LINE, content: READY_COPY.guide },
      { number: PHONE, from_number: LINE, media_url: "https://app.example/og/google-connect.png" },
    ]);
  });
});

describe("sendblue bubble and receipt", () => {
  it("logs a refused typing bubble or read receipt by status, never the number", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    try {
      const refusing = (async () => new Response("{}", { status: 400 })) as unknown as Fetch;
      await startSendblueTyping(refusing, KEYS, sendblueChatId(LINE, PHONE));
      await markSendblueRead(refusing, KEYS, sendblueChatId(LINE, PHONE));
      const fine = (async () => new Response("{}", { status: 200 })) as unknown as Fetch;
      await startSendblueTyping(fine, KEYS, sendblueChatId(LINE, PHONE));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "sendblue_typing", outcome: "refused", status: 400 },
      { event: "sendblue_read", outcome: "refused", status: 400 },
    ]);
    expect(lines.join("")).not.toContain(PHONE);
  });
});
