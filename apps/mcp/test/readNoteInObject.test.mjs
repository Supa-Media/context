// `read_note` of a note in an object-home workspace: its Markdown and its editing history read inside the workspace
// object in one call (`workspaceStore/collabRead.js`, `store/workspaceRouting.js` and `store/idLayout.js`
// `readInObject`), with the same answer the long way gives, and every refusal still costing what it cost.
//
// Sabotage record (applied, test run, named test observed failing, reverted; 2026-11-03):
//  1. `readInObject` in `read.js` returning null at once.
//     → "a note people edited together is read in one object call…" fails (the collaboration keys are read).
//  2. `serveCollabRead` skipping the live-row check.
//     → "a row that names another note is not served…" fails (served true).
//  (`serveCollabRead` without its `isEncryptedNote` check passes: `eligible` already refuses an encrypted note's
//  front matter. The check stays, so the two cannot drift apart.)
//  3. `readInObject` asked before `canSee` decides (for every read).
//     → "a note this reader may not see never reaches the object's read" fails.
//  4. The engine's refusal dropped (`started` resolving null on `answer.error`).
//     → "an engine refusal from the object fails the read closed" fails.
//  5. `toolOpenAiFetch` back on its own probe, get and Markdown (2026-11-06).
//     → "ChatGPT's fetch is read_note's one object call…" fails (a probe and a get beside it).
import { test } from "node:test";
import assert from "node:assert/strict";

import { readDocument, replaceText } from "@context/collaboration";
import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { withIdLayout } from "../src/store/idLayout.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveCollabRead } from "../src/workspaceStore/collabRead.js";
import { toolReadNote } from "../src/tools/notes/read.js";
import { toolOpenAiFetch } from "../src/tools/notes/openAiFetch.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { durableSqlite } from "./durableSqlite.mjs";

const PATH = "1-projects/plan.md";
const NOTE_ID = "0199a000-0000-7000-8000-000000000001";
const KEY = `notes/${NOTE_ID}.md`;
const COLLAB = ".context/collaboration/";
const RULES = [{ prefix: "1-projects", vis: "team" }];

function objectSide({ rowKey = KEY } = {}) {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  store.rows.put([{ id: "row-1", noteId: NOTE_ID, path: PATH, kind: "file", at: 1, storageKey: rowKey }]);
  store.rows.setHome("object");
  store.rows.markBackfilled(1);
  const calls = [];
  const stub = {
    fetch: (request) => {
      calls.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "")));
      return serveWorkspaceStore(store, request);
    },
  };
  const ask = async (op, fields) =>
    await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  const client = { bodies: new R2Store(texBucket(stub)), collab: { read: (fields) => ask("ws.collab.read", fields) } };
  return { store, client, calls };
}

function bucketSide() {
  const { sql } = durableSqlite();
  const store = { objects: texObjects(sql), rows: workspaceRows(sql) };
  return new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(store, request) }));
}

/** The engine's view of the routed store at the note's path, as the id layer gives it. */
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

/** A workspace with the note at `PATH`, `edited` once together when asked; the client without `read` when `long`. */
async function world({ body = "# Plan\n\nFirst words.\n", edited = true, rowKey = KEY, lookupNoteId = NOTE_ID } = {}) {
  const side = objectSide({ rowKey });
  const bucket = bucketSide();
  const behind = [];
  const settle = async () => {
    while (behind.length) await Promise.allSettled(behind.splice(0));
  };
  const logged = [];
  const route = (client) =>
    withWorkspaceRouting(bucket, { workspaceId: "ws", client, defer: (work) => behind.push(work), log: (event, fields) => logged.push([event, fields]), known: { home: "object", backfilledAt: 1 } });
  const routed = route(side.client);
  await routed.put(KEY, body);
  if (edited) {
    const first = await readDocument(atPath(routed), PATH);
    await replaceText(atPath(routed), PATH, { expectedEtag: first.etag, onlyCurrent: true, text: "# Plan\n\nSecond words.\n" });
  }
  await settle();
  const layered = (store) =>
    withIdLayout(store, {
      lookup: async (paths) => {
        const head = await side.client.bodies.head(KEY);
        return { keyed: true, notes: Object.fromEntries(paths.filter((path) => path === PATH).map((path) => [path, { state: "keyed", key: KEY, noteId: lookupNoteId, etag: head?.etag ?? "" }])) };
      },
      wrote: async () => ({ recorded: true }),
      adopt: async () => ({ adopted: true, taken: null }),
      removed: async () => ({ removed: true }),
    });
  // The same workspace read the long way: a client with no `collab.read`.
  const longClient = { bodies: side.client.bodies };
  side.calls.length = 0;
  logged.length = 0;
  return { ...side, bucket, settle, logged, store: layered(routed), long: layered(route(longClient)) };
}

const ops = (calls) => calls.map((call) => call.op);
const read = (store, scope = "private", overrides = new PrivacyOverrides(), path = PATH) => toolReadNote(store, scope, RULES, overrides, path);

test("a note people edited together is read in one object call, with the answer the long way gives", async () => {
  const { store, long, calls } = await world();
  const fast = await read(store);
  assert.equal(fast.isError, undefined, fast.content[0].text);
  assert.match(fast.content[0].text, /Second words\./);
  assert.match(fast.content[0].text, /^document_id: doc-/m);
  assert.deepEqual(ops(calls).filter((op) => op !== "head"), ["ws.collab.read"], `read more than the one call: ${ops(calls).join(", ")}`);
  assert.ok(!calls.some((call) => typeof call.key === "string" && call.key.startsWith(COLLAB)), "a collaboration key was read from the gateway");
  calls.length = 0;
  const slow = await read(long);
  assert.equal(slow.content[0].text, fast.content[0].text);
  assert.ok(ops(calls).includes("get"), "the long way did not read through the gateway");
});

test("a note nobody edited together is its Markdown, in one call, with the Markdown's etag", async () => {
  const { store, long, calls, client } = await world({ edited: false });
  const fast = await read(store);
  assert.equal(fast.isError, undefined, fast.content[0].text);
  const head = await client.bodies.head(KEY);
  assert.match(fast.content[0].text, new RegExp(`^etag: ${head.etag}$`, "m"));
  assert.doesNotMatch(fast.content[0].text, /document_id:/);
  assert.deepEqual(ops(calls).filter((op) => op !== "head"), ["ws.collab.read"]);
  assert.equal((await read(long)).content[0].text, fast.content[0].text);
});

test("a row that names another note is not served, and the read goes the long way with nothing written", async () => {
  const { store, logged, calls } = await world({ lookupNoteId: "0199a000-0000-7000-8000-000000000009" });
  const answer = await read(store);
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.ok(ops(calls).includes("ws.collab.read"));
  assert.ok(!ops(calls).includes("put"), "the object wrote for a read it refused");
  assert.deepEqual(logged.filter(([event]) => event === "workspace_object_read_not_served"), [["workspace_object_read_not_served", { workspaceId: "ws", reason: "row_moved" }]]);
});

test("a note this reader may not see never reaches the object's read: the refusal costs what it cost", async () => {
  const { store, calls } = await world();
  const overrides = new PrivacyOverrides();
  overrides.set(PATH, "private");
  const answer = await read(store, "team", overrides);
  assert.equal(answer.isError, true);
  assert.equal(answer.content[0].text, "not found");
  assert.ok(!ops(calls).includes("ws.collab.read"), "a held-back note was read in the object");
  assert.ok(!calls.some((call) => call.key === KEY && call.op === "get"), "a held-back note's body was read");
});

test("a password-encrypted note is answered with its Markdown alone", async () => {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  store.rows.put([{ id: "row-1", noteId: NOTE_ID, path: PATH, kind: "file", at: 1, storageKey: KEY }]);
  store.rows.setHome("object");
  store.rows.markBackfilled(1);
  const sealed = "---\ncontext_encryption: v1\n---\nciphertext\n";
  await store.objects.put(KEY, sealed);
  const answer = await serveCollabRead(store, { path: PATH, key: KEY, noteId: NOTE_ID });
  assert.equal(answer.served, true);
  assert.equal(answer.markdown.text, sealed);
  assert.equal(answer.collaboration, null);
  assert.deepEqual(answer.writes, []);
});

test("an engine refusal from the object fails the read closed", async () => {
  const { store: inner } = await world();
  const refusing = Object.create(inner, {
    oneRead: {
      value: (outer) => {
        const view = inner.oneRead(outer);
        return Object.create(view, { readInObject: { value: async () => ({ served: true, markdown: { etag: "e", size: 1, text: "# Plan\n" }, error: { code: "DEPENDENCY_PENDING", message: "pending" } }) } });
      },
    },
  });
  const answer = await read(refusing);
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /cannot be opened safely/);
});

test("a malformed or out-of-object call is not served", async () => {
  const side = objectSide();
  assert.equal((await serveCollabRead(side.store, { path: PATH, key: "../x", noteId: NOTE_ID })).reason, "bad_call");
  assert.equal((await serveCollabRead(side.store, { path: PATH, key: KEY, noteId: NOTE_ID })).reason, "not_held");
});

test("a Tex note's key never asks the workspace object's read: it lives in Tex's store", async () => {
  const side = objectSide();
  const routed = withWorkspaceRouting(bucketSide(), { workspaceId: "ws", client: side.client, log: () => {}, known: { home: "object", backfilledAt: 1 } });
  assert.equal(await routed.readInObject({ path: "tex/notes/a.md", key: `tex/person:p1/${KEY}`, noteId: NOTE_ID }), null);
  assert.deepEqual(side.calls, [], "a Tex note's read went to the workspace object");
});

test("ChatGPT's fetch is read_note's one object call, with the editing history's words", async () => {
  const { store, calls } = await world();
  const answer = await toolOpenAiFetch(store, "private", RULES, new PrivacyOverrides(), PATH);
  assert.equal(answer.isError, undefined, answer.content[0].text);
  const fetched = JSON.parse(answer.content[0].text);
  assert.equal(fetched.id, PATH);
  assert.match(fetched.text, /Second words\./);
  assert.ok(!/^etag:/m.test(fetched.text), "read_note's header leaked into the text");
  assert.ok(typeof fetched.metadata.etag === "string" && fetched.metadata.etag.length > 0);
  assert.deepEqual(ops(calls).filter((op) => op !== "head"), ["ws.collab.read"], `read more than the one call: ${ops(calls).join(", ")}`);
});

test("ChatGPT's fetch refuses a held-back note in read_note's words, without reading it", async () => {
  const { store, calls } = await world();
  const overrides = new PrivacyOverrides();
  overrides.set(PATH, "private");
  const answer = await toolOpenAiFetch(store, "team", RULES, overrides, PATH);
  assert.equal(answer.isError, true);
  assert.equal(answer.content[0].text, "not found");
  assert.ok(!ops(calls).includes("ws.collab.read"));
});
