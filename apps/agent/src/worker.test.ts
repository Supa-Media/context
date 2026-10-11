import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const RAW_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const SECRET = `whsec_${btoa(String.fromCharCode(...RAW_KEY))}`;

async function signedRequest(body: string, opts: { id?: string; key?: Uint8Array; path?: string } = {}) {
  const id = opts.id ?? "evt_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", opts.key ?? RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return new Request(`https://agent.example${opts.path ?? "/linq"}`, {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
    },
    body,
  });
}

function env(): { env: Env; routedTo: string[] } {
  const routedTo: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async () => {
        routedTo.push(id.name);
        return Response.json({ outcome: "queued" });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    routedTo,
    env: {
      SENDER_INBOX: namespace,
      LINQ_WEBHOOK_SECRET: SECRET,
      LINQ_API_KEY: "k",
      AGENT_WORKER_SECRET: "s",
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
    },
  };
}

const received = (from: string, isGroup = false) =>
  JSON.stringify({
    event_type: "message.received",
    event_id: "evt_1",
    data: {
      chat: { id: "chat_1", is_group: isGroup },
      id: "m1",
      sender_handle: { handle: from, service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello" }],
    },
  });

describe("worker", () => {
  it("logs each webhook's outcome and why one was dropped, never the number or the text", async () => {
    const { env: e } = env();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    try {
      await worker.fetch(await signedRequest(received("+15555550100")), e);
      await worker.fetch(await signedRequest(received("+15555550100", true), { id: "evt_2" }), e);
      await worker.fetch(await signedRequest(received("someone@example.com"), { id: "evt_3" }), e);
    } finally {
      spy.mockRestore();
    }
    const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "linq_webhook");
    expect(events).toEqual([
      { event: "linq_webhook", outcome: "accepted" },
      { event: "linq_webhook", outcome: "ignored", reason: "group" },
      { event: "linq_webhook", outcome: "ignored", reason: "sender" },
    ]);
    expect(lines.join("\n")).not.toMatch(/5555550100|example\.com|hello/);
  });

  it("queues a signed direct message in the sender's own inbox", async () => {
    const { env: e, routedTo } = env();
    const response = await worker.fetch(await signedRequest(received("+15555550100")), e);
    expect(response.status).toBe(200);
    expect(routedTo).toEqual(["+15555550100"]);
  });

  it("refuses an unsigned or wrongly signed webhook before reading it", async () => {
    const { env: e, routedTo } = env();
    const forged = await signedRequest(received("+15555550100"), { key: new Uint8Array(32) });
    expect((await worker.fetch(forged, e)).status).toBe(401);
    const unsigned = new Request("https://agent.example/linq", { method: "POST", body: received("+15555550100") });
    expect((await worker.fetch(unsigned, e)).status).toBe(401);
    expect(routedTo).toEqual([]);
  });

  it("reports which settings are present, and never a secret's value", async () => {
    const { env: e } = env();
    e.LINQ_WEBHOOK_SECRET = "";
    const response = await worker.fetch(new Request("https://agent.example/health"), e);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      ok: true,
      webhook: false,
      replies: true,
      workerSecret: true,
      controlPlane: true,
      gatewayOrigin: "https://gw.example",
      simulator: false,
    });
    expect(body).not.toContain("cp.example");
    expect((await worker.fetch(new Request("https://agent.example/health", { method: "POST" }), e)).status).toBe(404);
  });

  it("refuses everything when the deployment has no webhook secret", async () => {
    const { env: e, routedTo } = env();
    e.LINQ_WEBHOOK_SECRET = "";
    expect((await worker.fetch(await signedRequest(received("+15555550100")), e)).status).toBe(401);
    expect(routedTo).toEqual([]);
  });

  it("acknowledges signed events it does not act on, without queueing them", async () => {
    const { env: e, routedTo } = env();
    expect((await worker.fetch(await signedRequest(received("+15555550100", true)), e)).status).toBe(200);
    expect((await worker.fetch(await signedRequest(received("someone@example.com")), e)).status).toBe(200);
    expect(routedTo).toEqual([]);
  });

  it("answers 404 off the webhook path and 405 for other methods", async () => {
    const { env: e } = env();
    expect((await worker.fetch(new Request("https://agent.example/"), e)).status).toBe(404);
    expect((await worker.fetch(new Request("https://agent.example/linq"), e)).status).toBe(405);
  });

  it("refuses an oversized body", async () => {
    const { env: e } = env();
    const big = await signedRequest("x".repeat(300 * 1024));
    expect((await worker.fetch(big, e)).status).toBe(413);
  });

  describe("the routine cron", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    async function tick(e: Env) {
      const waiting: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waiting.push(p) } as unknown as ExecutionContext;
      await worker.scheduled({} as ScheduledController, e, ctx);
      await Promise.all(waiting);
    }

    it("asks nobody anything without a control plane", async () => {
      const { env: e } = env();
      e.CONTROL_PLANE_ORIGIN = "";
      const fetched = vi.fn();
      vi.stubGlobal("fetch", fetched);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await tick(e);
      expect(fetched).not.toHaveBeenCalled();
    });

    it("texts each phone through that phone's own inbox", async () => {
      const inboxCalls: { name: string; url: string; body: unknown }[] = [];
      const reported: unknown[] = [];
      const { env: e } = env();
      e.SENDER_INBOX = {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async (url: string, init: RequestInit) => {
            inboxCalls.push({ name: id.name, url, body: JSON.parse(String(init.body)) });
            return Response.json({ status: "texted" });
          },
        }),
      } as unknown as DurableObjectNamespace;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/routines/due") {
          return Response.json({
            runs: [{ runId: "r1", accessToken: "g", path: "routines/daily/a.md", timeZone: "UTC", send: "text", phones: ["+15555550100"] }],
          });
        }
        if (path === "/agent") return Response.json({ outcome: "answered", answer: "hi", send: "text" });
        reported.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      await tick(e);
      expect(inboxCalls).toEqual([
        { name: "+15555550100", url: "https://inbox/routine-text", body: { text: "hi", idempotencyKey: "routine:r1:+15555550100" } },
      ]);
      expect(reported).toEqual([{ runId: "r1", outcome: "answered", texted: 1 }]);
    });
  });
});
