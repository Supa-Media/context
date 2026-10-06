import { describe, expect, it } from "vitest";
import {
  askAgent,
  linkPhone,
  LINQ_API,
  MAX_REPLY_TEXT,
  openSession,
  sendLinqText,
  ServiceError,
  type Fetch,
} from "./clients";

type Call = { url: string; init: RequestInit };

function fake(status: number, body: unknown, calls: Call[] = []): Fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as Fetch;
}

const throwing: Fetch = (async () => {
  throw new Error("network down");
}) as unknown as Fetch;

describe("sendLinqText", () => {
  it("posts the text to the chat with the key and an idempotency key", async () => {
    const calls: Call[] = [];
    await sendLinqText(fake(201, {}, calls), "linq-key", "chat/1", "hi", "reply:evt_1");
    expect(calls[0].url).toBe(`${LINQ_API}/chats/chat%2F1/messages`);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer linq-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      parts: [{ type: "text", value: "hi" }],
      idempotency_key: "reply:evt_1",
    });
  });

  it("caps the reply length", async () => {
    const calls: Call[] = [];
    await sendLinqText(fake(200, {}, calls), "k", "c", "x".repeat(MAX_REPLY_TEXT + 10), "i");
    expect(JSON.parse(String(calls[0].init.body)).parts[0].value).toHaveLength(MAX_REPLY_TEXT);
  });

  it("throws a ServiceError on a refusal or a network failure", async () => {
    await expect(sendLinqText(fake(429, {}), "k", "c", "t", "i")).rejects.toBeInstanceOf(ServiceError);
    await expect(sendLinqText(throwing, "k", "c", "t", "i")).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("openSession", () => {
  it("returns the grant for a linked phone, sending the worker secret", async () => {
    const calls: Call[] = [];
    const answer = await openSession(
      fake(200, { status: "linked", accessToken: "tok" }, calls),
      "https://cp.example",
      "worker-secret",
      "+15555550100",
    );
    expect(answer).toEqual({ status: "linked", accessToken: "tok" });
    expect(calls[0].url).toBe("https://cp.example/agent-texts/session");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer worker-secret");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ phone: "+15555550100" });
  });

  it("returns unlinked for a phone nobody linked", async () => {
    expect(await openSession(fake(200, { status: "unlinked" }), "o", "s", "p")).toEqual({ status: "unlinked" });
  });

  it("treats anything else as a failure, never as linked", async () => {
    for (const [status, body] of [
      [200, { status: "linked" }],
      [200, { status: "linked", accessToken: "" }],
      [200, "not json"],
      [401, { status: "linked", accessToken: "tok" }],
      [500, {}],
    ] as const) {
      await expect(openSession(fake(status, body), "o", "s", "p")).rejects.toBeInstanceOf(ServiceError);
    }
  });
});

describe("linkPhone", () => {
  it("reports linked only when the control plane says so", async () => {
    expect(await linkPhone(fake(200, { status: "linked", handle: "ada" }), "o", "s", "p", "1")).toEqual({
      status: "linked",
      handle: "ada",
    });
    // A link with no handle, or one that is not a handle, is not trusted into a reply.
    for (const body of [{ status: "linked" }, { status: "linked", handle: "<b>x</b>" }, { status: "refused" }, {}]) {
      expect(await linkPhone(fake(200, body), "o", "s", "p", "1")).toEqual({ status: "refused" });
    }
    await expect(linkPhone(fake(503, {}), "o", "s", "p", "1")).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("askAgent", () => {
  it("asks the gateway with the person's grant and names the texts conversation", async () => {
    const calls: Call[] = [];
    const answer = await askAgent(fake(200, { answer: " Sure. " }, calls), "https://gw.example", "tok", "hi");
    expect(answer).toEqual({ kind: "answer", text: "Sure." });
    expect(calls[0].url).toBe("https://gw.example/agent");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ question: "hi", conversation: "texts" });
  });

  it("says when no model is connected, and folds every other failure into unavailable", async () => {
    expect(await askAgent(fake(409, { error: "no_provider" }), "g", "t", "q")).toEqual({ kind: "no_model" });
    expect(await askAgent(fake(429, { error: "daily_limit" }), "g", "t", "q")).toEqual({ kind: "daily_limit" });
    expect(await askAgent(fake(200, { answer: "  " }), "g", "t", "q")).toEqual({ kind: "unavailable" });
    expect(await askAgent(fake(503, {}), "g", "t", "q")).toEqual({ kind: "unavailable" });
    expect(await askAgent(throwing, "g", "t", "q")).toEqual({ kind: "unavailable" });
  });
});
