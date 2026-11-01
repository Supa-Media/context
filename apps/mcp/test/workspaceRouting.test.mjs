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

// Saved versions (`.context/collaboration/v1/revisions/`) are never deleted, so they are most of a busy
// workspace's bytes. The object keeps each document's current and pending ones; the bucket keeps them all.
const DOC = "d-0199a000-0000-7000-8000-00000000000d";
const revisionKey = (revision) => `.context/collaboration/v1/revisions/${DOC}/${revision}.json`;
const stateKey = `.context/collaboration/v1/documents/${DOC}.json`;

function objectHome({ later = 0 } = {}) {
  const bucket = sqlStore();
  const object = sqlStore();
  const client = { bodies: object };
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client, known: { home: "object", backfilledAt: 1 }, now: () => Date.now() + later });
  return { bucket, object, routed };
}

test("object: an older saved version the object no longer holds is read from the bucket, and never copied in", { skip }, async () => {
  const { bucket, object, routed } = objectHome();
  await bucket.put(revisionKey("r-old"), "old version");
  assert.equal(await (await routed.get(revisionKey("r-old"))).text(), "old version");
  assert.notEqual(await routed.head(revisionKey("r-old")), null);
  assert.equal(await object.get(revisionKey("r-old")), null);
  assert.equal(await routed.get(revisionKey("r-none")), null);
});

test("object: saving a document's state drops the object's versions it no longer names, once past the grace", { skip }, async () => {
  const { bucket, object, routed } = objectHome({ later: 11 * 60 * 1000 });
  for (const revision of ["r-1", "r-2", "r-3"]) await routed.put(revisionKey(revision), `v ${revision}`, { onlyIf: { absent: true } });
  await routed.put(stateKey, JSON.stringify({ revision: "r-3", pending: { revision: "r-2" } }));
  assert.equal(await object.get(revisionKey("r-1")), null);
  assert.equal(await (await object.get(revisionKey("r-2"))).text(), "v r-2");
  assert.equal(await (await object.get(revisionKey("r-3"))).text(), "v r-3");
  for (const revision of ["r-1", "r-2", "r-3"]) assert.equal(await (await bucket.get(revisionKey(revision))).text(), `v ${revision}`);
  assert.equal(await (await routed.get(revisionKey("r-1"))).text(), "v r-1");
});

test("object: a version younger than the grace is kept even when no state names it yet (a save in flight)", { skip }, async () => {
  const { object, routed } = objectHome();
  await routed.put(revisionKey("r-new"), "in flight", { onlyIf: { absent: true } });
  await routed.put(stateKey, JSON.stringify({ revision: "r-current" }));
  assert.equal(await (await object.get(revisionKey("r-new"))).text(), "in flight");
});

test("object: a listing that reaches saved versions is the bucket's, which holds them all; notes list the object", { skip }, async () => {
  const { bucket, routed } = objectHome();
  await bucket.put(revisionKey("r-old"), "old");
  await bucket.put(KEY, "bucket only note");
  const keys = async (prefix) => (await routed.list({ prefix })).objects.map((entry) => entry.key);
  assert.deepEqual(await keys(`.context/collaboration/v1/revisions/${DOC}/`), [revisionKey("r-old")]);
  assert.ok((await keys(".context/collaboration/")).includes(revisionKey("r-old")));
  assert.deepEqual(await keys("notes/"), []);
});

test("dual: a document's state saved never prunes anything (the bucket is still the truth)", { skip }, async () => {
  const bucket = sqlStore();
  const object = sqlStore();
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client: { bodies: object }, known: { home: "dual" }, now: () => Date.now() + 11 * 60 * 1000 });
  await routed.put(revisionKey("r-1"), "v1", { onlyIf: { absent: true } });
  await routed.put(stateKey, JSON.stringify({ revision: "r-2" }));
  assert.equal(await (await object.get(revisionKey("r-1"))).text(), "v1");
});
