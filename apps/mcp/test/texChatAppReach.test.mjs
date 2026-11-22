/**
 * A CALL TO AN APP CHAT REACHES THE APP CHAT (in-app Tex section A5, 2026-11-20).
 *
 * An app chat lives only in the gateway's `TEX_CHAT`; the texting Worker has no object of it. A background job reports
 * to the chat that started it by name (`chatObject.ts` `reportJob`, through `SENDER_INBOX`), and that name went over the
 * Worker's RPC to an empty Worker object, so a job started from the app never reported back in the app.
 *
 * Sabotage checked: making `appChatNameOf` answer null sends the report over the RPC and fails "a job's report".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appChatNameOf, chatEnv } from "../../../packages/tex/gateway/texChat.js";

const APP = "app:abcdefghijklmnop1234";
const state = { waitUntil() {}, storage: { get: async () => undefined, put: async () => {}, delete: async () => true } };

function namespace(calls) {
  return {
    idFromName: (name) => name,
    get: (name) => ({ fetch: async (request) => (calls.push([name, new URL(request.url).pathname, request.headers.get("x-inbox-name"), await request.text()]), Response.json({ ok: true })) }),
  };
}

async function envFor(name, { chats = [], rpc = [] } = {}) {
  return chatEnv(
    { PUBLIC_ORIGIN: "https://gateway.example", TEX_CHAT: namespace(chats), TEXTING: { inboxFetch: async (id, request) => (rpc.push([id.name, new URL(request.url).pathname]), Response.json({ worker: true })) } },
    state,
    name,
    "",
    { gateway: () => ({ fetch: async () => new Response(null) }), texts: () => ({ fetch: async () => new Response(null) }) },
  );
}

describe("calls to an app chat by name", () => {
  it("a job's report reaches the app chat's own object here, never the Worker", async () => {
    const chats = [];
    const rpc = [];
    const env = await envFor("job:j1", { chats, rpc });
    const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(`enam:${APP}`));
    const answer = await stub.fetch("https://inbox/job-update", { method: "POST", body: '{"id":"j1"}' });
    assert.equal(answer.status, 200);
    assert.deepEqual(chats, [[`chat:${APP}`, "/chat-call/job-update", APP, '{"id":"j1"}']]);
    assert.deepEqual(rpc, []);
  });

  // Part C of the runtime simplification (2026-11-22): every chat lives in `TEX_CHAT`, so a phone's is reached there too.
  it("a phone's chat is reached here too, never through the Worker", async () => {
    const chats = [];
    const rpc = [];
    const env = await envFor("job:j1", { chats, rpc });
    await env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName("enam:+15555550100")).fetch("https://inbox/job-update", { method: "POST", body: "{}" });
    assert.deepEqual(chats, [["chat:+15555550100", "/chat-call/job-update", "+15555550100", "{}"]]);
    assert.deepEqual(rpc, []);
  });

  it("names an app chat only by its exact shape", () => {
    assert.equal(appChatNameOf(`enam:${APP}`), APP);
    assert.equal(appChatNameOf(APP), APP);
    assert.equal(appChatNameOf("enam:+15555550100"), null);
    assert.equal(appChatNameOf("app:../x"), null);
    assert.equal(appChatNameOf(undefined), null);
  });
});
