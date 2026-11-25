/**
 * The Worker reaches every chat in the gateway, and nowhere else (part C of the runtime simplification; the Worker's
 * SenderInbox class is deleted, 2026-11-25).
 *
 * Sabotage checked: dropping the `x-inbox-name` header fails "names the chat"; passing a 503 or a failed fetch on as
 * anything but 503 fails "answers 503 when the gateway cannot be reached"; answering a by-id miss with the gateway's
 * own body fails "is the same 404 for every miss".
 */
import { describe, expect, it } from "vitest";
import { chatByIdInGateway, chatInGateway, chatNamespace } from "./gatewayChats";
import { inboxByName, objectByName } from "./objectPlace";
import { textPhone } from "./routines";
import { arrivedAs, clearGroupMoveCache } from "./groupMoves";

describe("chatInGateway", () => {
  it("names the chat and passes path, query, method and body to the gateway's chat-call door", async () => {
    const seen: { url: string; name: string | null; method: string; body: string }[] = [];
    const GATEWAY_TEXTS = {
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ url, name: new Headers(init?.headers).get("x-inbox-name"), method: String(init?.method), body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "" });
        return Response.json({ gateway: true });
      },
    };
    const stub = chatInGateway({ GATEWAY_TEXTS }, "group-key:abc");
    const answer = await stub.fetch("https://inbox/chat-where?x=1", { method: "POST", body: '{"a":1}' });
    expect(await answer.json()).toEqual({ gateway: true });
    expect(seen).toEqual([{ url: "https://gateway/texts/chat-call/chat-where?x=1", name: "group-key:abc", method: "POST", body: '{"a":1}' }]);
    const read = await stub.fetch("https://inbox/chat-where", { method: "GET" });
    expect(read.ok).toBe(true);
    expect(seen[1].body).toBe("");
  });

  it("passes the gateway's answers on, errors included, and answers 503 when the gateway cannot be reached", async () => {
    for (const status of [400, 501, 503]) {
      const GATEWAY_TEXTS = { fetch: async () => new Response(null, { status }) };
      expect((await chatInGateway({ GATEWAY_TEXTS }, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" })).status).toBe(status);
    }
    const down = { fetch: async () => Promise.reject(new Error("down")) };
    expect((await chatInGateway({ GATEWAY_TEXTS: down }, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" })).status).toBe(503);
  });

  it("is 501 without the gateway binding: there is no other copy of a chat", async () => {
    expect((await chatInGateway({}, "+15555550100").fetch("https://inbox/page-jobs", { method: "POST" })).status).toBe(501);
  });
});

describe("chatNamespace", () => {
  function gateway() {
    const seen: { url: string; name: string | null }[] = [];
    return { seen, GATEWAY_TEXTS: { fetch: async (url: string, init?: RequestInit) => (seen.push({ url, name: new Headers(init?.headers).get("x-inbox-name") }), Response.json({ texted: true, outcome: "ok" })) } };
  }

  it("makes every reader written against the namespace reach the gateway's chat of that name, placed or not", async () => {
    const { seen, GATEWAY_TEXTS } = gateway();
    const ns = chatNamespace({ GATEWAY_TEXTS });
    await inboxByName(ns, "+15555550100").fetch("https://inbox/send-status", { method: "POST", body: "{}" });
    await objectByName(ns, "group-moves").fetch("https://inbox/group-move/arrive", { method: "POST", body: "{}" });
    expect(seen).toEqual([
      { url: "https://gateway/texts/chat-call/send-status", name: "+15555550100" },
      { url: "https://gateway/texts/chat-call/group-move/arrive", name: "group-moves" },
    ]);
  });

  it("carries a routine's text and a moved group's lookup to the gateway (`routines.ts`, `groupMoves.ts`)", async () => {
    const { seen, GATEWAY_TEXTS } = gateway();
    await textPhone({ GATEWAY_TEXTS }, "+15555550101", "hello", "key-1").catch(() => null);
    clearGroupMoveCache();
    await arrivedAs(chatNamespace({ GATEWAY_TEXTS }), { photonGroupId: "g", photonLine: "", from: "", participants: [] });
    expect(seen.map((call) => call.name)).toEqual(["+15555550101", "group-moves"]);
  });
});

describe("chatByIdInGateway", () => {
  const ID = "c".repeat(64);
  it("asks the gateway's index, and is the same 404 for every miss", async () => {
    const urls: string[] = [];
    let status = 200;
    const GATEWAY_TEXTS = { fetch: async (url: string) => (urls.push(url), new Response(status === 200 ? "from gateway" : "a miss's own words", { status })) };
    expect(await (await chatByIdInGateway({ GATEWAY_TEXTS }, ID, "/media/tok")).text()).toBe("from gateway");
    expect(urls).toEqual([`https://gateway/texts/chat-by-id/${ID}/media/tok`]);
    status = 404;
    const miss = await chatByIdInGateway({ GATEWAY_TEXTS }, ID, "/threads/tok");
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe("");
    expect((await chatByIdInGateway({}, ID, "/media/tok")).status).toBe(404);
  });

  it("answers 503 when the gateway cannot be reached, so the line asks again", async () => {
    const down = { fetch: async () => Promise.reject(new Error("down")) };
    expect((await chatByIdInGateway({ GATEWAY_TEXTS: down }, ID, "/media/tok")).status).toBe(503);
  });
});
