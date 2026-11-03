// `ws.write.dropGrantee` (src/workspaceStore/accessDrop.js): one account's own grants taken out of every row of the
// workspace, in the object. Proves: an owner dropping an account takes its grant off each row that held it (and only
// those), mints one version, renders the member and guest rules from the narrowed set, and queues exactly one mirror
// change carrying the account and the count; the account itself may drop its own grants, while a member dropping
// someone else is FORBIDDEN with nothing queued; an account holding nothing is a no-op at the held version; NOT_READY
// with no access set held; a bad kind or a missing actor is a 422.
//
// Sabotage, confirmed to fail here: `holds` always returning false in accessDrop.js (tests 1 and 2 fail, the owner's
// and the account's own drops of 2 grants answering 0 with nothing queued; tests 3 to 5 still pass).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceAccess } from "../src/workspaceStore/accessRows.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
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
const MEMBER = { role: "member", userId: "user-member" };
const U1 = "user-u1";
const U2 = "user-u2";

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

/**
 * An object that has taken the access set at version 5: projects/ open to the team, and two notes granted to
 * `user-u1` (view) and PLAN also to `user-u2` (edit), with parity equal.
 */
async function ready({ flushDone = true, set = {} } = {}) {
  const object = objectStore({ flushDone });
  const rows = [
    FOLDER_TEAM,
    { token: PLAN, kind: "file", path: "projects/plan.md", base: "private", grantees: [
      { kind: "user", id: U1, role: "view" },
      { kind: "user", id: U2, role: "edit" },
    ] },
    { token: ME, kind: "file", path: "notes/me.md", base: "private", grantees: [{ kind: "user", id: U1, role: "view" }] },
  ];
  const sent = setOf(5, rows, set);
  const pushed = await push(object.store, sent);
  assert.equal(pushed.access.kept, true);
  return { ...object, pushed };
}

/** `ws.write.dropGrantee` as `serve.js` dispatches it: the body's status and JSON. */
async function drop(store, fields, now = 4) {
  const response = await serveWrites(store, "ws.write.dropGrantee", { workspaceId: WS, ...fields }, now);
  return { status: response.status, body: await response.json() };
}

const queued = (mirror) => mirror.pending(10).map((entry) => entry.change ?? entry);

test("an owner drops an account: its grant leaves every row, one version, rules narrowed, one mirror change", async () => {
  const { store, mirror, counts } = await ready();
  const now = 9;
  const dropped = await drop(store, { kind: "user", id: U1, actor: OWNER }, now);
  assert.deepEqual(dropped, { status: 200, body: { ok: true, version: Math.max(now, 6), dropped: 2 } });

  const after = store.access.set();
  assert.equal(after.rows.some((row) => row.grantees.some((grantee) => grantee.id === U1)), false);
  assert.deepEqual(
    after.rows.find((row) => row.token === PLAN).grantees,
    [{ kind: "user", id: U2, role: "edit" }],
  );
  assert.deepEqual(after.rows.find((row) => row.token === ME).grantees, []);

  assert.equal(JSON.stringify(store.rows.rules("member")).includes(U1), false);
  assert.equal(JSON.stringify(store.rows.rules("guest")).includes(U1), false);

  const changes = queued(mirror);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "dropGrantee");
  assert.deepEqual(changes[0].record, {
    kind: "user",
    id: U1,
    actorUserId: OWNER.userId,
    baseVersion: 5,
    version: Math.max(now, 6),
    dropped: 2,
  });
  assert.equal(counts.flushes, 0);
});

test("the account itself may drop its own grants; a member dropping someone else is FORBIDDEN and queues nothing", async () => {
  const own = await ready();
  const ownDrop = await drop(own.store, { kind: "user", id: U1, actor: { role: "member", userId: U1 } });
  assert.equal(ownDrop.status, 200);
  assert.deepEqual(ownDrop.body, { ok: true, version: 6, dropped: 2 });
  assert.equal(queued(own.mirror).length, 1);

  const other = await ready();
  const refused = await drop(other.store, { kind: "user", id: U1, actor: MEMBER });
  assert.deepEqual(refused, { status: 200, body: { ok: false, code: "FORBIDDEN" } });
  assert.equal(other.mirror.count(), 0);
  assert.equal(other.store.access.set().version, 5);
  assert.equal(other.store.access.set().rows.find((row) => row.token === ME).grantees.length, 1);
});

test("dropping an account that holds nothing is a no-op at the held version, nothing queued", async () => {
  const { store, mirror } = await ready();
  const none = await drop(store, { kind: "user", id: "user-u9", actor: OWNER });
  assert.deepEqual(none, { status: 200, body: { ok: true, version: 5, dropped: 0 } });
  assert.equal(mirror.count(), 0);
});

test("NOT_READY with no access set held", async () => {
  const { store, mirror } = objectStore();
  const answer = await drop(store, { kind: "user", id: U1, actor: OWNER });
  assert.deepEqual(answer, { status: 200, body: { ok: false, code: "NOT_READY" } });
  assert.equal(mirror.count(), 0);
});

test("bad input: kind email, or a missing actor.userId, is a 422", async () => {
  const { store, mirror } = await ready();
  assert.equal((await drop(store, { kind: "email", id: "a@example.test", actor: OWNER })).status, 422);
  assert.equal((await drop(store, { kind: "user", id: U1, actor: { role: "owner" } })).status, 422);
  assert.equal((await drop(store, { kind: "user", id: U1 })).status, 422);
  assert.equal(mirror.count(), 0);
});
