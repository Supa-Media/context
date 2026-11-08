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
import { replaceNoteText, stateBucket } from "../src/tools/notes/replaceInObject.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { durableSqlite } from "./durableSqlite.mjs";

const PATH = "1-projects/plan.md";
const NOTE_ID = "0199a000-0000-7000-8000-000000000001";
const KEY = `notes/${NOTE_ID}.md`;
const COLLAB = ".context/collaboration/";

function objectSide({ home = "object", backfilled = true, rowKey = KEY, mirrored = true } = {}) {
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
  if (mirrored) {
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
  }
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
  const logged = [];
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client: side.client, defer: (work) => behind.push(work), log: (event, fields) => logged.push([event, fields]), known: { home: options?.home ?? "object", backfilledAt: options?.backfilled === false ? null : 1 } });
  await routed.put(KEY, "# Plan\n\nFirst words.\n");
  // The document is started and saved once the ordinary way, from the gateway.
  const first = await readDocument(atPath(routed), PATH);
  const saved = await replaceText(atPath(routed), PATH, { expectedEtag: first.etag, onlyCurrent: true, text: "# Plan\n\nSecond words.\n" });
  await settle();
  side.calls.length = 0;
  return { ...side, bucket, routed, saved, settle, logged };
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

test("a save hands back and copies each key once, where it ended: the document state is not sent twice", async () => {
  const { routed, saved, bucket, settle } = await started();
  const copied = [];
  const put = bucket.put.bind(bucket);
  bucket.put = (key, ...rest) => {
    copied.push(key);
    return put(key, ...rest);
  };
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  await settle();
  // The answer itself carries each key once: the state the save wrote twice travels back from the object once.
  const keys = answer.writes.map((write) => write.key);
  assert.equal(new Set(keys).size, keys.length, `the answer carried a key twice: ${keys.join(", ")}`);
  const state = answer.writes.find((write) => write.key.startsWith(`${COLLAB}v1/documents/`) && !write.key.includes("/operations/"));
  assert.ok(state, "no document state was handed back");
  assert.equal(JSON.parse(state.body).pending, null, "the state handed back is not where the save ended");
  assert.equal(new Set(copied).size, copied.length, `a key was copied twice: ${copied.join(", ")}`);
  assert.equal(await text(bucket, state.key), state.body);
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
  const { routed, client, saved, logged } = await started({ rowKey: "notes/0199a000-0000-7000-8000-000000000002.md" });
  const before = await text(client.bodies, KEY);
  logged.length = 0;
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.deepEqual(answer, { served: false, reason: "row_moved" });
  assert.equal(await text(client.bodies, KEY), before);
  // Why it was not served is logged as the object's code, never the path (2026-11-03).
  assert.deepEqual(logged, [["workspace_object_collab_not_served", { workspaceId: "ws", reason: "row_moved" }]]);
});

test("a workspace not backfilled into the object is never asked: the gateway runs the engine", async () => {
  const { routed, calls, saved } = await started({ backfilled: false });
  assert.equal(await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "x" }), null);
  assert.equal(calls.length, 0);
});

test("a save whose version file the object pruned is still served, from the copy its document state keeps", async () => {
  const { routed, store, saved } = await started();
  for (const row of store.sql.exec("SELECT key FROM objects WHERE key LIKE ?", `${COLLAB}v1/revisions/%`).toArray()) store.objects.delete(row.key);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.equal(answer.served, true, answer.reason);
  assert.equal(answer.result.text, "# Plan\n\nThird words.\n");
});

/**
 * The object pruned the version a save is based on, and the document was last saved before its state kept a copy of
 * its current version (`current`), so only the bucket has it.
 */
async function prunedLegacyVersion(store, bucket) {
  for (const row of store.sql.exec("SELECT key FROM objects WHERE key LIKE ?", `${COLLAB}v1/revisions/%`).toArray()) store.objects.delete(row.key);
  for (const row of store.sql.exec("SELECT key FROM objects WHERE key LIKE ? AND key NOT LIKE ?", `${COLLAB}v1/documents/%`, "%/operations/%").toArray()) {
    const { current, bases: _bases, editedAt: _editedAt, ...legacy } = JSON.parse(new TextDecoder().decode(store.objects.get(row.key).body));
    if (legacy.kind !== "document") continue;
    // A writer from before kept a file for every version, and the bucket has it.
    const version = { schemaVersion: 1, kind: "revision", documentId: legacy.documentId, generation: legacy.generation, revision: legacy.revision, snapshot: current.snapshot, text: legacy.text, rawMarkdownEtag: current.rawMarkdownEtag };
    await bucket.put(`${COLLAB}v1/revisions/${legacy.documentId}/${legacy.revision}.json`, JSON.stringify(version));
    await store.objects.put(row.key, JSON.stringify(legacy));
  }
}

test("a saved version only the bucket keeps sends the save back to the gateway", async () => {
  const { routed, store, saved, bucket } = await started();
  // The object pruned the version the save is based on; the bucket still has it.
  await prunedLegacyVersion(store, bucket);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  // Which read the object lacked, said to the save for its timings (`inside:collab_declined_not_held_version`).
  assert.equal(answer.served, false);
  assert.equal(answer.reason, "not_held_version");
  assert.ok(Number.isFinite(answer.took));
  // And the gateway's own engine, which reads the bucket for it, still saves.
  const done = await replaceText(atPath(routed), PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(done.text, "# Plan\n\nThird words.\n");
});

/** The routed store under the id layer, as a session's store has it: the tree names the note's key and id. */
function layered(routed, client, { inObject = false } = {}) {
  const reports = [];
  const wrote = async (record) => {
    reports.push(record);
    return { recorded: true };
  };
  if (inObject) wrote.inObject = true;
  const store = withIdLayout(routed, {
    lookup: async (paths) => {
      const head = await client.bodies.head(KEY);
      return { keyed: true, notes: Object.fromEntries(paths.filter((path) => path === PATH).map((path) => [path, { state: "keyed", key: KEY, noteId: NOTE_ID, etag: head?.etag ?? "" }])) };
    },
    wrote,
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

const rowEtag = (store) => store.sql.exec("SELECT etag FROM ws_rows WHERE path = ? AND gone = 0", PATH).toArray()[0]?.etag ?? null;

test("a save that brings its record has the new version on its row and queued for the mirror, in the same call", async () => {
  const { routed, store, calls, saved } = await started();
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n", record: { at: 5 } });
  assert.equal(answer?.recorded, true);
  assert.deepEqual(calls.map((call) => JSON.parse(call).op), ["ws.collab.replace"]);
  assert.equal(rowEtag(store), answer.markdown.etag, "the row does not name the new version");
  const wroteChanges = store.queued.filter((entry) => entry.change?.op === "wrote");
  assert.equal(wroteChanges.length, 1, "the version was not queued for the mirror exactly once");
  assert.equal(wroteChanges[0].inTransaction, true);
  assert.equal(wroteChanges[0].change.record.etag, answer.markdown.etag);
  assert.equal(wroteChanges[0].change.record.at, 5);
  assert.equal(store.soon, 1);
});

test("a save without its record leaves the row alone and says so", async () => {
  const { routed, store, saved } = await started();
  const before = rowEtag(store);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.equal(answer?.recorded, false);
  assert.equal(rowEtag(store), before);
  assert.equal(store.queued.length, 0);
});

test("a conflicting save records nothing", async () => {
  const { routed, store, saved } = await started();
  await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  const before = rowEtag(store);
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nOverwrite.\n", record: { at: 6 } });
  assert.equal(answer?.error?.code, "CONFLICT");
  assert.notEqual(answer.recorded, true);
  assert.equal(rowEtag(store), before);
  assert.equal(store.queued.length, 0);
});

test("a member's save through the id layer is recorded by the object, with no second call and no report", async () => {
  const { routed, client, store, calls, saved } = await started();
  const { store: layeredStore, reports } = layered(routed, client, { inObject: true });
  calls.length = 0;
  const result = await replaceNoteText(layeredStore, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(result.text, "# Plan\n\nThird words.\n");
  // (The fake tree's lookup reads a head; the save itself is one call.)
  assert.deepEqual(calls.map((call) => JSON.parse(call).op).filter((op) => op !== "head"), ["ws.collab.replace"]);
  assert.deepEqual(reports, [], "the version was reported a second time");
  assert.equal(rowEtag(store), (await client.bodies.head(KEY)).etag);
});

test("an object that cannot record the version leaves the report to the id layer", async () => {
  const { routed, client, saved } = await started({ mirrored: false });
  const { store: layeredStore, reports } = layered(routed, client, { inObject: true });
  await replaceNoteText(layeredStore, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  const head = await client.bodies.head(KEY);
  assert.deepEqual(reports.map((record) => [record.key, record.etag]), [[KEY, head.etag]]);
});

test("the object says how long it spent on the save, and write_note's store records it", async () => {
  const { routed, client, saved } = await started();
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.ok(Number.isFinite(answer?.took) && answer.took >= 0, `no time in ${JSON.stringify(answer?.took)}`);
  const { store: layeredStore } = layered(routed, client);
  const took = [];
  Object.defineProperty(layeredStore, "phase", { value: Object.assign((name, run) => run(), { took: (name, ms) => took.push([name, ms]) }) });
  await replaceNoteText(layeredStore, PATH, { expectedEtag: answer.result.etag, onlyCurrent: true, text: "# Plan\n\nFourth words.\n" });
  assert.equal(took[0][0], "collab_replace");
  assert.ok(Number.isFinite(took[0][1]));
  // And the save's shape beside it: its trip by state size, its wait, its sizes and writes (2026-11-06).
  const named = Object.fromEntries(took);
  assert.deepEqual(took.map(([name]) => name), ["collab_replace", "collab_trip_small", "collab_waited", "collab_state_kb", "collab_written_kb", "collab_writes"]);
  assert.equal(named.collab_writes, 3, "a first-try save makes three writes");
  for (const [name, value] of took) assert.ok(Number.isFinite(value) && value >= 0, `${name} is ${value}`);
});

test("a save's answer says its sizes and writes, never its text", async () => {
  const { routed, saved } = await started();
  const answer = await routed.replaceInObject({ path: PATH, key: KEY, noteId: NOTE_ID, expectedEtag: saved.etag, text: "# Plan\n\nThird words.\n" });
  assert.deepEqual(Object.keys(answer.sizes).sort(), ["note", "state", "writes", "written"]);
  assert.equal(answer.sizes.note, "# Plan\n\nThird words.\n".length);
  assert.ok(answer.sizes.state > 0 && answer.sizes.written > answer.sizes.state);
  assert.ok(Number.isFinite(answer.waited) && answer.waited >= 0);
  assert.ok(Number.isFinite(answer.trip) && answer.trip >= 0);
});

test("a save's state is bucketed by size", () => {
  assert.deepEqual([0, 16 * 1024 - 1, 16 * 1024, 256 * 1024, 2 * 1024 * 1024].map(stateBucket), ["small", "small", "medium", "large", "huge"]);
});

test("a save the object declines says why in its timings, and the gateway's engine still saves it", async () => {
  const { routed, client, store, saved, bucket } = await started();
  await prunedLegacyVersion(store, bucket);
  const { store: layeredStore } = layered(routed, client);
  const took = [];
  Object.defineProperty(layeredStore, "phase", { value: Object.assign((name, run) => run(), { took: (name, ms) => took.push([name, ms]) }) });
  const result = await replaceNoteText(layeredStore, PATH, { expectedEtag: saved.etag, onlyCurrent: true, text: "# Plan\n\nThird words.\n" });
  assert.equal(result.text, "# Plan\n\nThird words.\n");
  assert.deepEqual(took.map(([name]) => name), ["collab_declined_not_held_version"]);
  assert.ok(Number.isFinite(took[0][1]));
});
