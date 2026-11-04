// `ws.write.access` with `handles` (src/workspaceStore/accessWrite.js `namedGrantees`), resolved from the object's own
// cache of names (src/workspaceStore/handleCache.js). Proves: a handle nobody has resolved is RESOLVE and writes nothing;
// the control plane's answer, sent back as `resolved`, is kept and the grantee is added in the object; a later call by a
// cached name, in any case, is answered from the cache; a cache entry older than HANDLE_TTL_MS is asked again; a group
// resolves to a group grantee; a malformed `resolved` or `handles` without `mode: "add"` is refused (422) and writes
// nothing; an editor's list change is FORBIDDEN; emails and handles land together.
//
// Sabotage, confirmed to fail here: `ctx.handles?.get(...)` always null (the cached-handle case answers RESOLVE again).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceAccess } from "../src/workspaceStore/accessRows.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { workspaceHandles, HANDLE_TTL_MS } from "../src/workspaceStore/handleCache.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveWrites } from "../src/workspaceStore/serveWrites.js";
import { renderAccess } from "../src/privacy/rowAccess.js";
import { durableSqlite } from "./durableSqlite.mjs";

// Fake identifiers only.
const WS = "ws_one";
const FOLDER = "0190aaaa-0000-7000-8000-0000000000f0";
const PLAN = "0190aaaa-0000-7000-8000-00000000000a";
const ME = "0190aaaa-0000-7000-8000-00000000000b";
const OWNER = { role: "owner", userId: "user-owner" };
const EDITOR = { role: "editor", userId: "user-editor" };
const ANA = { handle: "@ana", kind: "user", id: "user-ana" };

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** A workspace object's store as `ready()` builds it, over real SQLite, with its tree rows and handle cache seeded. */
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
    handles: workspaceHandles(sql),
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

/** The rules a push carries for a set. */
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

const queued = (mirror) => mirror.pending(10).map((entry) => entry.change ?? entry);
const version = (store) => store.access.set().version;

test("a handle nobody has resolved answers RESOLVE with the handle, and writes nothing", async () => {
  const { store, mirror } = await ready();
  const before = version(store);
  const asked = await write(store, { path: "projects/plan.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], actor: OWNER });
  assert.deepEqual(asked, { status: 200, body: { ok: false, code: "RESOLVE", handles: ["@ana"] } });
  assert.equal(mirror.count(), 0);
  assert.equal(version(store), before);
});

test("the control plane's resolution, sent back as `resolved`, adds the grantee in the object", async () => {
  const { store, mirror } = await ready();
  const answer = await write(store, {
    path: "projects/plan.md",
    mode: "add",
    handles: [{ handle: "@ana", role: "view" }],
    resolved: [{ handle: "@ana", kind: "user", id: "user-ana" }],
    actor: OWNER,
  });
  assert.deepEqual(answer, { status: 200, body: { ok: true, version: 6 } });
  const plan = store.access.set().rows.find((row) => row.path === "projects/plan.md");
  assert.deepEqual(plan.grantees, [{ kind: "user", id: "user-ana", role: "view" }]);
  const changes = queued(mirror);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "access");
  assert.deepEqual(changes[0].record.added, [{ kind: "user", id: "user-ana", role: "view" }]);
});

test("after resolution, a call by the same name in another case is answered from the cache", async () => {
  const { store, mirror } = await ready();
  await write(store, { path: "projects/plan.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], resolved: [ANA], actor: OWNER }, 4);
  const again = await write(store, { path: "notes/me.md", mode: "add", handles: [{ handle: "@Ana", role: "edit" }], actor: OWNER }, 5);
  assert.equal(again.status, 200);
  assert.equal(again.body.ok, true, JSON.stringify(again.body));
  const me = store.access.set().rows.find((row) => row.path === "notes/me.md");
  assert.deepEqual(me.grantees, [{ kind: "user", id: "user-ana", role: "edit" }]);
  assert.equal(mirror.count(), 2);
});

test("a cache entry older than HANDLE_TTL_MS is asked again", async () => {
  const { store } = await ready();
  await write(store, { path: "projects/plan.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], resolved: [ANA], actor: OWNER }, 4);
  const stale = await write(store, { path: "notes/me.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], actor: OWNER }, 4 + HANDLE_TTL_MS + 10);
  assert.deepEqual(stale.body, { ok: false, code: "RESOLVE", handles: ["@ana"] });
});

test("a group handle resolves to a group grantee", async () => {
  const { store } = await ready();
  const answer = await write(store, {
    path: "projects/plan.md",
    mode: "add",
    handles: [{ handle: "@leads", role: "edit" }],
    resolved: [{ handle: "@leads", kind: "group", id: "group-leads" }],
    actor: OWNER,
  });
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
  const plan = store.access.set().rows.find((row) => row.path === "projects/plan.md");
  assert.deepEqual(plan.grantees, [{ kind: "group", id: "group-leads", role: "edit" }]);
});

test("a malformed `resolved` (kind email, or an id containing a slash) is 422 and writes nothing", async () => {
  for (const bad of [
    [{ handle: "@ana", kind: "email", id: "user-ana" }],
    [{ handle: "@ana", kind: "user", id: "user/ana" }],
  ]) {
    const { store, mirror } = await ready();
    const before = version(store);
    const answer = await write(store, { path: "projects/plan.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], resolved: bad, actor: OWNER });
    assert.equal(answer.status, 422, JSON.stringify(bad));
    assert.equal(mirror.count(), 0, JSON.stringify(bad));
    assert.equal(version(store), before, JSON.stringify(bad));
    assert.equal(store.handles.get("@ana", 4), null, "nothing cached from a malformed list");
  }
});

test("`handles` without mode \"add\" is 422 and writes nothing", async () => {
  const { store, mirror } = await ready();
  const before = version(store);
  const answer = await write(store, { path: "projects/plan.md", base: "private", handles: [{ handle: "@ana", role: "view" }], resolved: [ANA], actor: OWNER });
  assert.equal(answer.status, 422);
  assert.equal(mirror.count(), 0);
  assert.equal(version(store), before);
});

test("an editor adding by handle is FORBIDDEN: list changes are the owner's", async () => {
  const { store, mirror } = await ready();
  const answer = await write(store, { path: "projects/plan.md", mode: "add", handles: [{ handle: "@ana", role: "view" }], resolved: [ANA], actor: EDITOR });
  assert.deepEqual(answer.body, { ok: false, code: "FORBIDDEN" });
  assert.equal(mirror.count(), 0);
  assert.deepEqual(store.access.set().rows.find((row) => row.path === "projects/plan.md")?.grantees ?? [], []);
});

test("an email and a cached handle in one call both land", async () => {
  const { store, mirror } = await ready();
  store.handles.put([ANA], 4);
  const answer = await write(store, {
    path: "projects/plan.md",
    mode: "add",
    grantees: [{ kind: "email", id: "x@example.com", role: "view" }],
    handles: [{ handle: "@ana", role: "edit" }],
    actor: OWNER,
  });
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
  const plan = store.access.set().rows.find((row) => row.path === "projects/plan.md");
  assert.deepEqual(plan.grantees, [
    { kind: "email", id: "x@example.com", role: "view" },
    { kind: "user", id: "user-ana", role: "edit" },
  ]);
  assert.equal(queued(mirror).length, 1);
});
