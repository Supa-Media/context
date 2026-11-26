/**
 * A LAB TEST CHAT CARRIES THE REAL CHAT'S STICKERS (`../../../packages/lab/gateway/labSandbox/realChat.js`; Dev2,
 * 2026-11-26: make test chats carry the source chat's stickers, then test "tex send me a sticker" in a copy).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `realStickers` asking the chat object with no `x-inbox-name` header.
 *     → "a test chat reads the real chat's kept stickers from its chat object" fails.
 *  2. `keptStickers` keeping a malformed id.
 *     → "only well-formed stickers are copied, the newest thirty" fails.
 *  3. `seedStickers` writing under another key.
 *     → "a fresh test chat object starts with them under the chat's own key" fails.
 *  4. `stickersFor` reading a shared 1:1 by the caller's phone.
 *     → "a group's stickers are found by its directory entry; a shared 1:1's are never read" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keptStickers, realStickers, seedStickers, stickersFor } from "../../../packages/lab/gateway/labSandbox/realChat.js";

const KEPT = [
  { id: "s0a1b2c", guid: "at_0_ROBOT", at: 1, words: "robot waving; fits a friendly hello", lookedAt: 2 },
  { id: "s3d4e5f", guid: "at_0_CAT", at: 3 },
];

function chatNamespace(answer) {
  const calls = [];
  const stub = {
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method, inbox: new Headers(init.headers).get("x-inbox-name") });
      return answer;
    },
  };
  return { calls, namespace: { idFromName: (name) => (calls.push({ name }), name), get: () => stub } };
}

test("a test chat reads the real chat's kept stickers from its chat object", async () => {
  const chat = chatNamespace(Response.json(KEPT));
  assert.deepEqual(await realStickers({ TEX_CHAT: chat.namespace }, "sendblue-group:grp-1"), KEPT);
  assert.deepEqual(chat.calls, [
    { name: "chat:sendblue-group:grp-1" },
    { url: "https://chat/chat-call/stickers", method: "GET", inbox: "sendblue-group:grp-1" },
  ]);
});

test("none when the chat cannot be named or read", async () => {
  const chat = chatNamespace(new Response(null, { status: 503 }));
  assert.deepEqual(await realStickers({ TEX_CHAT: chat.namespace }, "sendblue-group:grp-1"), []);
  assert.deepEqual(await realStickers({ TEX_CHAT: chat.namespace }, null), []);
  assert.deepEqual(await realStickers({}, "sendblue-group:grp-1"), []);
});

test("only well-formed stickers are copied, the newest thirty", () => {
  assert.deepEqual(keptStickers([...KEPT, { id: "nope", guid: "x", at: 1 }, { id: "s9z9z9z", at: 1 }, null, "s1"]), KEPT);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${String(i).padStart(6, "0")}`, guid: `g${i}`, at: i }));
  const kept = keptStickers(many);
  assert.equal(kept.length, 30);
  assert.equal(kept[0].id, "s000010");
  assert.deepEqual(keptStickers(null), []);
});

test("a fresh test chat object starts with them under the chat's own key", async () => {
  const put = new Map();
  const storage = { put: async (key, value) => void put.set(key, value) };
  await seedStickers(storage, { stickers: KEPT });
  assert.deepEqual(put.get("stickers"), KEPT);
  const none = new Map();
  await seedStickers({ put: async (key, value) => void none.set(key, value) }, {});
  assert.equal(none.size, 0);
});

test("a group's stickers are found by its directory entry; a shared 1:1's are never read", async () => {
  const KEY = "a".repeat(64);
  const calls = [];
  const stub = {
    fetch: async (url, init = {}) => {
      const inbox = new Headers(init.headers).get("x-inbox-name");
      calls.push(`${new URL(String(url)).pathname} ${inbox}`);
      if (String(url).endsWith("/chat-where")) return Response.json({ groupId: "grp-1", line: "+15555550199" });
      return Response.json(KEPT);
    },
  };
  const env = { TEX_CHAT: { idFromName: (name) => name, get: () => stub } };
  assert.deepEqual(await stickersFor(env, {}, { group: true, source: "shared", chatKey: KEY }), { stickers: KEPT });
  assert.deepEqual(calls, [`/chat-call/chat-where group-key:${KEY}`, "/chat-call/stickers sendblue-group:grp-1"]);
  calls.length = 0;
  assert.deepEqual(await stickersFor(env, { phone: "+15555550101" }, { group: false, source: "shared", chatKey: null }), {});
  assert.deepEqual(calls, []);
  assert.deepEqual(await stickersFor(env, { phone: "+15555550101" }, { group: false, source: "mine", chatKey: null }), { stickers: KEPT });
  assert.deepEqual(calls, ["/chat-call/stickers +15555550101"]);
});
