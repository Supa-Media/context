/**
 * The Worker reaches a chat in the gateway (part C of the runtime simplification, 2026-11-22).
 *
 * Sabotage checked: dropping the `x-inbox-name` header fails "names the chat"; returning the Worker's object when the
 * binding is bound fails "never the Worker's object".
 */
import { describe, expect, it } from "vitest";
import { chatInGateway } from "./gatewayChats";

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

  it("is the Worker's own object without the gateway binding (self-hosting)", async () => {
    const worker: string[] = [];
    await chatInGateway({ SENDER_INBOX: namespace(worker) }, "+15555550100").fetch("https://inbox/page-jobs", { method: "POST" });
    expect(worker).toEqual(["enam:+15555550100 /page-jobs"]);
  });
});
