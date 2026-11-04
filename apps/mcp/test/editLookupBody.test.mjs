// AN EDIT ASKS THE WORKSPACE OBJECT ONCE BEFORE ITS SAVE (2026-11-04).
//
// Before: `write_note` with `expected_etag` asked the object for the note's row (`ws.rows.lookup`) and then, one after
// the other, for its body (`get`), before the merge (production `tools/call:write`: about 25 to 41 ms, then 20 to
// 36 ms). Now the write view's one-path lookup asks `withBody`, the object carries the note's Markdown beside the row
// (`workspaceStore/lookupBody.js`), and the id layer serves the load from it (`store/idLayout.js` `oneWrite`,
// `store/workspaceRouting.js` `storedFromLookup`).
//
// A body only ever rides on a row the lookup already answered `found: true` for this reader: never a note the reader
// may not see, a Tex note's key, a folder, a gone row, or a workspace whose notes do not live in the object yet.
//
// Sabotage record (applied, test run, named test observed failing, reverted; 2026-11-04):
//  1. `oneWrite` asking without `withBody`.
//     → "an edit asks the object once before it saves…" fails (a `get` follows the lookup).
//  2. `withLookupBody` skipping its `found` check: passes, because a row the reader may not see carries no key and the
//     key check refuses it too. Both stay, so neither alone is the guard.
//  3. `withLookupBody` skipping its home check.
//     → "a workspace whose notes are not in the object yet carries none" fails.
//  4. `storedFromLookup` skipping the gateway's own home check.
//     → "a gateway that still reads the bucket first reads it" fails.
//  5. `carriedBody` not clearing the body once served.
//     → "the carried body serves one read; the next asks the store" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { withWorkspaceRouting } from "../src/store/workspaceRouting.js";
import { withIdLayout } from "../src/store/idLayout.js";
import { objectFirstHooks } from "../src/store/objectLookup.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { toolWriteNote } from "../src/tools/notes/write.js";
import { durableSqlite } from "./durableSqlite.mjs";

const NOTE_ID = "0199a000-0000-7000-8000-0000000000e1";
const SECRET_ID = "0199a000-0000-7000-8000-0000000000e2";
const TEX_ID = "0199a000-0000-7000-8000-0000000000e3";
const PATH = "1-projects/plan.md";
const SECRET = "2-areas/secret.md";
const TEX = "tex/about.md";
const KEY = `notes/${NOTE_ID}.md`;
const SECRET_KEY = `notes/${SECRET_ID}.md`;
const TEX_KEY = `tex/person:ws/notes/${TEX_ID}.md`;
const HELD = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }, { prefix: "2-areas", visibility: "private" }], notes: [] };
const RULES = [{ prefix: "1-projects", vis: "team" }, { prefix: "2-areas", vis: "private" }];

async function world({ objectHome = "object", gatewayHome = "object" } = {}) {
  const { sql, transact } = durableSqlite();
  const side = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  side.rows.pinWorkspace("ws");
  side.rows.put([
    { id: "folder-1", path: "1-projects", kind: "folder", at: 1 },
    { id: "folder-2", path: "2-areas", kind: "folder", at: 1 },
    { id: "row-1", noteId: NOTE_ID, path: PATH, kind: "file", at: 1, storageKey: KEY },
    { id: "row-2", noteId: SECRET_ID, path: SECRET, kind: "file", at: 1, storageKey: SECRET_KEY },
    { id: "row-3", noteId: TEX_ID, path: TEX, kind: "file", at: 1, storageKey: TEX_KEY },
  ]);
  side.rows.putRules(HELD, "member");
  side.rows.setHome(objectHome);
  side.rows.markBackfilled(1);
  const calls = [];
  const stub = {
    fetch: (request) => {
      calls.push(JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "{}")).op);
      return serveWorkspaceStore(side, request);
    },
  };
  const ask = async (op, fields) =>
    await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  const client = {
    bodies: new R2Store(texBucket(stub)),
    rows: { lookup: (fields) => ask("ws.rows.lookup", fields) },
    // The merge, run in the object as in production (`collabReplace.js`).
    collab: { replace: (fields) => ask("ws.collab.replace", fields) },
  };
  for (const [key, text] of [[KEY, "\uFEFF# Plan\n\nFirst words.\n"], [SECRET_KEY, "# Secret\n"], [TEX_KEY, "# About\n"]]) await client.bodies.put(key, text);
  const etags = Object.fromEntries(await Promise.all([KEY, SECRET_KEY, TEX_KEY].map(async (key) => [key, (await client.bodies.head(key)).etag])));
  side.rows.put([
    { id: "row-1", noteId: NOTE_ID, path: PATH, kind: "file", at: 2, storageKey: KEY, etag: etags[KEY] },
    { id: "row-2", noteId: SECRET_ID, path: SECRET, kind: "file", at: 2, storageKey: SECRET_KEY, etag: etags[SECRET_KEY] },
  ]);

  const { sql: bucketSql } = durableSqlite();
  const bucketSide = { objects: texObjects(bucketSql), rows: workspaceRows(bucketSql) };
  const bucket = new R2Store(texBucket({ fetch: (request) => serveWorkspaceStore(bucketSide, request) }));
  // The bucket's copy differs, so a test can tell which side answered.
  await bucket.put(KEY, "# Plan\n\nBucket words.\n");
  const routed = withWorkspaceRouting(bucket, { workspaceId: "ws", client, known: { home: gatewayHome, backfilledAt: 1 } });
  const control = {
    lookup: async (paths) => ({ keyed: true, notes: Object.fromEntries(paths.map((path) => [path, { state: "gone" }])), texHomes: {} }),
    wrote: async () => ({ recorded: true }),
    adopt: async () => ({ adopted: true, taken: null }),
    removed: async () => ({ removed: true }),
  };
  const layered = (scope) => withIdLayout(routed, objectFirstHooks(control, { client, home: "object", scope, names: [], workspaceId: "ws" }));
  calls.length = 0;
  return { side, client, calls, ask, etags, store: layered("private"), team: layered("team") };
}

const lookupWithBody = (ask, path, scope = "private") => ask("ws.rows.lookup", { paths: [path], scope, groups: [], audience: "member", withBody: true });

test("an edit asks the object once before it saves, and saves what it was asked to", async () => {
  const { store, calls, client, etags } = await world();
  const result = await toolWriteNote(store, "private", RULES, undefined, { path: PATH, content: "# Plan\n\nSecond words.\n", expected_etag: etags[KEY] });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const merged = calls.indexOf("ws.collab.replace");
  assert.ok(merged > 0, calls.join(", "));
  assert.deepEqual(calls.slice(0, merged), ["ws.rows.lookup"], `asked more than the lookup before the merge: ${calls.join(", ")}`);
  assert.match(await (await client.bodies.get(KEY)).text(), /Second words\./);
});

test("a stale etag is still refused, from the carried body's version", async () => {
  const { store, client } = await world();
  const stale = await toolWriteNote(store, "private", RULES, undefined, { path: PATH, content: "# Plan\n\nNope.\n", expected_etag: "not-the-etag" });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /conflict/);
  assert.match(await (await client.bodies.get(KEY)).text(), /First words\./);
});

test("the carried body is the stored bytes exactly, with the stored metadata", async () => {
  const { store, client } = await world();
  const view = store.oneWrite(store);
  const carried = await view.get(PATH);
  const direct = await client.bodies.get(KEY);
  assert.deepEqual(new Uint8Array(await carried.arrayBuffer()), new Uint8Array(await direct.arrayBuffer()));
  for (const field of ["key", "etag", "size", "httpEtag"]) assert.equal(carried[field], direct[field], field);
  assert.equal(carried.uploaded.getTime(), direct.uploaded.getTime());
});

test("a note this reader may not see carries no body", async () => {
  const { ask } = await world();
  const team = await lookupWithBody(ask, SECRET, "team");
  assert.equal(team.rows[0].found, false);
  assert.equal(team.rows[0].body, undefined);
  const owner = await lookupWithBody(ask, SECRET, "private");
  assert.equal(owner.rows[0].found, true);
  assert.equal(owner.rows[0].body.text, "# Secret\n");
});

test("a Tex note, a folder and a lookup of several paths carry none", async () => {
  const { ask } = await world();
  assert.equal((await lookupWithBody(ask, TEX)).rows[0].body, undefined);
  assert.equal((await lookupWithBody(ask, "1-projects")).rows[0].body, undefined);
  const several = await ask("ws.rows.lookup", { paths: [PATH, SECRET], scope: "private", groups: [], audience: "member", withBody: true });
  assert.ok(several.rows.every((row) => row.found === true && row.body === undefined));
  const asked = await ask("ws.rows.lookup", { paths: [PATH], scope: "private", groups: [], audience: "member" });
  assert.equal(asked.rows[0].body, undefined, "a lookup that did not ask carries none");
});

test("a workspace whose notes are not in the object yet carries none", async () => {
  const { ask } = await world({ objectHome: "dual", gatewayHome: "dual" });
  assert.equal((await lookupWithBody(ask, PATH)).rows[0].body, undefined);
});

test("a gateway that still reads the bucket first reads it", async () => {
  const { store, calls } = await world({ objectHome: "object", gatewayHome: "dual" });
  const view = store.oneWrite(store);
  const found = await view.get(PATH);
  assert.match(await found.text(), /Bucket words\./);
  // The object carried the body, but the gateway's home says the bucket answers: it is read there (a separate store).
  assert.deepEqual(calls, ["ws.rows.lookup"]);
});

test("the carried body serves one read; the next asks the store", async () => {
  const { store, calls } = await world();
  const view = store.oneWrite(store);
  assert.match(await (await view.get(PATH)).text(), /First words\./);
  assert.deepEqual(calls, ["ws.rows.lookup"]);
  assert.match(await (await view.get(PATH)).text(), /First words\./);
  assert.deepEqual(calls, ["ws.rows.lookup", "get"]);
});

test("a ranged read is never served from the carried body", async () => {
  const { store, calls } = await world();
  const view = store.oneWrite(store);
  await view.get(PATH, { range: { offset: 0, length: 3 } });
  assert.deepEqual(calls, ["ws.rows.lookup", "get"]);
});

test("a read outside a write view never asks for a body", async () => {
  const { store, calls } = await world();
  assert.match(await (await store.get(PATH)).text(), /First words\./);
  assert.deepEqual(calls, ["ws.rows.lookup", "get"]);
});
