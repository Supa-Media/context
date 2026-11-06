// A note row copied in from the control plane carries the bucket's etag, and its body copied in carries this
// object's: a listing that reported the row's left every offline copy re-reading every untouched note on every pass
// (2026-11-06: 3,000 to 6,000 reads every ten minutes per workspace). A listing now stamps each row with the version
// its body here has, the one a read returns (`workspaceStore/rowVersions.js`).
// Sabotage: drop the `restampRowVersions` call before `ws.rows.files` in `workspaceStore/serve.js` → the first test
// fails (the listed etag is still the bucket's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { texObjects } from "../src/texStore/objects.js";
import { texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { restampRowVersions } from "../src/workspaceStore/rowVersions.js";
import { durableSqlite } from "./durableSqlite.mjs";

const NOTE_ID = "0199a000-0000-7000-8000-000000000001";
const KEY = `notes/${NOTE_ID}.md`;
const BUCKET_ETAG = "0cc175b9c0f1b6a831c399e269772661";

async function objectWithCopiedRow({ home = "object" } = {}) {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  store.rows.put([
    { id: "row-1", noteId: NOTE_ID, path: "plans/a.md", kind: "file", at: 1, storageKey: KEY, etag: BUCKET_ETAG },
    { id: "row-2", path: "plans", kind: "folder", at: 1 },
  ]);
  store.rows.setHome(home);
  store.rows.markBackfilled(1);
  const stub = { fetch: (request) => serveWorkspaceStore(store, request) };
  const bodies = new R2Store(texBucket(stub));
  await bodies.put(KEY, "# A\n\nthe plan\n");
  const ask = async (op, fields = {}) =>
    await (await stub.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  return { store, bodies, ask };
}

test("a listing reports the version a read of the note returns, not the bucket's", async () => {
  const { bodies, ask } = await objectWithCopiedRow();
  const read = await bodies.get(KEY);
  assert.notEqual(read.etag, BUCKET_ETAG, "the object hashes a body its own way");
  const page = await ask("ws.rows.files", { audience: "member" });
  assert.equal(page.served, true);
  const row = page.rows.find((entry) => entry.id === "row-1");
  assert.equal(row.etag, read.etag);
  // A second listing finds nothing left to stamp.
  const again = await ask("ws.rows.files", { audience: "member" });
  assert.equal(again.rows.find((entry) => entry.id === "row-1").etag, read.etag);
});

test("the stamp is the object's own change, so a later push of the copied row cannot put the bucket's back", async () => {
  const { store, bodies } = await objectWithCopiedRow();
  assert.equal(restampRowVersions(store.sql, store.rows, 10), 1);
  assert.equal(restampRowVersions(store.sql, store.rows, 11), 0);
  store.rows.put([{ id: "row-1", noteId: NOTE_ID, path: "plans/a.md", kind: "file", at: 2, storageKey: KEY, etag: BUCKET_ETAG }]);
  assert.equal(store.rows.byNoteId(NOTE_ID).etag, (await bodies.get(KEY)).etag);
});

test("a workspace still read from its bucket keeps the bucket's versions", async () => {
  const { store, ask } = await objectWithCopiedRow({ home: "dual" });
  assert.deepEqual(await ask("ws.rows.files", { audience: "member" }), { served: false });
  assert.equal(store.rows.byNoteId(NOTE_ID).etag, BUCKET_ETAG);
});
