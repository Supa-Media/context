/**
 * The Worker reaches a chat in the gateway (part C of the runtime simplification, 2026-11-22).
 *
 * Sabotage checked: dropping the `x-inbox-name` header fails "names the chat"; returning the Worker's object when the
 * binding is bound fails "never the Worker's object".
 */
import { describe, expect, it } from "vitest";
import { chatByIdInGateway, chatInGateway, chatNamespace } from "./gatewayChats";
import { inboxByName, objectByName } from "./objectPlace";
import { textPhone } from "./routines";
import { arrivedAs, clearGroupMoveCache } from "./groupMoves";

function namespace(calls: string[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => (calls.push(`${id.name} ${new URL(new Request(input, init).url).pathname}`), Response.json({ worker: true })),
    }),
  } as unknown as DurableObjectNamespace;
}

describe("chatInGateway", () => {
  it("names the chat and passes path, query, method and body to the gateway's chat-call door, never the Worker's object", async () => {
    const worker: string[] = [];
    const seen: { url: string; name: string | null; method: string; body: string }[] = [];
    const GATEWAY_TEXTS = {
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ url, name: new Headers(init?.headers).get("x-inbox-name"), method: String(init?.method), body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "" });
        return Response.json({ gateway: true });
      },
    };
    const stub = chatInGateway({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS }, "group-key:abc");
    const answer = await stub.fetch("https://inbox/chat-where?x=1", { method: "POST", body: '{"a":1}' });
    expect(await answer.json()).toEqual({ gateway: true });
    expect(seen).toEqual([{ url: "https://gateway/texts/chat-call/chat-where?x=1", name: "group-key:abc", method: "POST", body: '{"a":1}' }]);
    const read = await stub.fetch("https://inbox/chat-where", { method: "GET" });
    expect(read.ok).toBe(true);
    expect(seen[1].body).toBe("");
    expect(worker).toEqual([]);
  });

  it("leaves the Worker's object answering when the gateway cannot hold the chat (501, 503) or cannot be reached", async () => {
    for (const answer of [() => new Response(null, { status: 503 }), () => new Response(null, { status: 501 }), () => Promise.reject(new Error("down"))]) {
      const worker: string[] = [];
      const GATEWAY_TEXTS = { fetch: async () => answer() };
      const reply = await chatInGateway({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS }, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" });
      expect(await reply.json()).toEqual({ worker: true });
      expect(worker).toEqual(["enam:+15555550100 /send-status"]);
    }
  });

  it("passes the gateway's other answers on, errors included", async () => {
    const worker: string[] = [];
    const GATEWAY_TEXTS = { fetch: async () => new Response(null, { status: 400 }) };
    const reply = await chatInGateway({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS }, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" });
    expect(reply.status).toBe(400);
    expect(worker).toEqual([]);
  });

  it("is the Worker's own object without the gateway binding (self-hosting)", async () => {
    const worker: string[] = [];
    await chatInGateway({ SENDER_INBOX: namespace(worker) }, "+15555550100").fetch("https://inbox/page-jobs", { method: "POST" });
    expect(worker).toEqual(["enam:+15555550100 /page-jobs"]);
  });
});

describe("chatNamespace", () => {
  function gateway() {
    const seen: { url: string; name: string | null }[] = [];
    return { seen, GATEWAY_TEXTS: { fetch: async (url: string, init?: RequestInit) => (seen.push({ url, name: new Headers(init?.headers).get("x-inbox-name") }), Response.json({ texted: true, outcome: "ok" })) } };
  }

  it("makes every reader written against the namespace reach the gateway's chat of that name, placed or not", async () => {
    const worker: string[] = [];
    const { seen, GATEWAY_TEXTS } = gateway();
    const ns = chatNamespace({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS });
    await inboxByName(ns, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" });
    await objectByName(ns, "group-moves").fetch("https://inbox/group-move/arrive", { method: "POST", body: "{}" });
    expect(seen).toEqual([
      { url: "https://gateway/texts/chat-call/send-status", name: "+15555550100" },
      { url: "https://gateway/texts/chat-call/group-move/arrive", name: "group-moves" },
    ]);
    expect(worker).toEqual([]);
  });

  it("is the Worker's own namespace without the gateway binding", () => {
    const ns = namespace([]);
    expect(chatNamespace({ SENDER_INBOX: ns })).toBe(ns);
  });

  it("carries a routine's text and a moved group's lookup to the gateway (`routines.ts`, `groupMoves.ts`)", async () => {
    const worker: string[] = [];
    const { seen, GATEWAY_TEXTS } = gateway();
    await textPhone({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS }, "+15555550101", "hello", "key-1").catch(() => null);
    clearGroupMoveCache();
    await arrivedAs(chatNamespace({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS }), { photonGroupId: "g", photonLine: "", from: "", participants: [] });
    expect(seen.map((call) => call.name)).toEqual(["+15555550101", "group-moves"]);
    expect(worker).toEqual([]);
  });
});

describe("chatByIdInGateway", () => {
  const ID = "c".repeat(64);
  it("asks the gateway's index first, and the Worker's object only when the gateway has no answer", async () => {
    const urls: string[] = [];
    let status = 200;
    const GATEWAY_TEXTS = { fetch: async (url: string) => (urls.push(url), new Response("from gateway", { status })) };
    const worker = async () => new Response("from worker");
    const env = { SENDER_INBOX: namespace([]), GATEWAY_TEXTS };
    expect(await (await chatByIdInGateway(env, ID, "/media/tok", worker)).text()).toBe("from gateway");
    expect(urls).toEqual([`https://gateway/texts/chat-by-id/${ID}/media/tok`]);
    status = 404;
    expect(await (await chatByIdInGateway(env, ID, "/threads/tok", worker)).text()).toBe("from worker");
    const down = { SENDER_INBOX: namespace([]), GATEWAY_TEXTS: { fetch: async () => Promise.reject(new Error("down")) } };
    expect(await (await chatByIdInGateway(down, ID, "/media/tok", worker)).text()).toBe("from worker");
    expect(await (await chatByIdInGateway({ SENDER_INBOX: namespace([]) }, ID, "/media/tok", worker)).text()).toBe("from worker");
  });
});
