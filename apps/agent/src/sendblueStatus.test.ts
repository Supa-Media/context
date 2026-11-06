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
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, keptEvents, renderTranscript } from "./events";
import { noteHandle } from "./replyQuote";
import { sendblueChatId, sendblueKeys, sendSendblueText } from "./sendblue";
import { sendGroupText } from "./sendblueGroups";
import { noteSendStatus, parseSendStatus } from "./sendblueStatus";

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
