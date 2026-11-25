/**
 * Sabotage record (each break reverted before the next):
 *   1. (2026-11-14) toChat's fallback broken. Since 2026-11-25 there is no fallback: the Worker's SenderInbox class is
 *      deleted, and a failed hand-over answers 503 so the provider sends the text again.
 *   2. (2026-11-25) toChat answered 200 for a failed hand-over: "answers 503 when the hand-over fails" and "a failed
 *      hand-over answers the webhook 503" failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { handOver, toChat } from "./handOver";
import type { TextsBinding } from "./gatewaySession";

type Call = { url: string; body: Record<string, unknown> };

/** A TexTexts binding stub answering `/texts/arrive` with the given reply, and recording every call. */
function binding(reply: () => Response | Promise<Response>): { binding: TextsBinding; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return reply();
      },
    },
  };
}

const answer = (outcome: unknown, status = 200) => () => Response.json({ outcome }, { status });

const CALL = { kind: "one" as const, inbox: "chat:+15555550100", eventId: "linq:evt_1", message: { text: "hello" }, origin: "https://agent.example" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handOver", () => {
  it.each(["queued", "duplicate", "full", "preview", "kept", "ignored", "noted", "held", "dropped"])("returns the gateway's %s outcome", async (outcome) => {
    const { binding: b, calls } = binding(answer(outcome));
    expect(await handOver(b, CALL)).toBe(outcome);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway/texts/arrive");
    expect(calls[0].body).toEqual({ kind: "one", inbox: "chat:+15555550100", eventId: "linq:evt_1", message: { text: "hello" }, origin: "https://agent.example" });
  });

  it("is failed for a non-200 answer", async () => {
    const { binding: b } = binding(answer("queued", 503));
    expect(await handOver(b, CALL)).toBe("failed");
  });

  it("is failed when the binding throws", async () => {
    const b: TextsBinding = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    expect(await handOver(b, CALL)).toBe("failed");
  });

  it.each([
    ["an unknown outcome", () => Response.json({ outcome: "shrug" })],
    ["no outcome", () => Response.json({})],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["a JSON null", () => Response.json(null)],
    ["a non-string outcome", () => Response.json({ outcome: 1 })],
  ])("is failed for %s", async (_, reply) => {
    const { binding: b } = binding(reply);
    expect(await handOver(b, CALL)).toBe("failed");
  });

  it("logs one line with the kind and outcome, never the text, the phone or the inbox name", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const { binding: b } = binding(answer("queued"));
    await handOver(b, CALL);
    const { binding: failing } = binding(answer("queued", 500));
    await handOver(failing, { ...CALL, kind: "group", message: { text: "secret words" }, inbox: "chat:+15555550199" });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "intake_handover", kind: "one", outcome: "queued" },
      { event: "intake_handover", kind: "group", outcome: "failed" },
    ]);
    expect(lines.join("\n")).not.toMatch(/5555550|hello|secret|chat:/);
  });
});

describe("toChat", () => {
  it("hands over whenever the gateway is bound, with no switch to read", async () => {
    const { binding: b, calls } = binding(answer("queued"));
    expect((await toChat({ GATEWAY_TEXTS: b }, "one", "chat:+15555550100", { eventId: "e" }))?.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("is 501 when the gateway binding is absent: there is nowhere else a chat lives", async () => {
    expect((await toChat({}, "one", "chat:+15555550100", {})).status).toBe(501);
  });

  // The chat's routes answer 200 for every outcome, "full" included, and the webhook answers `result.ok`.
  it("answers 200 for every outcome, full included, and sends the event id it carries", async () => {
    for (const outcome of ["queued", "duplicate", "full", "held"]) {
      const { binding: b, calls } = binding(answer(outcome));
      const response = await toChat({ GATEWAY_TEXTS: b }, "one", "chat:+15555550100", { eventId: "linq:evt_9", text: "hi" }, "https://agent.example");
      expect(response?.status).toBe(200);
      expect(calls[0].body).toMatchObject({ kind: "one", inbox: "chat:+15555550100", eventId: "linq:evt_9", origin: "https://agent.example" });
    }
  });

  it("answers 503 when the hand-over fails, so the webhook sends it again, and says so without the text", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const { binding: b } = binding(answer("queued", 500));
    expect((await toChat({ GATEWAY_TEXTS: b }, "react", "chat:+15555550100", { text: "hi" })).status).toBe(503);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ event: "intake_handover", kind: "react", outcome: "failed" });
    expect(lines.join("\n")).not.toMatch(/5555550|hi"/);
  });

  it("carries no event id for a members change, which has none", async () => {
    const { binding: b, calls } = binding(answer("queued"));
    await toChat({ GATEWAY_TEXTS: b }, "members", "sendblue-group:abc", null);
    expect(calls[0].body).toEqual({ kind: "members", inbox: "sendblue-group:abc", message: null });
  });
});

// The Worker end to end: a signed Linq delivery, as the existing worker tests send one.
const RAW_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const SECRET = `whsec_${btoa(String.fromCharCode(...RAW_KEY))}`;
const PHONE = "+15555550100";

async function signedRequest(body: string): Promise<Request> {
  const id = "evt_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return new Request("https://agent.example/linq", {
    method: "POST",
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}` },
    body,
  });
}

const received = JSON.stringify({
  event_type: "message.received",
  event_id: "evt_1",
  data: {
    chat: { id: "chat_1", is_group: false },
    id: "m1",
    sender_handle: { handle: PHONE, service: "iMessage" },
    service: "iMessage",
    parts: [{ type: "text", value: "hello" }],
  },
});

function workerEnv(extra: Partial<Env>): { env: Env; seen: { inboxFetched: number } } {
  const seen = { inboxFetched: 0 };
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
    get: () => ({
      fetch: async () => {
        seen.inboxFetched += 1;
        return Response.json({ outcome: "queued" });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const env: Env = {
    SENDER_INBOX: namespace,
    LINQ_WEBHOOK_SECRET: SECRET,
    LINQ_API_KEY: "k",
    AGENT_WORKER_SECRET: "s",
    CONTROL_PLANE_ORIGIN: "https://cp.example",
    GATEWAY_ORIGIN: "https://gw.example",
    ...extra,
  };
  return { env, seen };
}

describe("the webhook hands over", () => {
  it("answers the webhook 503 without a gateway binding, and touches no inbox", async () => {
    const w = workerEnv({});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await worker.fetch(await signedRequest(received), w.env);
    expect(response.status).toBe(503);
    expect(w.seen.inboxFetched).toBe(0);
  });

  it("hands a 1:1 text to the gateway, and leaves the inbox alone", async () => {
    const { binding: b, calls } = binding(answer("queued"));
    const w = workerEnv({ GATEWAY_TEXTS: b });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await worker.fetch(await signedRequest(received), w.env);
    expect(response.status).toBe(200);
    expect(w.seen.inboxFetched).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway/texts/arrive");
    expect(calls[0].body).toMatchObject({ kind: "one", inbox: PHONE, eventId: "evt_1", origin: "https://agent.example" });
  });

  it("a failed hand-over answers the webhook 503, so it is sent again, and no Worker inbox takes it", async () => {
    const { binding: b, calls } = binding(answer("queued", 500));
    const w = workerEnv({ GATEWAY_TEXTS: b });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await worker.fetch(await signedRequest(received), w.env);
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
    expect(w.seen.inboxFetched).toBe(0);
  });
});
