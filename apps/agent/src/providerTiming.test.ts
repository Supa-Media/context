/**
 * A text's provider times reach the chat's `text` step, and a send's reach its `send` step, whatever the provider
 * (Dev2, 2026-11-14: "that node should show the lag and any logs or any error messages from the provider").
 *
 * Sabotage record (run 2026-11-14, each break reverted before the next):
 *   1. `arrivalOf` kept a lag from a provider time an hour in the future: "a skewed or replayed time keeps no lag" failed.
 *   2. The Linq webhook dropped `provider` from the hand-over: "a Linq text carries its provider's times" failed.
 *   3. `parseSendStatus` read `date_created` as the status's time: "a Sendblue status keeps Sendblue's own times" failed.
 */
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { arrivalOf, lagBetween, providerError, providerTime, readArrival, sendReportOf } from "./providerTiming";
import { parseSendStatus } from "./sendblueStatus";
import { logStep, sendStep, textStep } from "./stepEvents";
import { MemoryStorage } from "./memoryStorage.testing";
import { unwritten } from "./events";
import type { TextsBinding } from "./gatewaySession";

const NOW = Date.parse("2026-11-14T18:00:00Z");

describe("a provider's times", () => {
  it("are read from an ISO string, seconds or milliseconds", () => {
    expect(providerTime("2026-11-14T17:58:00Z")).toBe(NOW - 120_000);
    expect(providerTime((NOW - 5_000) / 1000)).toBe(NOW - 5_000);
    expect(providerTime(NOW - 5_000)).toBe(NOW - 5_000);
    expect(providerTime(String((NOW - 5_000) / 1000))).toBe(NOW - 5_000);
    expect(providerTime("not a time")).toBeNull();
    expect(providerTime(undefined)).toBeNull();
  });

  it("give a text's lag from the provider's time to the webhook", () => {
    expect(arrivalOf("sendblue", "2026-11-14T17:58:00Z", NOW)).toEqual({ name: "sendblue", providerAt: NOW - 120_000, receivedAt: NOW, lagMs: 120_000 });
    expect(arrivalOf("whapi", null, NOW)).toEqual({ name: "whapi", receivedAt: NOW });
  });

  it("a skewed or replayed time keeps no lag", () => {
    expect(arrivalOf("linq", NOW + 3_600_000, NOW)).toEqual({ name: "linq", receivedAt: NOW });
    expect(arrivalOf("linq", NOW - 2 * 86_400_000, NOW)).toEqual({ name: "linq", receivedAt: NOW });
    expect(lagBetween(NOW + 30_000, NOW)).toBe(0); // a little ahead is the provider's clock: no lag, never negative
  });

  it("keep an error as a code and the provider's message cut short", () => {
    expect(providerError(4001, "  Recipient not on iMessage  ")).toEqual({ code: "4001", message: "Recipient not on iMessage" });
    expect(providerError("a b/c", "x".repeat(500))).toEqual({ code: "abc", message: "x".repeat(200) });
    expect(providerError(null, "words")).toBeUndefined();
  });

  it("an arrival a message carries is checked, and anything else is dropped", () => {
    const good = arrivalOf("sendblue", NOW - 1_000, NOW);
    expect(readArrival(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(readArrival({ name: "carrier-pigeon", receivedAt: NOW })).toBeUndefined();
    expect(readArrival({ name: "sendblue" })).toBeUndefined();
    expect(readArrival("sendblue")).toBeUndefined();
  });
});

describe("a send's status", () => {
  it("keeps how long the provider took to reach it", () => {
    expect(sendReportOf("photon", "h1", "delivered", { sentAt: NOW - 333_000, providerAt: NOW })).toEqual({ name: "photon", handle: "h1", status: "delivered", sentAt: NOW - 333_000, providerAt: NOW, lagMs: 333_000 });
  });

  it("a Sendblue status keeps Sendblue's own times, and an error its code and message", () => {
    const status = parseSendStatus({
      message_handle: "mh-1", status: "ERROR", error_code: 4001, error_message: "Not delivered", was_downgraded: false,
      from_number: "+15555550199", number: "+15555550100", date_created: "2026-11-14T17:55:00Z", date_updated: "2026-11-14T18:00:00Z",
    });
    expect(status?.report).toEqual({ name: "sendblue", handle: "mh-1", status: "failed", sentAt: NOW - 300_000, providerAt: NOW, lagMs: 300_000, error: { code: "4001", message: "Not delivered" } });
    const sent = parseSendStatus({ message_handle: "mh-2", status: "SENT", from_number: "+15555550199", number: "+15555550100", date_created: "2026-11-14T17:59:45Z", date_updated: "2026-11-14T18:00:00Z" });
    expect(sent?.report).toEqual({ name: "sendblue", handle: "mh-2", status: "sent", sentAt: NOW - 15_000, providerAt: NOW, lagMs: 15_000 });
    expect(parseSendStatus({ message_handle: "mh-3", status: "DECLINED", from_number: "+15555550199", number: "+15555550100" })?.report?.error).toEqual({ code: "declined" });
  });
});

describe("the steps", () => {
  it("a text step's milliseconds are the provider's lag, and a provider error fails it", () => {
    const step = textStep(undefined, "one", arrivalOf("sendblue", NOW - 120_000, NOW), "queued", NOW + 5);
    expect(step).toMatchObject({ name: "text", of: "one", ok: true, ms: 120_000, output: { outcome: "queued", queuedAt: NOW + 5, lagMs: 120_000 } });
    const failed = textStep(undefined, "group", arrivalOf("photon", null, NOW, { error: { code: "delayed" } }), "queued", NOW);
    expect(failed).toMatchObject({ ok: false, cause: "delayed" });
  });

  it("a send step is kept in the chat's outbox, ids and times only", async () => {
    const storage = new MemoryStorage();
    await logStep(storage, "chat-1", sendStep(sendReportOf("sendblue", "mh-1", "sent", { sentAt: NOW - 15_000, providerAt: NOW })), NOW);
    const kept = (await unwritten(storage)).find((event) => event.kind === "step") as { step?: Record<string, unknown> } | undefined;
    expect(kept?.step).toMatchObject({ name: "send", of: "sent", ok: true, ms: 15_000, input: { provider: "sendblue", handle: "mh-1" } });
  });
});

// The Worker end to end: a signed Linq delivery carries its provider's times to the chat's hand-over.
const RAW_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const SECRET = `whsec_${btoa(String.fromCharCode(...RAW_KEY))}`;

async function signedLinq(body: string): Promise<Request> {
  const id = "evt_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return new Request("https://agent.example/linq", { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}` }, body });
}

describe("a webhook", () => {
  it("a Linq text carries its provider's times to the chat", async () => {
    const sentAt = new Date(Date.now() - 90_000).toISOString();
    const body = JSON.stringify({
      event_type: "message.received", event_id: "evt_1",
      data: { chat: { id: "chat_1", is_group: false }, id: "m1", sent_at: sentAt, sender_handle: { handle: "+15555550100", service: "iMessage" }, service: "iMessage", parts: [{ type: "text", value: "hello" }] },
    });
    const calls: Record<string, unknown>[] = [];
    const gateway: TextsBinding = { fetch: async (_url: string, init?: RequestInit) => (calls.push(JSON.parse(String(init?.body))), Response.json({ outcome: "queued" })) };
    const env = {
      SENDER_INBOX: { idFromName: (name: string) => ({ name }), get: () => ({ fetch: async () => Response.json({ outcome: "queued" }) }) } as unknown as DurableObjectNamespace,
      LINQ_WEBHOOK_SECRET: SECRET, LINQ_API_KEY: "k", AGENT_WORKER_SECRET: "s", CONTROL_PLANE_ORIGIN: "https://cp.example", GATEWAY_ORIGIN: "https://gw.example",
      INTAKE: "gateway", GATEWAY_TEXTS: gateway,
    } as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await worker.fetch(await signedLinq(body), env)).status).toBe(200);
    const provider = (calls[0].message as { provider?: Record<string, unknown> }).provider;
    expect(provider).toMatchObject({ name: "linq", providerAt: Date.parse(sentAt) });
    expect(provider?.lagMs as number).toBeGreaterThanOrEqual(90_000);
    expect(provider?.lagMs as number).toBeLessThan(100_000);
  });
});
