// `ws.write.narrowMoves` (src/workspaceStore/accessMove.js): a row moved where it would be seen wider than where it
// stood is pinned to its narrower base on its own row, decided in the object. Proves: a private note moved into a team
// folder takes base `private` (one version, the rules render at its live path until the move lands, one mirror change
// `narrowBases` with the row); a note already team moved within the folder pins nothing and queues nothing at the
// held version; a row already private keeps its held base and queues nothing; a batch of two private moves pins both
// in one mirror change at one version; NOT_READY with no access set held; an empty moves list or a move without `to`
// is a 422; and a moved row keeps its grantees when it is pinned.
//
// Sabotage, confirmed to fail here: the `if (carry === there) continue;` line in accessMove.js made an unconditional
// `continue;` (tests 1, 4 and 7 fail, each expecting a pin and a queued change; tests 2, 3, 5 and 6 still pass, as
// they expect none). The file was restored and diffed identical afterwards.
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

/** `ws.write.narrowMoves` as `serve.js` dispatches it: the body's status and JSON. */
async function narrow(store, fields, now = 4) {
  const response = await serveWrites(store, "ws.write.narrowMoves", { workspaceId: WS, ...fields }, now);
  return { status: response.status, body: await response.json() };
}

const queued = (mirror) => mirror.pending(10).map((entry) => entry.change ?? entry);

test("a private note moved into a team folder is pinned private on its own row: one version, one mirror change", async () => {
  const { store, mirror } = objectStore();
  await push(store, setOf(5, [FOLDER_TEAM]));
  const now = 4;
  const moved = await narrow(store, { moves: [{ from: "notes/me.md", to: "projects/me.md" }] }, now);
  assert.deepEqual(moved, { status: 200, body: { ok: true, version: Math.max(now, 6), pinned: 1 } });

  const record = store.access.set().rows.find((row) => row.token === ME);
  assert.equal(record.base, "private");

  // The row has not moved yet, so the rules still render at its live path.
  assert.equal(store.rows.rules("member").notes.some((note) => note.path === "notes/me.md" && note.visibility === "private"), true);

  const changes = queued(mirror);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "narrowBases");
  assert.deepEqual(changes[0].record, {
    rows: [{ rowId: "row-me", base: "private" }],
    baseVersion: 5,
    version: Math.max(now, 6),
  });
});

test("a note already team, moved within projects: nothing pinned, nothing queued, version held", async () => {
  const { store, mirror } = objectStore();
  await push(store, setOf(5, [FOLDER_TEAM]));
  const moved = await narrow(store, { moves: [{ from: "projects/plan.md", to: "projects/sub/plan.md" }] });
  assert.deepEqual(moved, { status: 200, body: { ok: true, version: 5, pinned: 0 } });
  assert.equal(mirror.count(), 0);
});

test("a row already private keeps its held base when moved into a team folder: nothing pinned, nothing queued", async () => {
  const { store, mirror } = objectStore();
  await push(store, setOf(5, [FOLDER_TEAM, { token: ME, kind: "file", path: "notes/me.md", base: "private", grantees: [] }]));
  const moved = await narrow(store, { moves: [{ from: "notes/me.md", to: "projects/me.md" }] });
  assert.deepEqual(moved, { status: 200, body: { ok: true, version: 5, pinned: 0 } });
  assert.equal(mirror.count(), 0);
});

test("two private notes moved into projects: both pinned, one mirror change with both rows, one version", async () => {
  const { store, mirror } = objectStore();
  await push(store, setOf(5, [FOLDER_TEAM]));
  const now = 4;
  const moved = await narrow(store, {
    moves: [
      { from: "notes/me.md", to: "projects/me.md" },
      { from: "tex/groups/x/a.md", to: "projects/a.md" },
    ],
  }, now);
  assert.deepEqual(moved, { status: 200, body: { ok: true, version: Math.max(now, 6), pinned: 2 } });

  const changes = queued(mirror);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].record.rows, [
    { rowId: "row-me", base: "private" },
    { rowId: "row-chat", base: "private" },
  ]);
  assert.equal(changes[0].record.version, Math.max(now, 6));
  const held = store.access.set().rows;
  assert.equal(held.find((row) => row.token === ME).base, "private");
  assert.equal(held.find((row) => row.token === "row-chat").base, "private");
});

test("NOT_READY with no access set held", async () => {
  const { store, mirror } = objectStore();
  const answer = await narrow(store, { moves: [{ from: "notes/me.md", to: "projects/me.md" }] });
  assert.deepEqual(answer, { status: 200, body: { ok: false, code: "NOT_READY" } });
  assert.equal(mirror.count(), 0);
});

test("bad input: an empty moves list, or a move missing to, is a 422", async () => {
  const { store, mirror } = await ready();
  assert.equal((await narrow(store, { moves: [] })).status, 422);
  assert.equal((await narrow(store, { moves: [{ from: "notes/me.md" }] })).status, 422);
  assert.equal(mirror.count(), 0);
});

test("a moved row keeps its grantees: a user grant on a row with no base is kept when pinned private", async () => {
  const { store, mirror } = objectStore();
  await push(store, setOf(5, [
    FOLDER_TEAM,
    { token: ME, kind: "file", path: "notes/me.md", base: null, grantees: [{ kind: "user", id: U1, role: "view" }] },
  ]));
  const moved = await narrow(store, { moves: [{ from: "notes/me.md", to: "projects/me.md" }] });
  assert.deepEqual(moved, { status: 200, body: { ok: true, version: 6, pinned: 1 } });

  const record = store.access.set().rows.find((row) => row.token === ME);
  assert.equal(record.base, "private");
  assert.deepEqual(record.grantees, [{ kind: "user", id: U1, role: "view" }]);
  assert.equal(queued(mirror).length, 1);
});
