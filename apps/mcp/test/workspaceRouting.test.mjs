// Note texts routed to the workspace object by the binding's home
// (src/store/workspaceRouting.js): bucket untouched, dual mirrors, object
// reads the object and keeps the bucket written behind.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function sqlStore() {
  const db = new DatabaseSync(":memory:");
  const sql = {
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
  const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
  return new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(store, request) }));
}

const KEY = "notes/0199a000-0000-7000-8000-000000000001.md";

function setup(home, backfilledAt = null) {
  const bucket = sqlStore();
  const object = sqlStore();
  let asked = 0;
  const client = { bodies: object, state: async () => (asked++, { home }) };
  const logs = [];
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client, known: { home, backfilledAt }, log: (event) => logs.push(event) });
  return { bucket, object, routed, logs, asked: () => asked };
}

test("with no home on the binding, the store is the bucket's own and the object is never called", { skip }, async () => {
  const bucket = sqlStore();
  const client = { bodies: null, state: async () => assert.fail("asked") };
  assert.equal(withWorkspaceRouting(bucket, { workspaceId: "ws", client, known: {} }), bucket);
  assert.equal(withWorkspaceRouting(bucket, { workspaceId: "ws", client, known: { home: "bucket" } }), bucket);
});

test("dual: the bucket is read and decides conditional writes; every write and delete reaches the object too", { skip }, async () => {
  const { bucket, object, routed } = setup("dual");
  const first = await routed.put(KEY, "one");
  assert.equal(await (await object.get(KEY)).text(), "one");
  await assert.rejects(() => routed.put(KEY, "two", { onlyIf: { etagMatches: "nope" } }).then((answer) => answer ?? Promise.reject(new Error("refused"))));
  assert.equal(await (await bucket.get(KEY)).text(), "one");
  assert.equal((await routed.get(KEY)).etag, first.etag);
  await routed.delete(KEY);
  assert.equal(await object.get(KEY), null);
  assert.equal(await bucket.get(KEY), null);
});

test("object: reads come from the object, and the bucket keeps a copy written behind", { skip }, async () => {
  const { bucket, object, routed } = setup("object", 1);
  await routed.put(KEY, "fresh");
  assert.equal(await (await bucket.get(KEY)).text(), "fresh");
  await bucket.put(KEY, "bucket only");
  assert.equal(await (await routed.get(KEY)).text(), "fresh");
  assert.equal(await (await object.get(KEY)).text(), "fresh");
});

test("object before backfill: a note missing from the object is read from the bucket and copied in", { skip }, async () => {
  const { bucket, object, routed, logs } = setup("object", null);
  await bucket.put(KEY, "old note");
  assert.equal(await (await routed.get(KEY)).text(), "old note");
  assert.equal(await (await object.get(KEY)).text(), "old note");
  assert.deepEqual(logs, ["workspace_note_copied_on_read"]);
});

test("object after backfill: a note missing from the object is missing, and the bucket is not read", { skip }, async () => {
  const { bucket, routed } = setup("object", 5);
  await bucket.put(KEY, "stale");
  assert.equal(await routed.get(KEY), null);
});

test("a delete removes both copies, so nothing can be read back from the bucket", { skip }, async () => {
  const { bucket, object, routed } = setup("object", null);
  await routed.put(KEY, "x");
  await routed.delete(KEY);
  assert.equal(await bucket.get(KEY), null);
  assert.equal(await object.get(KEY), null);
  assert.equal(await routed.get(KEY), null);
});

test("a failed mirror is logged and never fails the write", { skip }, async () => {
  const bucket = sqlStore();
  const broken = { put: async () => { throw new Error("down"); }, delete: async () => { throw new Error("down"); }, get: async () => null, head: async () => null };
  const logs = [];
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client: { bodies: broken }, known: { home: "dual" }, log: (event) => logs.push(event) });
  await routed.put(KEY, "kept");
  assert.equal(await (await bucket.get(KEY)).text(), "kept");
  assert.deepEqual(logs, ["workspace_mirror_failed"]);
});

test("keys other than note texts and editing history never leave the bucket", { skip }, async () => {
  const { object, routed } = setup("object", 1);
  await routed.put("files/x.png", "img");
  await routed.put("notes/plain-name.md", "legacy");
  assert.equal(await object.get("files/x.png"), null);
  assert.equal(await object.get("notes/plain-name.md"), null);
});
