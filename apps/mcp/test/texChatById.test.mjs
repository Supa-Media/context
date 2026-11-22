/**
 * A CHAT FOUND BY THE ID ITS ADDRESSES CARRY (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX, 2026-11-22).
 *
 * A picture Tex sends (`/media/<id>/<token>`) and a chat's jobs page (`/threads/<id>/<token>`) name the chat by its
 * object id in the texting Worker. Before that object is deleted, the gateway keeps an index, `byid:<id>` -> the chat's
 * name, written when a chat here is asked its home (the intake sweep) or opened, and the Worker's `/media` and
 * `/threads` ask `TexTexts` `/texts/chat-by-id/<id>/...`, which hands the call to the chat's own object.
 *
 * Sabotage checked (each reverted): `/home` not calling `indexChat` fails "a chat asked its home is indexed";
 * `serveById` replacing a kept name fails "an id belongs to one chat"; `BY_ID_CALLS` accepting any path fails "only a
 * picture or a jobs page".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { texChatClass } from "../../../packages/tex/gateway/texChat.js";
import { chatByIdForTexts } from "../../../packages/tex/gateway/texChat/byId.js";

const PHONE = "+15555550100";
const ID = "c".repeat(64);
const TOKEN = "d".repeat(64);

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { map, get: async (key) => map.get(key), put: async (key, value) => void map.set(key, value), delete: async (key) => map.delete(key) };
}

/** The gateway's `TEX_CHAT`: real `TexChat` objects by name; a chat's `/chat-call` is recorded, not opened. */
function gateway() {
  const TexChat = texChatClass({ gateway: () => ({ fetch: async () => new Response(null) }), texts: () => ({ fetch: async () => new Response(null) }) });
  const objects = new Map();
  const calls = [];
  const env = {};
  env.TEX_CHAT = {
    idFromName: (name) => ({ name }),
    get: (id) => {
      if (!objects.has(id.name)) objects.set(id.name, { store: storage(), object: null });
      const entry = objects.get(id.name);
      entry.object ??= new TexChat({ storage: entry.store, waitUntil() {}, blockConcurrencyWhile: (run) => run() }, env);
      return {
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.startsWith("/chat-call/")) {
            calls.push(`${id.name} ${path} ${request.headers.get("x-inbox-name")}`);
            return new Response("picture", { status: 200 });
          }
          return await entry.object.fetch(request);
        },
      };
    },
  };
  /** A chat already copied in, as the intake sweep left it. */
  const moved = (name, senderId) =>
    objects.set(`chat:${name}`, { store: storage({ __inbox_place: { arrivedAt: 5, keys: 3 }, __inbox_name: name, __sender_id: senderId }), object: null });
  const door = (path, method = "GET") => chatByIdForTexts(new Request(`https://gateway/texts/chat-by-id/${path}`, { method }), env);
  return { env, objects, calls, moved, door };
}

describe("a chat by its id", () => {
  it("a chat asked its home is indexed, once, and the door hands a picture to it by name", async () => {
    const g = gateway();
    g.moved(PHONE, ID);
    assert.equal((await g.door(`${ID}/media/${TOKEN}`)).status, 404, "nothing indexed yet");
    const home = await g.env.TEX_CHAT.get({ name: `chat:${PHONE}` }).fetch("https://chat/home");
    assert.equal((await home.json()).home, "gateway");
    assert.equal(g.objects.get(`byid:${ID}`).store.map.get("__inbox_name"), PHONE);
    assert.equal(g.objects.get(`chat:${PHONE}`).store.map.get("__by_id_indexed"), true);
    const picture = await g.door(`${ID}/media/${TOKEN}`);
    assert.equal(await picture.text(), "picture");
    await g.door(`${ID}/threads/${TOKEN}`);
    assert.deepEqual(g.calls, [`chat:${PHONE} /chat-call/media/${TOKEN} ${PHONE}`, `chat:${PHONE} /chat-call/threads/${TOKEN} ${PHONE}`]);
  });

  it("a chat still in the Worker, or one with no Worker id (an app chat), is not indexed", async () => {
    const g = gateway();
    await g.env.TEX_CHAT.get({ name: `chat:${PHONE}` }).fetch("https://chat/home");
    g.moved("app:u_1", "");
    await g.env.TEX_CHAT.get({ name: "chat:app:u_1" }).fetch("https://chat/home");
    assert.deepEqual([...g.objects.keys()].filter((name) => name.startsWith("byid:")), []);
  });

  it("an id belongs to one chat: a second name is refused and the first kept", async () => {
    const g = gateway();
    const index = g.env.TEX_CHAT.get({ name: `byid:${ID}` });
    const post = (name) => index.fetch("https://chat/by-id", { method: "POST", headers: { "x-inbox-name": `byid:${ID}` }, body: JSON.stringify({ name }) });
    assert.equal((await post(PHONE)).status, 200);
    assert.equal((await post(PHONE)).status, 200, "the same name again is fine");
    assert.equal((await post("+15555550101")).status, 409);
    assert.equal(g.objects.get(`byid:${ID}`).store.map.get("__inbox_name"), PHONE);
    assert.equal((await post("../x")).status, 400);
  });

  it("only a picture or a jobs page, by GET, with a well-formed id", async () => {
    const g = gateway();
    g.moved(PHONE, ID);
    await g.env.TEX_CHAT.get({ name: `chat:${PHONE}` }).fetch("https://chat/home");
    assert.equal((await g.door(`${ID}/accept`)).status, 404);
    assert.equal((await g.door(`${ID}/media/${TOKEN}/../x`)).status, 404);
    assert.equal((await g.door(`${ID.slice(1)}/media/${TOKEN}`)).status, 404);
    assert.equal((await g.door(`${ID}/media/${TOKEN}`, "POST")).status, 405);
    assert.deepEqual(g.calls, []);
  });

  it("a chat object never answers the index route, so a chat's name can't be read or set through it", async () => {
    const g = gateway();
    g.moved(PHONE, ID);
    const chat = g.env.TEX_CHAT.get({ name: `chat:${PHONE}` });
    const answer = await chat.fetch("https://chat/by-id", { headers: { "x-inbox-name": PHONE } });
    assert.equal(answer.status, 404);
  });
});
