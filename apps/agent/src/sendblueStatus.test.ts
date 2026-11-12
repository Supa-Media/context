/**
 * Sendblue's status for each send (`sendblueStatus.ts`).
 *
 * Payload shapes: `message_handle`, `status`, `error_code`, `was_downgraded`,
 * `from_number`, `group_id` are named in Sendblue's docs (sending-messages,
 * webhooks). GUESSED: the recipient as `number` (the send response's name;
 * `to_number` is the outbound webhook's), and the FAILED and READ statuses
 * (named by the provider check, not in the docs' list).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-06):
 *  1. `sendCall` not adding `status_callback` -> "every send names the status address".
 *  2. the route not checking the path secret -> "a status at any other path is refused".
 *  3. `noteSendStatus` not marking ERROR -> "a send that never went is marked once".
 * (2026-11-12, plain resend; `threadedResend.ts`)
 *  4. `noteSendStatus` not resending a kept threaded text -> "a threaded text that never went goes again plain, once" fails.
 *  5. `takeThreaded` not removing what it takes -> the same check fails (a second ERROR resends again).
 *  6. `resendPlain` threading its resend -> "the resend is plain, by the chat's own line" fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, keptEvents, renderTranscript } from "./events";
import { noteHandle } from "./replyQuote";
import { sendblueChatId, sendblueKeys, sendSendblueText } from "./sendblue";
import { sendGroupText } from "./sendblueGroups";
import { noteSendStatus, parseSendStatus, resendPlain } from "./sendblueStatus";
import { keepThreaded, KEEP_MS, type Threaded } from "./threadedResend";
import { SENT_KEY } from "./groupSay";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = sendblueChatId(LINE, PHONE);
const STATUS_URL = "https://agent.example/sendblue/status/abcdefghijklmnop1234";
const NOW = Date.UTC(2026, 10, 6, 12);

const callback = (over: Record<string, unknown> = {}) => ({
  message_handle: "mh-1",
  status: "ERROR",
  error_code: 4001,
  was_downgraded: false,
  from_number: LINE,
  number: PHONE,
  content: "secret words",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("every send names the status address", () => {
  it("1:1 and group sends carry status_callback; keys without a valid address carry none", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), Response.json({ message_handle: "mh" }));
    const keys = sendblueKeys("id", "secret", STATUS_URL)!;
    await sendSendblueText(fetcher, keys, CHAT, "hi");
    await sendGroupText(fetcher, keys, { line: LINE, groupId: "g-1" }, "hi");
    expect(bodies.map((body) => body.status_callback)).toEqual([STATUS_URL, STATUS_URL]);
    expect(sendblueKeys("id", "secret", "https://agent.example/sendblue/status/short")).toEqual({ keyId: "id", secret: "secret" });
    expect(sendblueKeys("id", "secret", "http://agent.example/sendblue/status/abcdefghijklmnop1234")).toEqual({ keyId: "id", secret: "secret" });
  });
});

describe("a status is read strictly", () => {
  it("places a 1:1 and a group status, and drops what it cannot place", () => {
    expect(parseSendStatus(callback())).toEqual({ handle: "mh-1", status: "ERROR", errorClass: "4000", downgraded: false, object: { kind: "person", phone: PHONE }, chat: CHAT });
    expect(parseSendStatus(callback({ number: undefined, to_number: PHONE }))?.chat).toBe(CHAT);
    expect(parseSendStatus(callback({ group_id: "g-1", status: "delivered", error_code: null, was_downgraded: true }))).toEqual({ handle: "mh-1", status: "DELIVERED", downgraded: true, object: { kind: "group", groupId: "g-1" }, chat: "g-1" });
    expect(parseSendStatus(callback({ status: "WEIRD" }))?.status).toBe("other");
    expect(parseSendStatus(callback({ message_handle: "" }))).toBeNull();
    expect(parseSendStatus(callback({ number: "not a number" }))).toBeNull();
  });
});

describe("a send that never went is marked once", () => {
  it("adds an undelivered delivery event replying to the send, logs codes only, and shows it to the next turn", async () => {
    const storage = new MemoryStorage();
    const sent = await addEvent(storage, { at: NOW - 1000, chat: CHAT, from: { kind: "tex" }, kind: "text", text: "hello there", delivered: true });
    await noteHandle(storage, "mh-1", sent);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const status = parseSendStatus(callback())!;
    expect(await noteSendStatus(storage, status, NOW)).toBe("marked");
    expect(await noteSendStatus(storage, status, NOW)).toBe("logged");
    const marked = (await keptEvents(storage, CHAT)).filter((event) => event.kind === "delivery");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ from: { kind: "tex" }, delivered: false, reason: "failed", replyTo: sent });
    expect(JSON.parse(logs[0])).toEqual({ event: "sendblue_status", status: "ERROR", error_class: "4000", downgraded: false, ev: sent, outcome: "marked" });
    expect(logs.join("\n")).not.toMatch(/\+1555|secret words|hello there/);
    expect(renderTranscript(await keptEvents(storage, CHAT))).toContain(`did not reach them`);
    vi.restoreAllMocks();
  });

  it("a delivered or unknown send is logged and never marked", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await noteSendStatus(storage, parseSendStatus(callback({ status: "DELIVERED" }))!, NOW)).toBe("unmatched");
    await noteHandle(storage, "mh-1", "0000000000001-000001");
    expect(await noteSendStatus(storage, parseSendStatus(callback({ status: "DELIVERED" }))!, NOW)).toBe("logged");
    expect(await keptEvents(storage, CHAT)).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("a threaded text that never went goes again plain, once (Nov Babies, 2026-11-12)", () => {
  const PLACE = { kind: "group" as const, line: LINE, groupId: "g-1" };
  async function sentThreaded(storage: MemoryStorage, handle = "mh-1", at = NOW - 1000): Promise<string> {
    const ev = await addEvent(storage, { at, chat: "g-1", from: { kind: "tex" }, kind: "text", text: "First name, last name?", delivered: true });
    await noteHandle(storage, handle, ev);
    await keepThreaded(storage, handle, { text: "First name, last name?", place: PLACE, at });
    return ev;
  }
  const failed = (handle = "mh-1") => parseSendStatus(callback({ message_handle: handle, group_id: "g-1", error_code: 5000 }))!;

  it("resends it, marks nothing, and a failure of the resend is marked", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ev = await sentThreaded(storage);
    const resent: Threaded[] = [];
    const resend = async (sent: Threaded) => (resent.push(sent), "mh-plain");
    expect(await noteSendStatus(storage, failed(), NOW, resend)).toBe("resent");
    expect(resent).toEqual([{ h: "mh-1", text: "First name, last name?", place: PLACE, at: NOW - 1000 }]);
    expect((await keptEvents(storage, "g-1")).filter((event) => event.kind === "delivery")).toEqual([]);
    // Redelivered: never resent twice; it is marked.
    expect(await noteSendStatus(storage, failed(), NOW, resend)).toBe("marked");
    expect(resent).toHaveLength(1);
    // The resend's own status finds the same event, and its failure is marked, not resent.
    const storage2 = new MemoryStorage();
    const ev2 = await sentThreaded(storage2);
    await noteSendStatus(storage2, failed(), NOW, resend);
    expect(await noteSendStatus(storage2, failed("mh-plain"), NOW, resend)).toBe("marked");
    expect((await keptEvents(storage2, "g-1")).find((event) => event.kind === "delivery")).toMatchObject({ delivered: false, reason: "failed", replyTo: ev2 });
    expect(ev).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("a resend that fails, a text kept too long ago, a plain send, and a delivered one are never resent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const throwing = async () => {
      throw new Error("refused");
    };
    const storage = new MemoryStorage();
    await sentThreaded(storage);
    expect(await noteSendStatus(storage, failed(), NOW, throwing)).toBe("marked");
    const old = new MemoryStorage();
    await sentThreaded(old, "mh-1", NOW - KEEP_MS - 1);
    const never = vi.fn(async () => "x");
    expect(await noteSendStatus(old, failed(), NOW, never)).toBe("marked");
    const plain = new MemoryStorage();
    await noteHandle(plain, "mh-1", await addEvent(plain, { at: NOW, chat: "g-1", from: { kind: "tex" }, kind: "text", text: "hi", delivered: true }));
    expect(await noteSendStatus(plain, failed(), NOW, never)).toBe("marked");
    const fine = new MemoryStorage();
    await sentThreaded(fine);
    expect(await noteSendStatus(fine, parseSendStatus(callback({ group_id: "g-1", status: "DELIVERED", error_code: null }))!, NOW, never)).toBe("logged");
    expect(never).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("the resend is plain, by the chat's own line, and a reply under it reaches Tex", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), Response.json({ message_handle: `mh-${bodies.length}` }));
    const storage = new MemoryStorage();
    const resend = resendPlain(storage, { fetch: fetcher, linqApiKey: "", sendblue: sendblueKeys("id", "secret")! }, () => NOW);
    expect(await resend({ h: "mh-0", text: "In the group", place: { kind: "group", line: LINE, groupId: "g-1" }, at: NOW })).toBe("mh-1");
    expect(await resend({ h: "mh-x", text: "In the 1:1", place: { kind: "person", chatId: CHAT }, at: NOW })).toBe("mh-2");
    expect(bodies.map((body) => [body.content, body.reply_to])).toEqual([
      ["In the group", undefined],
      ["In the 1:1", undefined],
    ]);
    expect(await storage.get(SENT_KEY)).toEqual(["mh-1"]);
  });
});

describe("the status route", () => {
  function env(): { env: Env; routed: { to: string; body: Record<string, unknown> }[] } {
    const routed: { to: string; body: Record<string, unknown> }[] = [];
    const namespace = {
      idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
      get: (id: { name: string }) => ({
        fetch: async (_url: string, init?: RequestInit) => (routed.push({ to: id.name, body: JSON.parse(String(init?.body ?? "{}")) }), Response.json({ outcome: "logged" })),
      }),
    } as unknown as DurableObjectNamespace;
    return { routed, env: { SENDER_INBOX: namespace, LINQ_WEBHOOK_SECRET: "", LINQ_API_KEY: "k", AGENT_WORKER_SECRET: "s", CONTROL_PLANE_ORIGIN: "https://cp.example", GATEWAY_ORIGIN: "https://gw.example", SENDBLUE_STATUS_URL: STATUS_URL } };
  }
  const post = (path: string, body: unknown) => new Request(`https://agent.example${path}`, { method: "POST", body: JSON.stringify(body) });

  it("routes a status at the configured path to the person's object, without its words", async () => {
    const { env: e, routed } = env();
    const response = await worker.fetch(post("/sendblue/status/abcdefghijklmnop1234", callback()), e);
    expect(response.status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0].to).toBe(PHONE);
    expect(JSON.stringify(routed[0].body)).not.toContain("secret words");
  });

  it("a status at any other path is refused", async () => {
    const { env: e, routed } = env();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await worker.fetch(post("/sendblue/status/abcdefghijklmnop1235", callback()), e)).status).toBe(404);
    expect((await worker.fetch(post("/sendblue/status/abcdefghijklmnop1234", callback()), { ...e, SENDBLUE_STATUS_URL: undefined })).status).toBe(404);
    expect(routed).toEqual([]);
    vi.restoreAllMocks();
  });

  it("a body it cannot place is taken with a 200, so it is not retried", async () => {
    const { env: e, routed } = env();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await worker.fetch(post("/sendblue/status/abcdefghijklmnop1234", { nothing: true }), e)).status).toBe(200);
    expect(routed).toEqual([]);
    vi.restoreAllMocks();
  });
});
