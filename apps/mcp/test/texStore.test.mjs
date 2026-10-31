// Tex's notes in a Durable Object (src/texStore/): the objects over SQLite, the
// wire between gateway and object, and the gateway's ordinary R2 adapter on top.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects, CHUNK_BYTES, MAX_OBJECT_BYTES, TexObjectRefused } from "../src/texStore/objects.js";
import { serveTexStore, texBucket, ownerName, texStoreStub } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/** `node:sqlite` in the Durable Object's `sql.exec(...).toArray()` shape. */
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

function storeOver(objects) {
  const stub = { fetch: (request) => serveTexStore(objects, request) };
  return { bucket: texBucket(stub), store: new R2Store(texBucket(stub)) };
}

const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

test("a note written through the gateway's R2 adapter reads back with its etag, type and metadata", { skip }, async () => {
  const { store } = storeOver(texObjects(durableSql()));
  const written = await store.put("notes/0199a000-0000-7000-8000-000000000001.md", "# About me\n\nLikes tea.", {
    contentType: "text/markdown; charset=utf-8",
    customMetadata: { by: "tex" },
  });
  assert.match(written.etag, /^[0-9a-f]{32}$/);
  const read = await store.get("notes/0199a000-0000-7000-8000-000000000001.md");
  assert.equal(await read.text(), "# About me\n\nLikes tea.");
  assert.equal(read.etag, written.etag);
  assert.equal(read.httpEtag, `"${written.etag}"`);
  assert.equal(read.httpMetadata.contentType, "text/markdown; charset=utf-8");
  assert.deepEqual(read.customMetadata, { by: "tex" });
  assert.ok(read.uploaded instanceof Date);
  const head = await store.head("notes/0199a000-0000-7000-8000-000000000001.md");
  assert.equal(head.etag, written.etag);
  assert.equal(head.size, new TextEncoder().encode("# About me\n\nLikes tea.").byteLength);
  assert.equal(await store.get("notes/missing.md"), null);
  await store.put("notes/empty.md", "");
  const empty = await store.get("notes/empty.md");
  assert.equal(await empty.text(), "");
  assert.equal(empty.hasBody, undefined);
  assert.equal(await store.head("notes/missing.md"), null);
});

test("conditional writes hold: a stale etag and a create over an existing note both write nothing", { skip }, async () => {
  const { store } = storeOver(texObjects(durableSql()));
  const first = await store.put("notes/a.md", "one");
  assert.equal(await store.put("notes/a.md", "two", { onlyIf: { etagMatches: "0".repeat(32) } }), null);
  assert.equal(await store.put("notes/a.md", "two", { onlyIf: { absent: true } }), null);
  assert.equal(await (await store.get("notes/a.md")).text(), "one");
  const second = await store.put("notes/a.md", "two", { onlyIf: { etagMatches: first.etag } });
  assert.notEqual(second.etag, first.etag);
  assert.equal(await (await store.get("notes/a.md")).text(), "two");
  assert.ok(await store.put("notes/b.md", "new", { onlyIf: { absent: true } }));
  // Refused as R2Store refuses it: a condition with no etag is never last-writer-wins.
  await assert.rejects(store.put("notes/a.md", "three", { onlyIf: {} }));
});

test("a failed read condition answers the metadata alone, as R2 does", { skip }, async () => {
  const { bucket } = storeOver(texObjects(durableSql()));
  const written = await bucket.put("notes/a.md", "body");
  const unchanged = await bucket.get("notes/a.md", { onlyIf: { etagDoesNotMatch: written.etag } });
  assert.equal(unchanged.etag, written.etag);
  assert.equal(unchanged.body, undefined);
  const ranged = await bucket.get("notes/a.md", { range: { offset: 1, length: 2 } });
  assert.equal(await ranged.text(), "od");
});

test("a body over one chunk is split and joined back byte for byte", { skip }, async () => {
  const { store } = storeOver(texObjects(durableSql()));
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 17);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
  await store.put("files/0199a000-0000-7000-8000-000000000002.jpg", bytes, { contentType: "image/jpeg" });
  const read = new Uint8Array(await (await store.get("files/0199a000-0000-7000-8000-000000000002.jpg")).arrayBuffer());
  assert.equal(read.length, bytes.length);
  assert.deepEqual(read, bytes);
  // Overwriting with a shorter body leaves none of the old chunks behind.
  await store.put("files/0199a000-0000-7000-8000-000000000002.jpg", "x", { contentType: "image/jpeg" });
  assert.equal(await (await store.get("files/0199a000-0000-7000-8000-000000000002.jpg")).text(), "x");
});

test("an object over the cap is refused and nothing is kept", { skip }, async () => {
  const objects = texObjects(durableSql());
  await assert.rejects(objects.put("files/big.bin", new Uint8Array(MAX_OBJECT_BYTES + 1)), TexObjectRefused);
  assert.equal(objects.head("files/big.bin"), null);
  const { bucket } = storeOver(objects);
  await assert.rejects(bucket.put("files/big.bin", new Uint8Array(MAX_OBJECT_BYTES + 1)), TexObjectRefused);
});

test("listing pages in key order, folds a delimiter into prefixes, and stays inside the prefix", { skip }, async () => {
  const { store } = storeOver(texObjects(durableSql()));
  for (const key of ["notes/c.md", "notes/a.md", "notes/b.md", "files/x.png", ".context/tex/one.json", ".context/tex/two.json", ".context/z.json"]) {
    await store.put(key, key);
  }
  const first = await store.list({ prefix: "notes/", limit: 2 });
  assert.deepEqual(first.objects.map((object) => object.key), ["notes/a.md", "notes/b.md"]);
  assert.equal(first.truncated, true);
  const rest = await store.list({ prefix: "notes/", limit: 2, cursor: first.cursor });
  assert.deepEqual(rest.objects.map((object) => object.key), ["notes/c.md"]);
  assert.equal(rest.truncated, false);
  const folded = await store.list({ prefix: ".context/", delimiter: "/" });
  assert.deepEqual(folded.delimitedPrefixes, [".context/tex/"]);
  assert.deepEqual(folded.objects.map((object) => object.key), [".context/z.json"]);
  const all = await store.list({});
  assert.equal(all.objects.length, 7);
});

test("delete removes the keys given, and wipe removes everything", { skip }, async () => {
  const objects = texObjects(durableSql());
  const { store, bucket } = storeOver(objects);
  await store.put("notes/a.md", "a");
  await store.put("notes/b.md", "b");
  await store.delete("notes/a.md");
  await store.delete("notes/never.md");
  assert.equal(await store.get("notes/a.md"), null);
  assert.ok(await store.get("notes/b.md"));
  await bucket.wipe();
  assert.equal((await store.list({})).objects.length, 0);
});

test("each person and each group chat has a Durable Object of its own", () => {
  assert.equal(ownerName({ person: "w1" }), "person:w1");
  assert.equal(ownerName({ chat: "w1" }), "chat:w1");
  assert.notEqual(ownerName({ person: "w1" }), ownerName({ chat: "w1" }));
  assert.throws(() => ownerName({ person: "w1", chat: "c1" }));
  assert.throws(() => ownerName({ person: "" }));
  assert.throws(() => ownerName({}));
  const names = [];
  const env = { TEX_STORE: { idFromName: (name) => (names.push(name), name), get: (id) => ({ id }) } };
  assert.deepEqual(texStoreStub(env, { person: "w1" }), { id: "person:w1" });
  assert.equal(texStoreStub({}, { person: "w1" }), null);
});
