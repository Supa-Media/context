// A group chat's memory record lives in the chat's own Durable Object when the
// grant names the chat (src/agent/chatMemoryRecord.js): one per chat, moved in
// once from the bucket's old copy, never written to the bucket, and kept
// nowhere when the object cannot be reached.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { serveTexStore, texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { storeForBinding } from "../src/store/factory.js";
import { TexStoreUnavailable, splitTexKey, texStateKeyFor } from "../src/store/texRouting.js";
import { isIdKey, isPlumbing, isTexKey, isTexStateKey } from "../src/privacy/engine.js";
import { handleTexStoreDoor } from "../src/texStore/door.js";
import { CHAT_MEMORY_NAME } from "../src/agent/chatMemoryRecord.js";
import { GROUP_MEMORY_PREFIX, groupMemoryPath, keepGroupExchange, readGroupMemory } from "../src/agent/groupTurn.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

const KEY = "a".repeat(64);
const OTHER = "d".repeat(64);
const MEMBERS = "b".repeat(64);
const STATE = `tex/chat:${KEY}/state/${CHAT_MEMORY_NAME}.json`;
const group = (extra = {}) => ({ key: KEY, members: MEMBERS, from: "ada", people: ["ada"], chat: [], ...extra });

/** A bucket and per-owner objects; the store a group turn's session would be built with for `chats`. */
function world({ chats = [KEY], reachable = true } = {}) {
  const bucketObjects = texObjects(durableSql());
  const bucket = texBucket({ fetch: (request) => serveTexStore(bucketObjects, request) });
  const objects = new Map();
  const texStore = (owner) => {
    if (!reachable) return null;
    if (!objects.has(owner)) objects.set(owner, texObjects(durableSql()));
    const held = objects.get(owner);
    return new R2Store(texBucket({ fetch: (request) => serveTexStore(held, request) }));
  };
  const env = { NATIVE_BINDINGS: "BUCKET", BUCKET: bucket };
  const binding = { provider: "r2-binding", bindingName: "BUCKET", workspaceId: "w1", conditionalWrite: true, conditionalCreate: true };
  const store = storeForBinding(binding, env, { texStore, texChats: chats });
  const bucketKeys = () => bucketObjects.list({}).objects.map((object) => object.key);
  const objectKeys = (owner) => (objects.get(owner)?.list({}).objects ?? []).map((object) => object.key);
  return { store, bucketObjects, objects, bucketKeys, objectKeys };
}

const record = (text) => JSON.stringify({ version: 1, turns: [{ role: "user", text }, { role: "assistant", text: "Noted." }] });

/** console.log, captured for one call. */
async function logged(run) {
  const lines = [];
  const previous = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { value: await run(), lines };
  } finally {
    console.log = previous;
  }
}

test("a chat's state key is plumbing, never an id key, and only a chat has one", () => {
  assert.equal(isTexStateKey(STATE), true);
  assert.equal(isPlumbing(STATE), true, "no listing, search or tree sweep shows it");
  assert.equal(isIdKey(STATE), false, "no row ever names it");
  assert.equal(isTexKey(STATE), false);
  assert.equal(isTexStateKey(`tex/person:w1/state/${CHAT_MEMORY_NAME}.json`), false);
  assert.equal(isTexStateKey(`tex/chat:${KEY}/state/memory.json`), false);
  assert.equal(isTexStateKey(`tex/chat:${KEY}/state/${CHAT_MEMORY_NAME}.md`), false);
  assert.deepEqual(splitTexKey(STATE), { owner: `chat:${KEY}`, key: `state/${CHAT_MEMORY_NAME}.json` });
  assert.equal(texStateKeyFor(KEY, CHAT_MEMORY_NAME), STATE);
  assert.throws(() => texStateKeyFor(KEY, "memory"));
  assert.throws(() => texStateKeyFor("a/b", CHAT_MEMORY_NAME));
});

test("another chat's, a person's or a misshapen state key is refused, never sent to the bucket", { skip }, async () => {
  const { store, bucketKeys, objectKeys } = world();
  for (const key of [
    `tex/chat:${OTHER}/state/${CHAT_MEMORY_NAME}.json`,
    `tex/person:w1/state/${CHAT_MEMORY_NAME}.json`,
    `tex/chat:${KEY}/state/memory.json`,
    `tex/chat:${KEY}/state/x/${CHAT_MEMORY_NAME}.json`,
  ]) {
    await assert.rejects(store.put(key, "{}"), TexStoreUnavailable, key);
    await assert.rejects(store.get(key), TexStoreUnavailable, key);
  }
  assert.deepEqual(bucketKeys(), []);
  await store.put(STATE, "{}");
  assert.equal(await (await store.get(STATE)).text(), "{}");
  assert.deepEqual(objectKeys(`chat:${KEY}`), [`state/${CHAT_MEMORY_NAME}.json`], "kept in the chat's own object");
  assert.deepEqual(bucketKeys(), []);
});

test("a person's store, built for no chat, cannot reach a chat's state", { skip }, async () => {
  const { store } = world({ chats: [] });
  await assert.rejects(store.get(STATE), TexStoreUnavailable);
});

test("a group turn keeps its record in the chat's object, one per chat, and nothing in the bucket", { skip }, async () => {
  const { store, bucketKeys, objectKeys } = world();
  await keepGroupExchange(store, group(), [], "the gig is friday", "Noted: Friday.");
  assert.deepEqual(objectKeys(`chat:${KEY}`), [`state/${CHAT_MEMORY_NAME}.json`]);
  assert.deepEqual(bucketKeys().filter((key) => key.startsWith(GROUP_MEMORY_PREFIX)), []);
  // Somebody added to the chat reads what it kept (the owner, 2026-10-31).
  const joined = await readGroupMemory(store, group({ members: "c".repeat(64) }));
  assert.match(JSON.stringify(joined), /the gig is friday/);
});

test("the bucket's old copy is moved in once: written, read back the same, then deleted; again is a no-op", { skip }, async () => {
  const { store, bucketKeys, objectKeys } = world();
  const legacy = await groupMemoryPath(group());
  await store.put(legacy, record("@ada: load-in is at 6"));
  const first = await readGroupMemory(store, group());
  assert.match(JSON.stringify(first), /load-in is at 6/);
  assert.equal(await (await store.get(STATE)).text(), record("@ada: load-in is at 6"));
  assert.deepEqual(bucketKeys().filter((key) => key.startsWith(GROUP_MEMORY_PREFIX)), [], "the bucket copy is gone");
  const again = await readGroupMemory(store, group());
  assert.deepEqual(again, first);
  assert.deepEqual(objectKeys(`chat:${KEY}`), [`state/${CHAT_MEMORY_NAME}.json`]);
  // The record is one per chat (the owner, 2026-10-31): the same bucket name for anybody added, and a copy left there is not read once the chat has its record.
  assert.equal(await groupMemoryPath(group({ members: "e".repeat(64) })), legacy);
  await store.put(legacy, record("@bo: from before"));
  assert.doesNotMatch(JSON.stringify(await readGroupMemory(store, group({ members: "e".repeat(64) }))), /from before/);
  assert.ok(bucketKeys().includes(legacy), "left in place, as the chat's record was already kept elsewhere");
});

test("a move whose read-back differs keeps the bucket copy", { skip }, async () => {
  const { store, bucketKeys } = world();
  const legacy = await groupMemoryPath(group());
  await store.put(legacy, record("@ada: keep me"));
  // The object answers other bytes than were written to it: never delete what was not seen to arrive.
  const garbling = Object.create(store);
  garbling.put = (key, body, options) => store.put(key, key === STATE ? `${body} ` : body, options);
  const { lines } = await logged(() => readGroupMemory(garbling, group()));
  assert.ok(bucketKeys().includes(legacy), "the bucket copy is kept");
  assert.ok(lines.some((line) => /group_memory_move_unverified/.test(line)));
});

test("an unreachable object keeps nothing, writes nothing to the bucket and leaves the old copy", { skip }, async () => {
  const { store, bucketKeys } = world({ reachable: false });
  const legacy = await groupMemoryPath(group());
  await store.put(legacy, record("@ada: old"));
  const { value: history, lines } = await logged(() => readGroupMemory(store, group()));
  assert.deepEqual(history, []);
  const before = bucketKeys();
  const { lines: written } = await logged(() => keepGroupExchange(store, group(), [], "the gig is friday", "Noted."));
  assert.deepEqual(bucketKeys(), before, "nothing new in the bucket");
  assert.equal(await (await store.get(legacy)).text(), record("@ada: old"), "the old copy untouched");
  const all = [...lines, ...written];
  for (const line of all) assert.doesNotMatch(line, /a{64}|\.context|tex\/|gig|old/, "no key, path or words");
  // The read, the read again just before the write (`keepGroupExchange`), and no write over a record it could not read.
  assert.deepEqual(all.map((line) => JSON.parse(line)), [
    { event: "group_memory_not_kept", step: "read", reason: "tex_store_unavailable" },
    { event: "group_memory_not_kept", step: "read", reason: "tex_store_unavailable" },
    { event: "group_exchange_not_kept", reason: "record_unreadable" },
  ]);
});

test("a store built for another chat keeps nothing for this one and never touches its bucket copy", { skip }, async () => {
  const { store, bucketKeys, objectKeys } = world({ chats: [OTHER] });
  const legacy = await groupMemoryPath(group());
  await store.put(legacy, record("@ada: ours"));
  const { value } = await logged(() => readGroupMemory(store, group()));
  assert.deepEqual(value, []);
  await logged(() => keepGroupExchange(store, group(), [], "q", "a"));
  assert.ok(bucketKeys().includes(legacy));
  assert.deepEqual(objectKeys(`chat:${OTHER}`), []);
});

test("the control plane's door reaches a chat's state in that chat's object, as it does a note", { skip }, async () => {
  const objects = texObjects(durableSql());
  const named = [];
  const env = {
    GATEWAY_SECRET: "fake-gateway-secret",
    TEX_STORE: {
      idFromName: (name) => (named.push(name), name),
      get: () => ({ fetch: (request) => serveTexStore(objects, request) }),
    },
  };
  const controlPlane = { openTexStoreTicket: async () => ({ workspaceId: "w1", owners: [`chat:${KEY}`] }) };
  const call = (op, body) =>
    handleTexStoreDoor(
      new Request("https://gateway.test/internal/tex-store", {
        method: "POST",
        headers: {
          authorization: "Bearer fake-gateway-secret",
          "x-tex-ticket": "fake-ticket",
          "x-tex-owner": `chat:${KEY}`,
          "x-tex-call": encodeURIComponent(JSON.stringify({ op, key: `state/${CHAT_MEMORY_NAME}.json`, options: {} })),
        },
        body,
      }),
      env,
      { controlPlane },
    );
  assert.equal((await call("put", record("@ada: hi"))).status, 200);
  assert.equal(await (await call("get")).text(), record("@ada: hi"));
  assert.deepEqual(named, [`chat:${KEY}`, `chat:${KEY}`]);
});
