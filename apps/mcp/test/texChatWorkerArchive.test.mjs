/**
 * A SEALED COPY OF A WORKER CHAT BOX NO NAME LEADS TO (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX; Dev2 2026-11-23: archive the leftovers before the Worker's
 * SenderInbox class is deleted). The Worker hands each box to `TexTexts` `/texts/worker-archive`, which keeps it whole in
 * `archive:<id>`. What these prove: a box is kept once and never replaced, nothing answers its values, a malformed id
 * or body is refused, and a chat object never answers the archive route.
 *
 * Sabotage checked (each reverted, 2026-11-23): `serveArchive` replacing a kept archive fails "kept once"; GET
 * answering the entries fails "never answers a value"; the `TexChat` route ignoring the name fails "a chat object".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { texChatClass } from "../../../packages/tex/gateway/texChat.js";
import { archiveForTexts } from "../../../packages/tex/gateway/texChat/workerArchive.js";

const ID = "c".repeat(64);
const PHONE = "+15555550100";

function storage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) map.set(k, v);
      else map.set(key, value);
    },
    delete: async (key) => map.delete(key),
    list: async () => new Map(map),
  };
}

function gateway() {
  const TexChat = texChatClass({ gateway: () => ({ fetch: async () => new Response(null) }), texts: () => ({ fetch: async () => new Response(null) }) });
  const objects = new Map();
  const env = {};
  env.TEX_CHAT = {
    idFromName: (name) => ({ name }),
    get: (id) => {
      if (!objects.has(id.name)) objects.set(id.name, { store: storage(), object: null });
      const entry = objects.get(id.name);
      entry.object ??= new TexChat({ storage: entry.store, waitUntil() {}, blockConcurrencyWhile: (run) => run() }, env);
      return { fetch: async (input, init) => await entry.object.fetch(input instanceof Request ? input : new Request(input, init)) };
    },
  };
  const door = (body) => archiveForTexts(new Request("https://gateway/texts/worker-archive", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), env);
  const ask = (name, init) => env.TEX_CHAT.get({ name }).fetch("https://chat/worker-archive", { ...init, headers: { "x-inbox-name": name, ...(init?.headers ?? {}) } });
  return { env, objects, door, ask };
}

describe("a Worker chat box's archive", () => {
  it("is kept once, whole, and never replaced", async () => {
    const g = gateway();
    const first = await g.door({ id: ID, entries: [["chat", { chatId: `sendblue:+15555550199:${PHONE}` }], ["seq", 4]] });
    assert.deepEqual(await first.json(), { kept: true, keys: 2 });
    const second = await g.door({ id: ID, entries: [["chat", "other"]] });
    assert.deepEqual(await second.json(), { kept: true, already: true, keys: 2 });
    const kept = g.objects.get(`archive:${ID}`).store.map;
    assert.deepEqual(kept.get("a:chat"), { chatId: `sendblue:+15555550199:${PHONE}` });
    assert.equal(kept.get("a:seq"), 4);
  });

  it("never answers a value", async () => {
    const g = gateway();
    await g.door({ id: ID, entries: [["chat", { chatId: PHONE }]] });
    const read = await g.ask(`archive:${ID}`);
    const text = await read.text();
    assert.equal(read.status, 200);
    assert.ok(!text.includes(PHONE));
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["at", "kept", "keys"]);
    assert.equal((await g.ask(`archive:${ID}`, { method: "DELETE" })).status, 405);
  });

  it("refuses a malformed id or body", async () => {
    const g = gateway();
    assert.equal((await g.door({ id: "../x", entries: [["k", 1]] })).status, 400);
    assert.equal((await g.door({ id: ID, entries: [] })).status, 400);
    assert.equal((await g.door({ id: ID, entries: [["k", 1], ["k", 2]] })).status, 400);
    assert.equal((await g.door("not json")).status, 400);
    assert.equal(g.objects.has(`archive:${ID}`), false);
  });

  it("a chat object never answers the archive route, and an archive answers nothing else", async () => {
    const g = gateway();
    const chat = await g.env.TEX_CHAT.get({ name: `chat:${PHONE}` }).fetch("https://chat/worker-archive", { method: "POST", headers: { "x-inbox-name": PHONE }, body: JSON.stringify({ entries: [["k", 1]] }) });
    assert.notEqual(chat.status, 200);
    assert.equal(g.objects.get(`chat:${PHONE}`).store.map.has("a:k"), false);
    await g.door({ id: ID, entries: [["k", 1]] });
    const other = await g.env.TEX_CHAT.get({ name: `archive:${ID}` }).fetch("https://chat/home", { headers: { "x-inbox-name": `archive:${ID}` } });
    assert.equal(other.status, 404);
  });
});
