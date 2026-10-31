// A row's key of the Tex form reaches its Durable Object, never the bucket
// (src/store/texRouting.js), through the store every request is built with.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { serveTexStore, texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { storeForBinding } from "../src/store/factory.js";
import { withIdLayout } from "../src/store/idLayout.js";
import { splitTexKey, texKeyFor, TexStoreUnavailable } from "../src/store/texRouting.js";
import { isIdKey, isPlumbing, isTexKey } from "../src/privacy/engine.js";

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

/** A bucket binding and per-owner Tex objects, each an R2-shaped SQLite, so every byte's home can be checked. */
function world() {
  const bucketObjects = texObjects(durableSql());
  const bucket = texBucket({ fetch: (request) => serveTexStore(bucketObjects, request) });
  const objects = new Map();
  const opened = [];
  const texStore = (owner) => {
    opened.push(owner);
    if (!objects.has(owner)) objects.set(owner, texObjects(durableSql()));
    const held = objects.get(owner);
    return new R2Store(texBucket({ fetch: (request) => serveTexStore(held, request) }));
  };
  const env = { NATIVE_BINDINGS: "BUCKET", BUCKET: bucket };
  const binding = { provider: "r2-binding", bindingName: "BUCKET", workspaceId: "w1", conditionalWrite: true, conditionalCreate: true };
  return { bucketObjects, objects, opened, texStore, env, binding };
}

const NOTE = "0199a000-0000-7000-8000-00000000000a";
const TEX = `tex/person:w1/notes/${NOTE}.md`;

test("a Tex key is an id key, plumbing that no listing shows, and splits into its owner and the key inside", () => {
  assert.equal(isTexKey(TEX), true);
  assert.equal(isIdKey(TEX), true);
  assert.equal(isPlumbing(TEX), true);
  assert.equal(isTexKey(`tex/notes/${NOTE}.md`), false);
  assert.equal(isTexKey(`tex/someone:w1/notes/${NOTE}.md`), false);
  assert.equal(isTexKey("tex/person:w1/about-me.md"), false);
  assert.deepEqual(splitTexKey(TEX), { owner: "person:w1", key: `notes/${NOTE}.md` });
  assert.equal(texKeyFor("chat:c9", `notes/${NOTE}.md`), `tex/chat:c9/notes/${NOTE}.md`);
  assert.throws(() => texKeyFor("person:w1", "about-me.md"));
});

test("through the store a request is built with, a Tex key's bytes live in the person's object and never the bucket", { skip }, async () => {
  const { bucketObjects, objects, env, binding, texStore } = world();
  const store = storeForBinding(binding, env, { texStore });
  await store.put(TEX, "# About me", { contentType: "text/markdown; charset=utf-8" });
  await store.put(`notes/${NOTE}.md`, "a bucket note", { contentType: "text/markdown; charset=utf-8" });
  assert.equal(await (await store.get(TEX)).text(), "# About me");
  assert.equal(await (await store.get(`notes/${NOTE}.md`)).text(), "a bucket note");
  assert.deepEqual(bucketObjects.list({}).objects.map((object) => object.key), [`notes/${NOTE}.md`]);
  assert.deepEqual(objects.get("person:w1").list({}).objects.map((object) => object.key), [`notes/${NOTE}.md`]);
  assert.equal((await store.head(TEX)).size, "# About me".length);
  await store.delete(TEX);
  assert.equal(await store.get(TEX), null);
  assert.equal(await (await store.get(`notes/${NOTE}.md`)).text(), "a bucket note");
});

test("a key naming another workspace's Tex is refused, and nothing reaches any object", { skip }, async () => {
  const { env, binding, texStore, opened } = world();
  const store = storeForBinding(binding, env, { texStore });
  await assert.rejects(store.get(`tex/person:w2/notes/${NOTE}.md`), TexStoreUnavailable);
  await assert.rejects(store.put(`tex/person:w2/notes/${NOTE}.md`, "x"), TexStoreUnavailable);
  await assert.rejects(store.get(`tex/chat:c1/notes/${NOTE}.md`), TexStoreUnavailable);
  assert.deepEqual(opened, []);
  // A group chat the store was built for is reachable.
  const withChat = storeForBinding(binding, env, { texStore, texChats: ["c1"] });
  await withChat.put(`tex/chat:c1/notes/${NOTE}.md`, "group");
  assert.deepEqual(opened, ["chat:c1"]);
});

test("without a way to reach the object a Tex key fails closed, never read from the bucket", { skip }, async () => {
  const { bucketObjects, env, binding } = world();
  // Bytes at the same key in the bucket must never be served as the note.
  await bucketObjects.put(TEX, "planted");
  const store = storeForBinding(binding, env, {});
  await assert.rejects(store.get(TEX), TexStoreUnavailable);
  await assert.rejects(store.put(TEX, "x"), TexStoreUnavailable);
  const nothing = storeForBinding(binding, env, { texStore: () => null });
  await assert.rejects(nothing.get(TEX), TexStoreUnavailable);
});

test("the id layer reads and writes a note whose row is keyed in Tex's object", { skip }, async () => {
  const { objects, env, binding, texStore } = world();
  const base = storeForBinding(binding, env, { texStore });
  const first = await base.put(TEX, "Likes tea.");
  const row = { state: "keyed", noteId: NOTE, key: TEX, etag: first.etag };
  const reported = [];
  const store = withIdLayout(base, {
    lookup: async (paths) => ({ keyed: true, notes: Object.fromEntries(paths.filter((path) => path === "tex/about-me.md").map((path) => [path, row])) }),
    wrote: async (record) => {
      reported.push(record);
      row.etag = record.etag;
    },
    adopt: async () => ({ adopted: false, taken: null }),
    removed: async () => {},
  });
  assert.equal(await (await store.get("tex/about-me.md")).text(), "Likes tea.");
  // A stale version is refused there, as in the bucket.
  assert.equal(await store.put("tex/about-me.md", "stale", { onlyIf: { etagMatches: "0".repeat(32) } }), null);
  await store.put("tex/about-me.md", "Likes tea and rain.", { onlyIf: { etagMatches: first.etag } });
  assert.equal(await (await store.get("tex/about-me.md")).text(), "Likes tea and rain.");
  assert.equal(reported[0].key, TEX);
  assert.equal(objects.get("person:w1").list({}).objects.length, 1);
});

test("a listing under the owner's prefix is the object's, keys given back in the Tex form", { skip }, async () => {
  const { env, binding, texStore } = world();
  const store = storeForBinding(binding, env, { texStore });
  await store.put(TEX, "a");
  await store.put(`notes/${NOTE}.md`, "b");
  const page = await store.list({ prefix: "tex/person:w1/" });
  assert.deepEqual(page.objects.map((object) => object.key), [TEX]);
  const bucket = await store.list({ prefix: "notes/" });
  assert.deepEqual(bucket.objects.map((object) => object.key), [`notes/${NOTE}.md`]);
  await assert.rejects(store.list({ prefix: "tex/person:w2/" }), TexStoreUnavailable);
});

test("a new note where the tree says Tex keeps it is written to the person's object under a Tex key, and adopted with it", { skip }, async () => {
  const { bucketObjects, objects, env, binding, texStore } = world();
  const base = storeForBinding(binding, env, { texStore });
  const adopted = [];
  const store = withIdLayout(base, {
    lookup: async (paths) => ({
      keyed: true,
      notes: {},
      texHomes: Object.fromEntries(paths.filter((path) => path.startsWith("tex/")).map((path) => [path, "person:w1"])),
    }),
    wrote: async () => {},
    adopt: async (note) => (adopted.push(note), { adopted: true }),
    removed: async () => {},
  });
  await store.put("tex/attention.md", "watch the oven", { contentType: "text/markdown; charset=utf-8" });
  await store.put("projects/plan.md", "a plan", { contentType: "text/markdown; charset=utf-8" });
  assert.match(adopted[0].key, new RegExp(`^tex/person:w1/notes/${adopted[0].noteId}\\.md$`));
  assert.equal(adopted[1].key, `notes/${adopted[1].noteId}.md`);
  assert.deepEqual(objects.get("person:w1").list({}).objects.map((object) => object.key), [`notes/${adopted[0].noteId}.md`]);
  assert.deepEqual(bucketObjects.list({}).objects.map((object) => object.key), [`notes/${adopted[1].noteId}.md`]);
});
