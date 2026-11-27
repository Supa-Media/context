import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, CHAT_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { lineOfChat, noticeEveryone, noticeToldKey, parseNoticeRequest, tellNotice, type NoticeRequest } from "./notice";
import type { Message } from "./reply";

const PHONE = "+15555550100";
const SECRET = "a-worker-secret-long-enough";
const ASK: NoticeRequest = { text: "A staff note.", key: "test-note", lines: ["linq"], dryRun: false };

const msg = (over: Partial<Message> = {}): Message => ({ kind: "message", eventId: "e1", chatId: "chat_1", from: PHONE, messageId: "m1", text: "hi", ...over });

type Sent = { url: string; text: string; key: string };
function linq(sent: Sent[], status = 200): Fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (status < 300) sent.push({ url, text: body.message.parts[0].value, key: body.message.idempotency_key });
    return new Response("{}", { status });
  }) as unknown as Fetch;
}
const deps = (sent: Sent[], status = 200) => ({ fetch: linq(sent, status), linqApiKey: "k", now: () => 5_000 });

describe("the notice request", () => {
  it("is a dry run unless send is exactly true", () => {
    const base = { text: " hi ", key: "k1", lines: ["photon"] };
    expect(parseNoticeRequest(base)).toEqual({ text: "hi", key: "k1", lines: ["photon"], dryRun: true });
    expect(parseNoticeRequest({ ...base, send: "true" })?.dryRun).toBe(true);
    expect(parseNoticeRequest({ ...base, send: true })?.dryRun).toBe(false);
  });

  it("refuses no words, too many, a bad key, and an unknown or empty line list", () => {
    expect(parseNoticeRequest({ text: "", key: "k", lines: ["photon"] })).toBeNull();
    expect(parseNoticeRequest({ text: "x".repeat(1_001), key: "k", lines: ["photon"] })).toBeNull();
    expect(parseNoticeRequest({ text: "hi", key: "Bad Key", lines: ["photon"] })).toBeNull();
    expect(parseNoticeRequest({ text: "hi", key: "k", lines: [] })).toBeNull();
    expect(parseNoticeRequest({ text: "hi", key: "k", lines: ["group"] })).toBeNull();
    expect(parseNoticeRequest(null)).toBeNull();
  });

  it("names each 1:1 chat's line", () => {
    expect(lineOfChat("chat_1")).toBe("linq");
    expect(lineOfChat(`sendblue:+18133350746:${PHONE}`)).toBe("sendblue");
  });
});

describe("telling one phone", () => {
  it("texts the 1:1 chat that phone started, once per key, recorded as a notice", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    expect(await tellNotice(storage, ASK, deps(sent))).toEqual({ told: "told", line: "linq" });
    expect(sent).toEqual([{ url: expect.stringContaining("/chats/chat_1/messages"), text: ASK.text, key: "notice:test-note:chat_1" }]);
    expect(await tellNotice(storage, ASK, deps(sent))).toEqual({ told: "already", line: "linq" });
    expect(sent).toHaveLength(1);
    expect(await tellNotice(storage, { ...ASK, key: "another" }, deps(sent))).toEqual({ told: "told", line: "linq" });
    expect(sent).toHaveLength(2);
  });

  it("texts nobody on a dry run, and leaves no mark", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    expect(await tellNotice(storage, { ...ASK, dryRun: true }, deps(sent))).toEqual({ told: "would", line: "linq" });
    expect(sent).toEqual([]);
    expect(storage.data.has(noticeToldKey(ASK.key))).toBe(false);
  });

  it("never texts a phone with no chat, a simulated chat, or a chat on a line not asked for", async () => {
    const sent: Sent[] = [];
    expect(await tellNotice(new MemoryStorage(), ASK, deps(sent))).toEqual({ told: "no_chat" });
    const simulated = new MemoryStorage();
    await simulated.put(CHAT_KEY, { chatId: "sim", channel: "simulator", at: 1 });
    expect(await tellNotice(simulated, ASK, deps(sent))).toEqual({ told: "no_chat" });
    const other = new MemoryStorage();
    await accept(other, msg(), 1_000);
    expect(await tellNotice(other, { ...ASK, lines: ["photon"] }, deps(sent))).toEqual({ told: "other_line", line: "linq" });
    expect(sent).toEqual([]);
  });

  it("is failed, with no mark, when the line refuses", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    expect((await tellNotice(storage, ASK, deps([], 500))).told).toBe("failed");
    expect(storage.data.has(noticeToldKey(ASK.key))).toBe(false);
  });
});

describe("telling everyone", () => {
  it("asks the control plane with the worker's secret, tells each valid phone once, and counts by line", async () => {
    const asked: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ phones: [PHONE, PHONE, "+15555550101", "nope", 7, "+15555550102"] });
    }) as unknown as Fetch;
    const told: string[] = [];
    const counts = await noticeEveryone(
      {
        fetch: fetcher,
        controlPlaneOrigin: "https://cp.example",
        workerSecret: SECRET,
        tellPhone: async (phone, body) => {
          told.push(phone);
          expect(body).toEqual(ASK);
          if (phone === "+15555550102") throw new Error("boom");
          return phone === PHONE ? { told: "told", line: "linq" } : { told: "other_line", line: "photon" };
        },
      },
      ASK,
    );
    expect(asked).toEqual([{ url: "https://cp.example/agent-texts/phones", auth: `Bearer ${SECRET}` }]);
    expect(told.sort()).toEqual([PHONE, "+15555550101", "+15555550102"]);
    expect(counts).toEqual({ phones: 3, told: 1, would: 0, already: 0, other_line: 1, no_chat: 0, failed: 1, byLine: { photon: 1, sendblue: 0, whapi: 0, linq: 1 } });
  });

  it("throws when the control plane does not answer with phones", async () => {
    const fetcher = (async () => new Response("nope", { status: 401 })) as unknown as Fetch;
    await expect(noticeEveryone({ fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: SECRET, tellPhone: async () => ({ told: "told" }) }, ASK)).rejects.toThrow();
  });
});
