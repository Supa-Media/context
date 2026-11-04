// A new note's bytes and row made inside the workspace object in one call (`workspaceStore/createNote.js`,
// `store/workspaceRouting.js` `createInObject`, `store/idLayout.js` `keyedCreate`): one call where three were, the
// object's adoption rules unchanged, the bucket's backup copy written behind, and every case the object leaves alone
// written as before. Fake values only.
//
// Sabotage, each confirmed to fail a case here: adopt without the `absent` condition (a held key is overwritten),
// skip the adoption's tier check (a private note adopted where the folder is team), queue the mirror entry outside the
// transaction, drop the bucket copy, or let the id layer skip the control plane's adoption after a DEFER.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { withIdLayout } from "../src/store/idLayout.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { durableSqlite } from "./durableSqlite.mjs";

const NOTE_ID = "0199a000-0000-7000-8000-000000000009";
const KEY = `notes/${NOTE_ID}.md`;
const RULES = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }], notes: [] };

function objectSide({ home = "object", backfilled = true, failing = false, settleMs = null } = {}) {
  const { sql, transact: run } = durableSqlite();
  let depth = 0;
  const transact = (work) => {
    depth += 1;
    try {
      return run(work);
    } finally {
      depth -= 1;
    }
  };
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql), soon: 0, queued: [] };
  const mirror = mirrorOutbox(sql);
  const enqueue = mirror.enqueue;
  mirror.enqueue = (...args) => {
    store.queued.push({ change: args[1], inTransaction: depth > 0 });
    return enqueue(...args);
  };
  store.mirror = mirror;
  store.mirrorSoon = () => {
    store.soon += 1;
  };
  if (settleMs !== null) {
    store.settled = 0;
    store.settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      store.settled += 1;
    };
  }
  store.rows.pinWorkspace("ws");
  store.rows.put([{ id: "folder-1", path: "1-projects", kind: "folder", at: 1 }]);
  store.rows.putRules(RULES, "member");
  store.rows.setHome(home);
  if (backfilled) store.rows.markBackfilled(1);
  const calls = [];
  const stub = {
    fetch: (request) => {
      calls.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
      return serveWorkspaceStore(store, request);
    },
  };
  const ask = async (op, fields) => {
    if (failing) throw new Error("unreachable");
    return await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  };
  const client = { bodies: new R2Store(texBucket(stub)), collab: { create: (fields) => ask("ws.create", fields) } };
  return { store, client, calls };
}

function started(options = {}) {
  const side = objectSide(options);
  const { sql } = durableSqlite();
  const bucketStore = { objects: texObjects(sql), rows: workspaceRows(sql) };
  const bucket = new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(bucketStore, request) }));
  const behind = [];
  const settle = async () => {
    while (behind.length) await Promise.allSettled(behind.splice(0));
  };
  const logged = [];
  const routed = withWorkspaceRouting(bucket, {
    workspaceId: "ws",
    client: side.client,
    defer: (work) => behind.push(work),
    log: (event, fields) => logged.push([event, fields]),
    known: { home: options.home ?? "object", backfilledAt: options.backfilled === false ? null : 1 },
  });
  return { ...side, bucket, routed, settle, logged };
}

const text = async (store, key) => {
  const found = await store.get(key);
  return found === null ? null : await found.text();
};
const create = (path, tier = "team", extra = {}) => ({ path, noteId: NOTE_ID, key: KEY, text: "# New\n", tier, at: 5, ...extra });

test("a new note's bytes and row land in the object in one call, its row queued for the mirror in the same transaction", async () => {
  const { routed, client, calls, store, bucket, settle } = started();
  const answer = await routed.createInObject(create("1-projects/new.md"));
  assert.equal(answer.served, true);
  assert.equal(answer.adopted, true);
  assert.deepEqual(calls, ["ws.create"]);
  assert.equal(await text(client.bodies, KEY), "# New\n");
  const row = store.rows.byPath("1-projects/new.md");
  assert.equal(row.noteId, NOTE_ID);
  assert.equal(row.etag, answer.etag);
  assert.deepEqual(store.queued.map((entry) => [entry.change.op, entry.inTransaction]), [["adopt", true]]);
  assert.ok(store.soon > 0);
  await settle();
  assert.equal(await text(bucket, KEY), "# New\n", "the bucket's backup copy was not written");
});

test("a note the object leaves to the control plane keeps its bytes, has no row here, and says why", async () => {
  const { routed, client, store } = started();
  // The folder is team: a private note is not adopted here before its narrowing lands.
  const answer = await routed.createInObject(create("1-projects/secret.md", "private"));
  assert.equal(answer.served, true);
  assert.equal(answer.adopted, false);
  assert.equal(answer.reason, "wider_here");
  assert.equal(await text(client.bodies, KEY), "# New\n");
  assert.equal(store.rows.byPath("1-projects/secret.md"), null);
  assert.deepEqual(store.queued, []);
});

test("a key already held is never overwritten, and the gateway writes the note itself", async () => {
  const { routed, client, store, logged } = started();
  await client.bodies.put(KEY, "someone else's");
  assert.equal(await routed.createInObject(create("1-projects/new.md")), null);
  assert.equal(await text(client.bodies, KEY), "someone else's");
  assert.equal(store.rows.byPath("1-projects/new.md"), null);
  assert.deepEqual(logged.map(([event, fields]) => [event, fields.reason]), [["workspace_object_create_not_served", "key_held"]]);
});

test("a workspace whose notes are not held in the object is never asked", async () => {
  for (const options of [{ home: "dual" }, { backfilled: false }]) {
    const { routed, calls } = started(options);
    assert.equal(await routed.createInObject(create("1-projects/new.md")), null);
    assert.deepEqual(calls, []);
  }
});

/** The routed store under the id layer: the tree has nothing at the path, and the control plane's adoption is counted. */
function layered(routed, { adopted = true } = {}) {
  const adoptions = [];
  const store = withIdLayout(routed, {
    lookup: async () => ({ keyed: true, notes: {}, texHomes: {} }),
    wrote: async () => ({ recorded: true }),
    adopt: async (note) => {
      adoptions.push(note);
      return { adopted, taken: null };
    },
    removed: async () => ({ removed: true }),
    now: () => 5,
  });
  return { store, adoptions };
}

test("write_note's create, through the id layer, is one object call and asks the control plane nothing", async () => {
  const { routed, calls, client } = started();
  const { store, adoptions } = layered(routed);
  const result = await store.put("1-projects/new.md", "# New\n", { onlyIf: { absent: true }, tier: "team" });
  assert.equal(typeof result.etag, "string");
  // The object's own time on it rides back for the save's timings (`inside:create`).
  assert.ok(Number.isFinite(result.took) && result.took >= 0);
  assert.deepEqual(calls, ["ws.create"]);
  assert.deepEqual(adoptions, []);
  const row = (await client.bodies.list({ prefix: "notes/" })).objects;
  assert.equal(row.length, 1);
});

test("an adoption the object defers is the control plane's, with the bytes the object wrote", async () => {
  const { routed, calls } = started();
  const { store, adoptions } = layered(routed);
  const result = await store.put("1-projects/secret.md", "# New\n", { onlyIf: { absent: true }, tier: "private" });
  assert.equal(typeof result.etag, "string");
  assert.equal(calls[0], "ws.create");
  assert.ok(!calls.includes("put"), "the bytes were written twice");
  assert.equal(adoptions.length, 1);
  assert.equal(adoptions[0].etag, result.etag);
  assert.equal(adoptions[0].tier, "private");
});

test("an object that cannot be reached, or a create with no tier, writes and adopts as before", async () => {
  const unreachable = started({ failing: false });
  unreachable.client.collab.create = async () => {
    throw new Error("unreachable");
  };
  const first = layered(unreachable.routed);
  assert.equal(typeof (await first.store.put("1-projects/a.md", "# A\n", { onlyIf: { absent: true }, tier: "team" })).etag, "string");
  assert.equal(first.adoptions.length, 1);
  const plain = started();
  const second = layered(plain.routed);
  await second.store.put("1-projects/b.md", "# B\n", { onlyIf: { absent: true } });
  assert.ok(!plain.calls.includes("ws.create"));
  assert.equal(second.adoptions.length, 1);
});

test("the object says how long its writes took to be durable, and the id layer hands that on beside its own time", async () => {
  const { routed, store } = started({ settleMs: 5 });
  const { store: layer } = layered(routed);
  const result = await layer.put("1-projects/new.md", "# New\n", { onlyIf: { absent: true }, tier: "team" });
  assert.equal(store.settled, 1, "the writes were never waited on");
  assert.ok(result.commit >= 4, `commit ${result.commit}`);
  assert.ok(result.took >= result.commit, "the call's own time leaves out the wait for its writes");
});

test("an object that cannot wait for its writes says nothing of them", async () => {
  const { routed } = started();
  const answer = await routed.createInObject(create("1-projects/new.md"));
  assert.equal(answer.served, true);
  assert.equal(Object.hasOwn(answer, "commit"), false);
});

test("a new note sets its flush alarm before waiting for durable writes, so one flush carries both", async () => {
  const { routed, store } = started({ settleMs: 1 });
  const order = [];
  store.mirrorSoon = () => new Promise((resolve) => setTimeout(() => {
    order.push("alarm set");
    resolve();
  }, 5));
  const settle = store.settle;
  store.settle = async () => {
    order.push("settle");
    await settle();
  };
  const { store: layer } = layered(routed);
  await layer.put("1-projects/armed.md", "# Armed\n", { onlyIf: { absent: true }, tier: "team" });
  assert.deepEqual(order, ["alarm set", "settle"]);
});
