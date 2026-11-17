// Tex's notes in a Durable Object (src/texStore/): the objects over SQLite, the
// wire between gateway and object, and the gateway's ordinary R2 adapter on top.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects, CHUNK_BYTES, MAX_LIST, MAX_OBJECT_BYTES, TexObjectRefused } from "../src/texStore/objects.js";
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
  const sql = {
    db,
    /** List queries, in the order `list` ran them, so a test can EXPLAIN them. */
    queries: [],
    exec(query, ...binds) {
      if (/ORDER BY key LIMIT/.test(query)) sql.queries.push({ query, binds });
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
  return sql;
}

/** The plans of the list queries recorded since the last check. */
function listPlans(sql) {
  const plans = sql.queries.map(({ query, binds }) => ({
    query,
    binds,
    detail: sql.db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...binds)
      .map((row) => row.detail)
      .join("\n"),
  }));
  sql.queries.length = 0;
  return plans;
}

/**
 * A prefixed list must seek the primary-key index on both sides. `substr(key, 1, n) = prefix`
 * is still a SEARCH, but only on `key > cursor`, so it reads every later row. Two lower
 * bounds in one statement seek at the cursor, and an empty cursor is the start of the table.
 */
function assertBoundedKeySearch(sql) {
  const plans = listPlans(sql);
  assert.ok(plans.length > 0, "list ran no query");
  for (const plan of plans) {
    assert.doesNotMatch(plan.query, /substr\s*\(/i);
    assert.match(plan.detail, /SEARCH objects USING INDEX sqlite_autoindex_objects_1/);
    assert.match(plan.detail, /key</);
    assert.doesNotMatch(plan.detail, /\bSCAN\b/);
    const seek = sql.db
      .prepare(`EXPLAIN ${plan.query}`)
      .all(...plan.binds)
      .find((row) => String(row.opcode).startsWith("Seek"));
    if (/WHERE key >= \? AND key < \?/.test(plan.query)) assert.equal(seek.opcode, "SeekGE");
    else if (/WHERE key > \? AND key < \?/.test(plan.query)) assert.equal(seek.opcode, "SeekGT");
    else assert.fail(plan.query);
  }
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

test("a prefix list seeks the primary key, folds common prefixes, and does not take a neighbour", { skip }, async () => {
  const sql = durableSql();
  const objects = texObjects(sql);
  for (const key of ["p/a/1", "p/a/2", "p/b/1", "p/c", "p/a0", "p0/x", "exact", "exact/child", "exact0"]) {
    await objects.put(key, key);
  }
  const folded = objects.list({ prefix: "p/", delimiter: "/" });
  assert.deepEqual(folded.delimitedPrefixes, ["p/a/", "p/b/"]);
  assert.deepEqual(
    folded.objects.map((object) => object.key),
    ["p/a0", "p/c"],
  );
  assert.equal(folded.truncated, false);
  assert.equal(folded.cursor, undefined);
  assertBoundedKeySearch(sql);

  const slash = objects.list({ prefix: "a/" });
  assert.deepEqual(
    slash.objects.map((object) => object.key),
    [],
  );
  assertBoundedKeySearch(sql);
  const neighbour = objects.list({ prefix: "p/a/" });
  assert.deepEqual(
    neighbour.objects.map((object) => object.key),
    ["p/a/1", "p/a/2"],
  );
  const beside = objects.list({ prefix: "p/a0" });
  assert.deepEqual(
    beside.objects.map((object) => object.key),
    ["p/a0"],
  );
  // "exact" is a prefix of "exact0". The slash is what holds "exact/" back from it.
  const exact = objects.list({ prefix: "exact" });
  assert.deepEqual(
    exact.objects.map((object) => object.key),
    ["exact", "exact/child", "exact0"],
  );
  assert.deepEqual(
    objects.list({ prefix: "exact/" }).objects.map((object) => object.key),
    ["exact/child"],
  );
  assert.deepEqual(objects.list({ prefix: "no/such/" }).objects, []);
  assert.equal(objects.list({ prefix: "no/such/" }).truncated, false);

  // A folder of more than one page, then a neighbour the sentinel must not swallow.
  for (let i = 0; i < MAX_LIST + 1; i += 1) await objects.put(`dir/fold/${String(i).padStart(4, "0")}`, "x");
  await objects.put("dir/fold0", "n");
  await objects.put("dir/other/a", "o");
  await objects.put("dir/z", "z");
  sql.queries.length = 0;
  const deep = objects.list({ prefix: "dir/", delimiter: "/" });
  assert.deepEqual(deep.delimitedPrefixes, ["dir/fold/", "dir/other/"]);
  assert.deepEqual(
    deep.objects.map((object) => object.key),
    ["dir/fold0", "dir/z"],
  );
  assert.equal(deep.truncated, false);
  assertBoundedKeySearch(sql);
});

test("a cursor pages past a thousand keys, and an empty prefix stays a primary-key search", { skip }, async () => {
  const sql = durableSql();
  const objects = texObjects(sql);
  for (let i = 0; i < MAX_LIST + 1; i += 1) await objects.put(`notes/${String(i).padStart(4, "0")}.md`, "x");
  await objects.put("notes-extra.md", "x");
  const first = objects.list({ prefix: "notes/" });
  assert.equal(first.objects.length, MAX_LIST);
  assert.equal(first.truncated, true);
  assert.equal(first.cursor, "notes/0999.md");
  assert.deepEqual(
    first.objects.map((object) => object.key),
    Array.from({ length: MAX_LIST }, (_, i) => `notes/${String(i).padStart(4, "0")}.md`),
  );
  const second = objects.list({ prefix: "notes/", cursor: first.cursor });
  assert.deepEqual(
    second.objects.map((object) => object.key),
    ["notes/1000.md"],
  );
  assert.equal(second.truncated, false);
  assert.equal(second.cursor, undefined);
  // A cursor wins over startAfter, and does not repeat or skip.
  const fromCursor = objects.list({ prefix: "notes/", cursor: "notes/0998.md", startAfter: "notes/0000.md" });
  assert.equal(fromCursor.objects[0].key, "notes/0999.md");
  assertBoundedKeySearch(sql);

  sql.queries.length = 0;
  const all = objects.list({});
  assert.equal(all.objects.length, MAX_LIST);
  assert.equal(all.truncated, true);
  assert.equal(all.objects[0].key, "notes-extra.md");
  const plans = listPlans(sql);
  assert.equal(plans.length, 1);
  assert.match(plans[0].query, /key > \? AND key >= \? ORDER BY key/);
  assert.doesNotMatch(plans[0].query, /key < \?/);
  assert.doesNotMatch(plans[0].query, /substr\s*\(/i);
  assert.match(plans[0].detail, /SEARCH objects USING (COVERING )?INDEX sqlite_autoindex_objects_1/);
  assert.doesNotMatch(plans[0].detail, /\bSCAN\b/);
});

test("non-ASCII keys stay inside their prefix, and startAfter outside it does not leak in", { skip }, async () => {
  const sql = durableSql();
  const objects = texObjects(sql);
  for (const key of ["notes/cafe.md", "notes/café.md", "notes/東京.md", "notes/😀.md", "a/1", "a/2", "a0", "b/1"]) {
    await objects.put(key, key);
  }
  assert.deepEqual(
    objects.list({ prefix: "notes/café" }).objects.map((object) => object.key),
    ["notes/café.md"],
  );
  assert.deepEqual(
    objects.list({ prefix: "notes/東" }).objects.map((object) => object.key),
    ["notes/東京.md"],
  );
  assert.deepEqual(
    objects.list({ prefix: "notes/😀" }).objects.map((object) => object.key),
    ["notes/😀.md"],
  );
  assert.deepEqual(
    objects.list({ prefix: "notes/caf" }).objects.map((object) => object.key),
    ["notes/cafe.md", "notes/café.md"],
  );
  assert.deepEqual(
    objects.list({ prefix: "a/", startAfter: "0" }).objects.map((object) => object.key),
    ["a/1", "a/2"],
  );
  assert.deepEqual(objects.list({ prefix: "a/", startAfter: "a0" }).objects, []);
  assert.deepEqual(objects.list({ prefix: "a/", startAfter: "b" }).objects, []);
  assert.deepEqual(
    objects.list({ prefix: "a/", startAfter: "a/1" }).objects.map((object) => object.key),
    ["a/2"],
  );
  assert.deepEqual(
    objects.list({ prefix: "a0" }).objects.map((object) => object.key),
    ["a0"],
  );
  assertBoundedKeySearch(sql);
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

test("each person and each group chat has a Durable Object of its own", async () => {
  assert.equal(ownerName({ person: "w1" }), "person:w1");
  assert.equal(ownerName({ chat: "w1" }), "chat:w1");
  assert.notEqual(ownerName({ person: "w1" }), ownerName({ chat: "w1" }));
  assert.throws(() => ownerName({ person: "w1", chat: "c1" }));
  assert.throws(() => ownerName({ person: "" }));
  assert.throws(() => ownerName({}));
  const names = [];
  const seen = [];
  const env = { TEX_STORE: { idFromName: (name) => (names.push(name), name), get: (id) => ({ fetch: async (request) => (seen.push([id, request.headers.get("x-tex-owner")]), new Response(null)) }) } };
  // The store placed in eastern North America, every call naming its owner (`texStore/move.js`).
  await texStoreStub(env, { person: "w1" }).fetch(new Request("https://tex-store.internal/get"));
  assert.deepEqual(seen, [["enam:person:w1", "person:w1"]]);
  assert.equal(texStoreStub({}, { person: "w1" }), null);
});
