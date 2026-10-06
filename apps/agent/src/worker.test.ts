import { describe, expect, it } from "vitest";
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
      chat_id: "chat_1",
      from,
      is_group: isGroup,
      service: "iMessage",
      message: { id: "m1", parts: [{ type: "text", value: "hello" }] },
    },
  });

describe("worker", () => {
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
});
