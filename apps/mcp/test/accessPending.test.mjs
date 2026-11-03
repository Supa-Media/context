// `ws.write.access` on a path with no row yet (src/workspaceStore/accessWrite.js `writePending`), and `ws.write.adopt`
// taking that access (`accessRows.js` `takePending`). Proves: a note saved private under a team folder is closed by
// the object before its row exists, then adopted in the object rather than deferred, its pending entry becoming the
// note's own access record in the same transaction, with the rules unchanged; the mirror gets the pending change first
// and the adoption after; a list change at a path with no row is NO_ROW and a member's base is FORBIDDEN; inherit drops
// a waiting entry; an entry past the cap is PENDING_FULL.
//
// Sabotage, confirmed to fail here: `ws.write.adopt` without `takePending` (the record assertions fail), and the
// pending branch answering NO_ROW (the adoption defers).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceAccess } from "../src/workspaceStore/accessRows.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveWrites } from "../src/workspaceStore/serveWrites.js";
import { idKeyFor } from "../src/store/noteIdKeys.js";
import { renderAccess } from "../src/privacy/rowAccess.js";
import { durableSqlite } from "./durableSqlite.mjs";

// Fake identifiers only.
const WS = "ws_one";
const FOLDER = "0190aaaa-0000-7000-8000-0000000000f0";
const PLAN = "0190aaaa-0000-7000-8000-00000000000a";
const ME = "0190aaaa-0000-7000-8000-00000000000b";
const OWNER = { role: "owner", userId: "user-owner" };
const EDITOR = { role: "editor", userId: "user-editor" };
const MEMBER = { role: "member", userId: "user-member" };
const U = { kind: "user", id: "user-u1", role: "view" };

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** A workspace object's store as `ready()` builds it, over real SQLite, with its tree rows seeded. */
function objectStore({ flushDone = true } = {}) {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  const access = workspaceAccess(sql);
  const mirror = mirrorOutbox(sql);
  const counts = { flushes: 0, soon: 0 };
  const flush = { done: flushDone };
  const store = {
    sql,
    rows,
    access,
    mirror,
    transact,
    objects: texObjects(sql),
    flushMirror: async () => {
      counts.flushes += 1;
      return { done: flush.done };
    },
    mirrorSoon: () => {
      counts.soon += 1;
    },
  };
  rows.put([
    { id: FOLDER, path: "projects", kind: "folder", at: 1 },
    { id: "row-plan", noteId: PLAN, path: "projects/plan.md", kind: "file", at: 1 },
    { id: "row-me", noteId: ME, path: "notes/me.md", kind: "file", at: 1 },
    { id: "row-tex", path: "tex", kind: "folder", at: 1 },
    { id: "row-chat", path: "tex/groups/x/a.md", kind: "file", at: 1 },
  ]);
  return { store, mirror, counts, flush };
}

/** An access set as the control plane pushes it (`{token, kind, path, base, grantees}` rows). */
function setOf(version, rows, extra = {}) {
  return { version, rows, pending: [], accounts: false, sealsChats: false, moving: 0, ...extra };
}

const FOLDER_TEAM = { token: FOLDER, kind: "folder", path: "projects", base: "team", grantees: [] };

/** A set row as `renderAccess` takes it (`AccessRow`). */
function toAccessRow(row) {
  return {
    path: row.path,
    noteId: row.token,
    kind: row.kind,
    grantees: row.grantees,
    ...(row.base ? { base: row.base } : {}),
    ...(row.sealed ? { sealed: true } : {}),
  };
}

/** The rules one audience is judged by, rendered by `renderAccess` (the gateway's port) from the rows as sent. */
function rendered(rows, audience, accessVersion) {
  const { rules, overrides } = renderAccess(rows.map(toAccessRow), audience);
  return {
    accessVersion,
    folders: rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })).sort(byKey("prefix")),
    notes: [...overrides].map(([path, visibility]) => ({ path, visibility })).sort(byKey("path")),
  };
}

/** The rules a push carries for a set: the sealed chat homes render as the object's own judging does when sealed. */
function rulesOf(set) {
  const judged = set.sealsChats ? [...set.rows, { path: "tex/groups", token: "sealed-chats", kind: "folder", grantees: [], sealed: true }] : set.rows;
  return { member: rendered(judged, "member", set.version), guest: rendered(judged, "guest", set.version) };
}

/** A Convex push: `ws.apply` with rules and the access set, through the object's dispatch. */
async function push(store, set, rules = rulesOf(set)) {
  const request = new Request("https://ws.test/call", {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.apply" })) },
    body: JSON.stringify({ workspaceId: WS, rows: [], removed: [], at: 1, rules, access: set }),
  });
  const response = await serveWorkspaceStore(store, request);
  assert.equal(response.status, 200);
  return response.json();
}

/** An object that has taken the access set at version 5 (projects/ open to the team) with its parity equal. */
async function ready({ flushDone = true, set = {} } = {}) {
  const object = objectStore({ flushDone });
  const sent = setOf(5, [FOLDER_TEAM], set);
  const pushed = await push(object.store, sent);
  assert.equal(pushed.access.kept, true);
  return { ...object, pushed };
}

/** `ws.write.access` as `serve.js` dispatches it: the body's status and JSON. */
async function write(store, fields, now = 4) {
  const response = await serveWrites(store, "ws.write.access", { workspaceId: WS, ...fields }, now);
  return { status: response.status, body: await response.json() };
}

const NEW_NOTE = "0190aaaa-0000-7000-8000-0000000000c1";
const NEW_PATH = "projects/new.md";

/** `ws.write.adopt` as the gateway sends it after its put (`store/objectLookup.js` adopt). */
async function adopt(store, tier, now = 6) {
  const fields = { workspaceId: WS, path: NEW_PATH, noteId: NEW_NOTE, key: idKeyFor(NEW_NOTE, NEW_PATH), etag: "e-1", size: 3, at: now, tier };
  const response = await serveWrites(store, "ws.write.adopt", fields, now, () => "o_" + "c".repeat(32));
  return { status: response.status, body: await response.json() };
}

const queued = (mirror) => mirror.pending(10).map((entry) => entry.change ?? entry);

test("a private note under a team folder is closed before its row exists, then adopted in the object, not deferred", async () => {
  const { store, mirror, counts } = await ready();
  const asked = await write(store, { path: NEW_PATH, base: "private", actor: OWNER }, 9);
  assert.deepEqual(asked, { status: 200, body: { ok: true, version: 9 } });
  assert.deepEqual(store.rows.rules("member").notes, [{ path: NEW_PATH, visibility: "private" }]);
  assert.deepEqual(store.rows.rules("guest").notes, [{ path: NEW_PATH, visibility: "private" }]);
  assert.equal(counts.flushes, 0);
  const pendingSet = store.access.set();
  assert.equal(pendingSet.pending.length, 1);
  assert.equal(pendingSet.pending[0].base, "private");

  const adopted = await adopt(store, "private", 10);
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.adopted, true);
  const after = store.access.set();
  assert.deepEqual(after.pending, []);
  assert.deepEqual(
    after.rows.find((row) => row.token === NEW_NOTE),
    { token: NEW_NOTE, kind: "file", path: NEW_PATH, base: "private", grantees: [] },
  );
  // The version does not move on adoption and the rules a reader is judged by are the same.
  assert.equal(after.version, 9);
  assert.deepEqual(store.access.render("member", undefined, 10).notes, [{ path: NEW_PATH, visibility: "private" }]);

  const ops = queued(mirror).map((change) => change.op);
  assert.deepEqual(ops, ["accessPending", "adopt"]);
  const pendingChange = queued(mirror)[0];
  assert.equal(pendingChange.record.path, NEW_PATH);
  assert.equal(pendingChange.record.base, "private");
  assert.equal(pendingChange.record.narrowing, true);
  assert.equal(pendingChange.record.baseVersion, 5);
  assert.equal(pendingChange.record.version, 9);
});

test("without the tier asked first, a private note under a team folder is deferred to the control plane", async () => {
  const { store } = await ready();
  const adopted = await adopt(store, "private");
  assert.deepEqual(adopted.body, { ok: false, code: "DEFER", reason: "wider_here" });
});

test("a list change at a path with no row is NO_ROW; a member's base is FORBIDDEN; nothing is queued", async () => {
  const { store, mirror } = await ready();
  assert.deepEqual((await write(store, { path: NEW_PATH, grantees: [U], actor: OWNER })).body, { ok: false, code: "NO_ROW" });
  assert.deepEqual((await write(store, { path: NEW_PATH, base: "private", actor: MEMBER })).body, { ok: false, code: "FORBIDDEN" });
  assert.equal(mirror.count(), 0);
  assert.deepEqual(store.access.set().pending, []);
});

test("inherit with nothing waiting is a no-op; inherit drops a waiting entry and is not a narrowing", async () => {
  const { store, mirror } = await ready();
  assert.deepEqual((await write(store, { path: NEW_PATH, base: "inherit", actor: OWNER })).body, { ok: true, version: 5 });
  assert.equal(mirror.count(), 0);
  await write(store, { path: NEW_PATH, base: "private", actor: EDITOR }, 9);
  const dropped = await write(store, { path: NEW_PATH, base: "inherit", actor: OWNER }, 11);
  assert.deepEqual(dropped.body, { ok: true, version: 11 });
  assert.deepEqual(store.access.set().pending, []);
  assert.deepEqual(store.rows.rules("member").notes, []);
  const last = queued(mirror).at(-1);
  assert.equal(last.op, "accessPending");
  assert.equal(last.record.base, null);
  assert.equal(last.record.narrowing, false);
});

test("the same base asked again is a no-op; a team entry is kept but not rendered", async () => {
  const { store, mirror } = await ready();
  await write(store, { path: NEW_PATH, base: "private", actor: OWNER }, 9);
  assert.deepEqual((await write(store, { path: NEW_PATH, base: "private", actor: OWNER }, 12)).body, { ok: true, version: 9 });
  assert.equal(mirror.count(), 1);
  await write(store, { path: "projects/other.md", base: "team", actor: OWNER }, 13);
  assert.equal(store.access.set().pending.length, 2);
  assert.deepEqual(store.rows.rules("member").notes, [{ path: NEW_PATH, visibility: "private" }]);
});

test("PENDING_FULL past the cap, and nothing is written", async () => {
  const pending = Array.from({ length: 100 }, (_, i) => ({ path: `projects/p${i}.md`, kind: "file", base: "team", at: 3 }));
  const { store, mirror } = await ready({ set: { pending } });
  const before = store.access.set().version;
  assert.deepEqual((await write(store, { path: NEW_PATH, base: "private", actor: OWNER })).body, { ok: false, code: "PENDING_FULL" });
  assert.equal(store.access.set().version, before);
  assert.equal(mirror.count(), 0);
});
