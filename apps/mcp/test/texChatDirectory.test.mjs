/**
 * A GROUP'S DIRECTORY ENTRY LIVES IN THE GATEWAY (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX, 2026-11-22).
 *
 * A group chat tells its directory entry (`group-key:<key>`) where it is, so a chat routine, a staff move, the Tex page
 * and a cross-chat ask find the group from its key. The entry was the texting Worker's object; it is now a `TexChat`
 * object of its own, answered from its storage, and an entry it does not hold yet is read once from the Worker's and
 * kept.
 *
 * Sabotage checked (each reverted): `isDirectoryName` answering false sends the entry to the chat move and fails
 * "answers from its own storage"; dropping the `storage.put` after the Worker read fails "reads the Worker's entry once".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { texChatClass, chatEnv } from "../../../packages/tex/gateway/texChat.js";
import { isDirectoryName } from "../../../packages/tex/gateway/texChat/directory.js";

const KEY = "a".repeat(64);
const NAME = `group-key:${KEY}`;
const WHERE = { line: "+15555550199", groupId: "grp-1" };

function storage() {
  const map = new Map();
  return { map, get: async (key) => map.get(key), put: async (key, value) => void map.set(key, value), delete: async (key) => map.delete(key) };
}

function worker(entry) {
  const calls = { inboxFetch: [], chatMove: [] };
  return {
    calls,
    rpc: {
      inboxFetch: async (id, request) => (calls.inboxFetch.push([id.name, new URL(request.url).pathname]), Response.json(entry)),
      chatMove: async (call) => (calls.chatMove.push(call), { status: 500, body: null }),
      inboxId: async () => "",
    },
  };
}

function directory(rpc) {
  const TexChat = texChatClass({ gateway: () => ({ fetch: async () => new Response(null) }), texts: () => ({ fetch: async () => new Response(null) }) });
  const store = storage();
  const object = new TexChat({ storage: store, waitUntil() {}, blockConcurrencyWhile: (run) => run() }, { TEXTING: rpc });
  const call = (method, body) =>
    object.fetch(new Request("https://chat/chat-call/chat-where", { method, headers: { "x-inbox-name": NAME }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { object, store, call };
}

describe("a group's directory entry", () => {
  it("is named only by its key's exact shape", () => {
    assert.equal(isDirectoryName(NAME), true);
    assert.equal(isDirectoryName(`enam:${NAME}`), true);
    assert.equal(isDirectoryName("group-key:abc"), false);
    assert.equal(isDirectoryName("+15555550100"), false);
    assert.equal(isDirectoryName(undefined), false);
  });

  it("answers from its own storage: a POST keeps where the chat is, a GET reads it, and nothing is moved", async () => {
    const { rpc, calls } = worker(null);
    const { call, store } = directory(rpc);
    const kept = await call("POST", WHERE);
    assert.deepEqual(await kept.json(), { ok: true });
    assert.deepEqual(store.map.get("chatwhere"), WHERE);
    assert.deepEqual(await (await call("GET")).json(), WHERE);
    assert.deepEqual(calls.chatMove, [], "a directory entry is never copied in as a chat");
    assert.deepEqual(calls.inboxFetch, [], "an entry it holds never asks the Worker");
  });

  it("refuses an entry that is not a line and a group", async () => {
    const { rpc } = worker(null);
    const { call, store } = directory(rpc);
    assert.equal((await call("POST", { line: "not a phone", groupId: "g" })).status, 400);
    assert.equal(store.map.size, 0);
  });

  it("reads the Worker's entry once when it holds none, and keeps it", async () => {
    const { rpc, calls } = worker(WHERE);
    const { call, store } = directory(rpc);
    assert.deepEqual(await (await call("GET")).json(), WHERE);
    assert.deepEqual(store.map.get("chatwhere"), WHERE);
    assert.deepEqual(await (await call("GET")).json(), WHERE);
    assert.deepEqual(calls.inboxFetch, [[`enam:${NAME}`, "/chat-where"]]);
  });

  it("answers null, keeping nothing, when neither it nor the Worker has an entry, or the Worker's is malformed", async () => {
    for (const entry of [null, { line: "x", groupId: "" }]) {
      const { rpc } = worker(entry);
      const { call, store } = directory(rpc);
      assert.equal(await (await call("GET")).json(), null);
      assert.equal(store.map.size, 0);
    }
    const { call } = directory(undefined);
    assert.equal(await (await call("GET")).json(), null, "with no Worker bound, an empty entry is null");
  });

  it("answers no other route", async () => {
    const { rpc } = worker(null);
    const { object } = directory(rpc);
    const answer = await object.fetch(new Request("https://chat/chat-call/accept", { method: "POST", headers: { "x-inbox-name": NAME }, body: "{}" }));
    assert.equal(answer.status, 404);
  });

  it("is what a chat in the gateway writes and reads, through its TexChat object, never the Worker's", async () => {
    const chats = [];
    const rpc = { inboxFetch: async () => assert.fail("the Worker is not asked") };
    const TEX_CHAT = { idFromName: (name) => name, get: (name) => ({ fetch: async (request) => (chats.push([name, new URL(request.url).pathname, request.headers.get("x-inbox-name")]), Response.json({ ok: true })) }) };
    const env = await chatEnv({ PUBLIC_ORIGIN: "https://gw.example", TEXTING: rpc, TEX_CHAT }, { waitUntil() {}, storage: storage() }, "sendblue-group:grp-1", "", {
      gateway: () => ({ fetch: async () => new Response(null) }),
      texts: () => ({ fetch: async () => new Response(null) }),
    });
    await env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(`enam:${NAME}`)).fetch("https://inbox/chat-where", { method: "POST", body: JSON.stringify(WHERE) });
    assert.deepEqual(chats, [[`chat:${NAME}`, "/chat-call/chat-where", NAME]]);
  });
});

describe("the group-moves table", () => {
  it("is its gateway object, like a chat's, never the Worker's", async () => {
    const chats = [];
    const TEX_CHAT = { idFromName: (name) => name, get: (name) => ({ fetch: async (request) => (chats.push([name, new URL(request.url).pathname]), Response.json({ ok: true })) }) };
    const TEXTING = { inboxFetch: async () => assert.fail("the Worker is not asked") };
    const env = await chatEnv({ PUBLIC_ORIGIN: "https://gw.example", TEXTING, TEX_CHAT }, { waitUntil() {}, storage: storage() }, "sendblue-group:grp-1", "", {
      gateway: () => ({ fetch: async () => new Response(null) }),
      texts: () => ({ fetch: async () => new Response(null) }),
    });
    await env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName("enam:group-moves")).fetch("https://inbox/group-move/pending", { method: "POST", body: "{}" });
    assert.deepEqual(chats, [["chat:group-moves", "/chat-call/group-move/pending"]]);
  });
});
