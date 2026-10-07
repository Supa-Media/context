import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { record, SIM_LOG_FOR_MS, SIM_LOG_LIMIT, SIMULATED_PHONE, simulatorInbox, thread } from "./simulator";
import type { Fetch } from "./clients";

const PHONE = "+14155550142";
const KEY = "ab".repeat(24);
const OTHER_KEY = "cd".repeat(24);
const LINK = "https://app.example/texts/abc123";

/** A Worker whose Durable Objects run the real inbox code over memory. */
function setup(simulator: string | undefined) {
  const objects = new Map<string, MemoryStorage>();
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: string, init: RequestInit) => {
        const storage = objects.get(id.name) ?? new MemoryStorage();
        objects.set(id.name, storage);
        const path = new URL(input).pathname;
        const body = JSON.parse(String(init.body));
        if (!path.startsWith("/sim/")) return Response.json({ outcome: await accept(storage, body, 1_000) });
        return simulatorInbox(storage, path.slice(5), body, 1_000, (m) => accept(storage, m, 1_000));
      },
    }),
  } as unknown as DurableObjectNamespace;
  const env: Env = {
    SENDER_INBOX: namespace,
    LINQ_WEBHOOK_SECRET: "",
    LINQ_API_KEY: "k",
    AGENT_WORKER_SECRET: "s",
    CONTROL_PLANE_ORIGIN: "https://cp.example",
    GATEWAY_ORIGIN: "https://gw.example",
    SIMULATOR: simulator,
  };
  return { env, objects };
}

const api = (path: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  new Request(`https://agent.example/texts-simulator/api${path}`, {
    method: init.method ?? "POST",
    headers: init.key === undefined ? {} : { "x-simulator-key": init.key },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

/** Deps for an unlinked phone: the control plane issues a link, and Linq must never be called. */
function unlinkedDeps(linqCalls: string[]): InboxDeps {
  const fetcher = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/agent-texts/session") return Response.json({ status: "unlinked" });
    if (path === "/agent-texts/invite") return Response.json({ status: "issued", url: LINK });
    linqCalls.push(url);
    return new Response("{}", { status: 200 });
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => 2_000,
  };
}

describe("texts simulator", () => {
  it("does not exist unless the Worker's SIMULATOR var is on", async () => {
    for (const value of [undefined, "", "true", "off"]) {
      const { env } = setup(value);
      expect((await worker.fetch(new Request("https://agent.example/texts-simulator"), env)).status).toBe(404);
      expect((await worker.fetch(api("/send", { key: KEY, body: { phone: PHONE, text: "hi" } }), env)).status).toBe(404);
      const health = await (await worker.fetch(new Request("https://agent.example/health"), env)).json();
      expect(health).toMatchObject({ simulator: false });
    }
  });

  it("serves a self-contained page that loads nothing from elsewhere", async () => {
    const { env } = setup("on");
    const response = await worker.fetch(new Request("https://agent.example/texts-simulator"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await response.text();
    expect(html).toContain("<title>Texts Simulator</title>");
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=/i);
  });

  it("accepts only numbers reserved for fiction", () => {
    expect(SIMULATED_PHONE.test("+14155550142")).toBe(true);
    expect(SIMULATED_PHONE.test("+12125550199")).toBe(true);
    for (const real of ["+14155552671", "+14155550200", "+447700900123", "+1415555014", "+11155550142"]) {
      expect(SIMULATED_PHONE.test(real)).toBe(false);
    }
  });

  it("refuses a real-looking number, a missing key and an empty text", async () => {
    const { env, objects } = setup("on");
    expect((await worker.fetch(api("/send", { key: KEY, body: { phone: "+14155552671", text: "hi" } }), env)).status).toBe(400);
    expect((await worker.fetch(api("/send", { body: { phone: PHONE, text: "hi" } }), env)).status).toBe(401);
    expect((await worker.fetch(api("/send", { key: "short", body: { phone: PHONE, text: "hi" } }), env)).status).toBe(401);
    expect((await worker.fetch(api("/send", { key: KEY, body: { phone: PHONE, text: "  " } }), env)).status).toBe(400);
    expect(objects.size).toBe(0);
  });

  it("lets only the browser that claimed a number read or text from it", async () => {
    const { env } = setup("on");
    expect((await worker.fetch(api("/send", { key: KEY, body: { phone: PHONE, text: "hi" } }), env)).status).toBe(200);
    const read = (key: string) =>
      worker.fetch(api(`/thread?phone=${encodeURIComponent(PHONE)}`, { method: "GET", key }), env);
    expect((await read(OTHER_KEY)).status).toBe(409);
    expect((await worker.fetch(api("/send", { key: OTHER_KEY, body: { phone: PHONE, text: "hi" } }), env)).status).toBe(409);
    expect((await worker.fetch(api("/clear", { key: OTHER_KEY, body: { phone: PHONE } }), env)).status).toBe(409);
    const mine = await read(KEY);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ messages: [{ dir: "out", text: "hi" }], typing: true });
  });

  it("answers through the same queue as a real text, and writes the reply to the log instead of Linq", async () => {
    const { env, objects } = setup("on");
    await worker.fetch(api("/send", { key: KEY, body: { phone: PHONE, text: "hi" } }), env);
    const storage = objects.get(PHONE)!;
    const linqCalls: string[] = [];
    await drain(storage, unlinkedDeps(linqCalls));
    expect(linqCalls).toEqual([]);
    const { messages, typing } = await thread(storage, 2_000);
    expect(typing).toBe(false);
    expect(messages.map((m) => [m.dir, m.text])).toEqual([
      ["out", "hi"],
      ["in", "Hi, I'm your Context. Tap the link below to connect your account, then text me the code it shows you."],
      ["in", LINK],
    ]);
  });

  it("clears the chat but keeps the number claimed", async () => {
    const { env } = setup("on");
    await worker.fetch(api("/send", { key: KEY, body: { phone: PHONE, text: "hi" } }), env);
    expect((await worker.fetch(api("/clear", { key: KEY, body: { phone: PHONE } }), env)).status).toBe(200);
    const read = await worker.fetch(api(`/thread?phone=${encodeURIComponent(PHONE)}`, { method: "GET", key: KEY }), env);
    expect(((await read.json()) as { messages: unknown[] }).messages).toEqual([]);
    expect((await worker.fetch(api("/send", { key: OTHER_KEY, body: { phone: PHONE, text: "hi" } }), env)).status).toBe(409);
  });

  it("keeps the log to a day and to its limit", async () => {
    const storage = new MemoryStorage();
    await record(storage, "out", "old", 0);
    for (let i = 0; i < SIM_LOG_LIMIT + 5; i++) await record(storage, "out", `m${i}`, SIM_LOG_FOR_MS + 10);
    const { messages } = await thread(storage, SIM_LOG_FOR_MS + 10);
    expect(messages).toHaveLength(SIM_LOG_LIMIT);
    expect(messages[0].text).toBe("m5");
    expect([...storage.data.keys()].filter((k) => k.startsWith("sim:log:"))).toHaveLength(SIM_LOG_LIMIT);
  });

  it("never treats a Linq delivery as simulated", async () => {
    const storage = new MemoryStorage();
    await accept(
      storage,
      { kind: "message", eventId: "e1", chatId: "chat_1", from: "+14155552671", messageId: "m1", text: "hi" },
      1_000,
    );
    const linqCalls: string[] = [];
    await drain(storage, unlinkedDeps(linqCalls));
    expect(linqCalls.map((url) => new URL(url).pathname.split("/").pop())).toEqual([
      "typing",
      "messages",
      "messages",
      // A real chat is offered the line's contact card after the reply.
      "share_contact_card",
    ]);
    expect((await thread(storage, 2_000)).messages).toEqual([]);
  });
});
