// A whole-note save's editing history run inside the workspace object in one call (`workspaceStore/collabReplace.js`,
// `store/workspaceRouting.js` `replaceInObject`): one call to the object, the same answer and refusals as the engine
// run from the gateway, and every write copied to the bucket behind it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readDocument, replaceText } from "@context/collaboration";
import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { withIdLayout } from "../src/store/idLayout.js";
import { replaceNoteText } from "../src/tools/notes/replaceInObject.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { durableSqlite } from "./durableSqlite.mjs";

const PATH = "1-projects/plan.md";
const NOTE_ID = "0199a000-0000-7000-8000-000000000001";
const KEY = `notes/${NOTE_ID}.md`;
const COLLAB = ".context/collaboration/";

function objectSide({ home = "object", backfilled = true, rowKey = KEY } = {}) {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  store.rows.put([{ id: "row-1", noteId: NOTE_ID, path: PATH, kind: "file", at: 1, storageKey: rowKey }]);
  store.rows.setHome(home);
  if (backfilled) store.rows.markBackfilled(1);
  const calls = [];
  const stub = {
    fetch: (request) => {
      calls.push(decodeURIComponent(request.headers.get("x-tex-call") ?? ""));
      return serveWorkspaceStore(store, request);
    },
  };
  const ask = async (op, fields) =>
    await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  const client = { bodies: new R2Store(texBucket(stub)), collab: { replace: (fields) => ask("ws.collab.replace", fields) } };
  return { store, client, calls };
}

function bucketSide() {
  const { sql } = durableSqlite();
  const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
  return new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(store, request) }));
}

/** The engine's view of the routed store at the note's path, as the id layer gives it (path → key, the row's id). */
function atPath(routed) {
  const keyOf = (key) => (key === PATH ? KEY : key);
  return {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    noteIdAt: async (path) => (path === PATH ? NOTE_ID : null),
    get: (key, ...rest) => routed.get(keyOf(key), ...rest),
    head: (key, ...rest) => routed.head(keyOf(key), ...rest),
    put: (key, ...rest) => routed.put(keyOf(key), ...rest),
    delete: (key, ...rest) => routed.delete(Array.isArray(key) ? key.map(keyOf) : keyOf(key), ...rest),
    list: (...rest) => routed.list(...rest),
  };
}

async function started(options) {
  const side = objectSide(options);
  const bucket = bucketSide();
  // The bucket's copies and the object's pruning go behind the response, as with a request's `waitUntil`.
  const behind = [];
  const settle = async () => {
    while (behind.length) await Promise.allSettled(behind.splice(0));
  };
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client: side.client, defer: (work) => behind.push(work), known: { home: options?.home ?? "object", backfilledAt: options?.backfilled === false ? null : 1 } });
  await routed.put(KEY, "# Plan\n\nFirst words.\n");
  // The document is started and saved once the ordinary way, from the gateway.
  const first = await readDocument(atPath(routed), PATH);
  const saved = await replaceText(atPath(routed), PATH, { expectedEtag: first.etag, onlyCurrent: true, text: "# Plan\n\nSecond words.\n" });
  await settle();
  side.calls.length = 0;
  return { ...side, bucket, routed, saved, settle };
}

const text = async (store, key) => {
  const found = await store.get(key);
  return found === null ? null : await found.text();
};

test("a save runs in the object in one call, lands in the Markdown, and answers the engine's version", async () => {
  const { routed, client, calls, saved, bucket, settle } = await started();
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.equal(answer?.served, true);
  assert.deepEqual(calls.map((call) => JSON.parse(call).op), ["ws.collab.replace"], "the save waited for more than the one call");
  await settle();
  assert.equal(await text(client.bodies, KEY), "# Plan\n\nThird words.\n");
  // The gateway's engine reads the same document at the version the object answered.
  const after = await readDocument(atPath(routed), PATH);
  assert.equal(after.etag, answer.result.etag);
  assert.equal(after.text, "# Plan\n\nThird words.\n");
  // And the bucket's backup copy has every key the object wrote.
  assert.equal(await text(bucket, KEY), "# Plan\n\nThird words.\n");
  const last = new Map(answer.writes.map((write) => [write.key, write.body]));
  for (const [key, body] of last) assert.equal(await text(bucket, key), body, `${key} was not copied to the bucket`);
  assert.ok(answer.writes.some((write) => write.key.startsWith(`${COLLAB}v1/documents/`)), "no document state was written");
});

test("a save from a version that has moved is a CONFLICT, and the note is unchanged", async () => {
  const { routed, client, saved } = await started();
  await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  const stale = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nOverwrite.\n" });
  assert.equal(stale?.served, true);
  assert.equal(stale.error?.code, "CONFLICT");
  assert.equal(await text(client.bodies, KEY), "# Plan\n\nThird words.\n");
});

test("a row that names another key is not served, and nothing is written", async () => {
  const { routed, client, saved } = await started({ rowKey: "notes/0199a000-0000-7000-8000-000000000002.md" });
  const before = await text(client.bodies, KEY);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.equal(answer, null);
  assert.equal(await text(client.bodies, KEY), before);
});

test("a workspace not backfilled into the object is never asked: the gateway runs the engine", async () => {
  const { routed, calls, saved } = await started({ backfilled: false });
  assert.equal(await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "x" }), null);
  assert.equal(calls.length, 0);
});

test("a saved version only the bucket keeps sends the save back to the gateway", async () => {
  const { routed, store, saved } = await started();
  // The object pruned the version the save is based on; the bucket still has it.
  for (const row of store.sql.exec("SELECT key FROM objects WHERE key LIKE ?", `${COLLAB}v1/revisions/%`).toArray()) store.objects.delete(row.key);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.equal(answer, null);
  // And the gateway's own engine, which reads the bucket for it, still saves.
  const done = await replaceText(atPath(routed), PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(done.text, "# Plan\n\nThird words.\n");
});

/** The routed store under the id layer, as a session's store has it: the tree names the note's key and id. */
function layered(routed, client) {
  const reports = [];
  const store = withIdLayout(routed, {
    lookup: async (paths) => {
      const head = await client.bodies.head(KEY);
      return { keyed: true, notes: Object.fromEntries(paths.filter((path) => path === PATH).map((path) => [path, { state: "keyed", key: KEY, noteId: NOTE_ID, etag: head?.etag ?? "" }])) };
    },
    wrote: async (record) => {
      reports.push(record);
      return { recorded: true };
    },
    adopt: async () => assert.fail("a save of an existing note adopts nothing"),
    removed: async () => assert.fail("a save removes nothing"),
  });
  return { store, reports };
}

test("write_note's save, through the id layer, waits for one object call and reports the new Markdown version", async () => {
  const { routed, client, calls, saved } = await started();
  const { store, reports } = layered(routed, client);
  calls.length = 0;
  const result = await replaceNoteText(store, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(result.text, "# Plan\n\nThird words.\n");
  assert.equal(calls.filter((call) => JSON.parse(call).op === "ws.collab.replace").length, 1);
  assert.ok(!calls.some((call) => ["get", "put"].includes(JSON.parse(call).op)), `the save read or wrote through the gateway: ${calls.join(", ")}`);
  const head = await client.bodies.head(KEY);
  assert.deepEqual(reports.map((record) => [record.key, record.etag, record.keyed]), [[KEY, head.etag, true]]);
});

test("a conflict answered by the object is the engine's CONFLICT to write_note", async () => {
  const { routed, client, saved } = await started();
  const { store } = layered(routed, client);
  await replaceNoteText(store, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  await assert.rejects(
    replaceNoteText(store, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nOverwrite.\n" }),
    (error) => error?.code === "CONFLICT",
  );
});

test("an object that cannot be reached for the save leaves it to the engine here, which still saves", async () => {
  const { routed, client, saved } = await started();
  client.collab.replace = async () => {
    throw new Error("object unreachable");
  };
  const { store } = layered(routed, client);
  const result = await replaceNoteText(store, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(result.text, "# Plan\n\nThird words.\n");
  assert.equal(await text(client.bodies, KEY), "# Plan\n\nThird words.\n");
});
