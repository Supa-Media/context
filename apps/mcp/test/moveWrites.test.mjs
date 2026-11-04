// `ws.write.move` (src/workspaceStore/moveWrites.js) over a real object store through `serveWorkspaceStore`: a move or
// rename made in the object, with the access narrowing it needs queued first. Proves: a plain move queues one tree
// change and schedules a soon-flush (no flush awaited); a widening move pins the moved row private before the tree
// change; a move the object cannot judge (no access set) and a move the control plane must decide (a folder doing a
// job, a folder directly in the Inbox, a folder to the top level, a name that twins another by case) answer DEFER with
// nothing written; a caller judged by the team scope moves only what it may see; a refusal (TAKEN, CHANGED) queues
// nothing and, for a move that would narrow, leaves the access set as it was; a trash moves into the old copies with
// no narrowing; the audit line travels with the change only when a person is named; a body without a scope, or
// without from and to, is a 422.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceAccess } from "../src/workspaceStore/accessRows.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { renderAccess } from "../src/privacy/rowAccess.js";
import { durableSqlite } from "./durableSqlite.mjs";

// Fake identifiers only.
const WS = "ws_one";
const FOLDER = "0190aaaa-0000-7000-8000-0000000000f0";
const FOLDER_BOX = "0190aaaa-0000-7000-8000-0000000000f1";
const FOLDER_SECRET = "0190aaaa-0000-7000-8000-0000000000f2";
const FOLDER_INBOX = "0190aaaa-0000-7000-8000-0000000000f3";
const PLAN = "0190aaaa-0000-7000-8000-00000000000a";
const ME = "0190aaaa-0000-7000-8000-00000000000b";
const TEAM_NOTE = "0190aaaa-0000-7000-8000-00000000000c";
const SECRET_NOTE = "0190aaaa-0000-7000-8000-00000000000d";
const INBOX_NOTE = "0190aaaa-0000-7000-8000-00000000000e";
const TWIN = "0190aaaa-0000-7000-8000-00000000000g";
const U1 = "user-u1";
const U2 = "user-u2";

const OWNER = { scope: "private" };
const TEAM = { scope: "team" };

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** The object's tree rows: folders, and files with their storage keys and etags (a move of a file needs both). */
const ROWS = [
  { id: FOLDER, path: "projects", kind: "folder", at: 1 },
  { id: FOLDER_BOX, path: "projects/box", kind: "folder", at: 1 },
  { id: FOLDER_SECRET, path: "projects/secret", kind: "folder", at: 1 },
  { id: FOLDER_INBOX, path: "inbox", kind: "folder", at: 1 },
  { id: "row-inbox-sub", path: "inbox/sub", kind: "folder", at: 1 },
  { id: "row-launch", path: "projects/launch", kind: "folder", role: "clients", at: 1 },
  { id: "row-old", path: "notes/old", kind: "folder", at: 1 },
  { id: "row-archive", path: "archive", kind: "folder", role: "archive", at: 1 },
  { id: "row-plan", noteId: PLAN, path: "projects/plan.md", kind: "file", storageKey: "notes/plan.md", etag: "e-plan", at: 1 },
  { id: "row-me", noteId: ME, path: "notes/me.md", kind: "file", storageKey: "notes/me.md", etag: "e-me", at: 1 },
  { id: "row-team", noteId: TEAM_NOTE, path: "projects/team-note.md", kind: "file", storageKey: "notes/team.md", etag: "e-team", at: 1 },
  { id: "row-memo", noteId: SECRET_NOTE, path: "projects/secret/memo.md", kind: "file", storageKey: "notes/memo.md", etag: "e-memo", at: 1 },
  { id: "row-inbox-note", noteId: INBOX_NOTE, path: "inbox/x.md", kind: "file", storageKey: "notes/x.md", etag: "e-x", at: 1 },
  { id: "row-twin", noteId: TWIN, path: "resources/Brief.md", kind: "file", storageKey: "notes/brief.md", etag: "e-brief", at: 1 },
];

/** A workspace object as `ready()` builds it, over real SQLite, with its tree rows seeded and counters for flushes and soon-flushes. */
function objectStore({ flushDone = true } = {}) {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  rows.pinWorkspace(WS);
  rows.put(ROWS);
  const access = workspaceAccess(sql);
  const mirror = mirrorOutbox(sql);
  const counts = { flushes: 0, soon: 0 };
  const store = {
    sql,
    rows,
    access,
    mirror,
    transact,
    objects: texObjects(sql),
    flushMirror: async () => {
      counts.flushes += 1;
      return { done: flushDone };
    },
    mirrorSoon: () => {
      counts.soon += 1;
    },
  };
  return { store, mirror, counts };
}

/** An access set as the control plane pushes it (`{token, kind, path, base, grantees}` rows). */
function setOf(version, rows) {
  return { version, rows, pending: [], accounts: false, sealsChats: false, moving: 0 };
}

/** A set row as `renderAccess` takes it (`AccessRow`). */
function toAccessRow(row) {
  return {
    path: row.path,
    noteId: row.token,
    kind: row.kind,
    grantees: row.grantees,
    ...(row.base ? { base: row.base } : {}),
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

/** A Convex push: `ws.apply` with rules and the access set, through the object's dispatch. */
async function push(store, set) {
  const rules = { member: rendered(set.rows, "member", set.version), guest: rendered(set.rows, "guest", set.version) };
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
 * The access set the object judges by, at version 5: projects/ is team; projects/box and projects/secret are private
 * folders; PLAN is private with grants to two people; ME is private. Notes without a base inherit their folder's tier.
 */
const SET_ROWS = [
  { token: FOLDER, kind: "folder", path: "projects", base: "team", grantees: [] },
  { token: FOLDER_BOX, kind: "folder", path: "projects/box", base: "private", grantees: [] },
  { token: FOLDER_SECRET, kind: "folder", path: "projects/secret", base: "private", grantees: [] },
  { token: FOLDER_INBOX, kind: "folder", path: "inbox", base: "team", grantees: [] },
  { token: PLAN, kind: "file", path: "projects/plan.md", base: "private", grantees: [
    { kind: "user", id: U1, role: "view" },
    { kind: "user", id: U2, role: "edit" },
  ] },
  { token: ME, kind: "file", path: "notes/me.md", base: "private", grantees: [{ kind: "user", id: U1, role: "view" }] },
];

/** An object that has taken the access set: `ready` in the workspace's own sense. */
async function ready() {
  const object = objectStore();
  const pushed = await push(object.store, setOf(5, SET_ROWS));
  assert.equal(pushed.access.kept, true);
  // The seeding and the push queue nothing and schedule no flush; each test starts from zero.
  assert.equal(object.mirror.count(), 0);
  object.counts.flushes = 0;
  object.counts.soon = 0;
  return object;
}

/** `ws.write.move` through `serveWorkspaceStore`, as the gateway calls it. */
function callMove(store, fields, timing = undefined) {
  const request = new Request("https://ws.test/call", {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.write.move" })) },
    body: JSON.stringify({ workspaceId: WS, ...fields }),
  });
  return serveWorkspaceStore(store, request, timing);
}

const pathOf = (store, id) => store.rows.get([id])[0].path;
const queued = (mirror) => mirror.pending(20).map((entry) => entry.change);

test("an owner renames a note in a ready workspace: the row is at its new path, one tree change is queued, a soon-flush is scheduled", async () => {
  const { store, mirror, counts } = await ready();
  const response = await callMove(store, { from: "projects/plan.md", to: "projects/plan-renamed.md", ...OWNER });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer, {
    ok: true,
    from: "projects/plan.md",
    to: "projects/plan-renamed.md",
    count: 1,
    at: answer.at,
    files: [{ from: "projects/plan.md", to: "projects/plan-renamed.md" }],
    etag: "e-plan",
  });
  assert.equal(typeof answer.at, "number");
  assert.equal(pathOf(store, "row-plan"), "projects/plan-renamed.md");

  const changes = queued(mirror);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].op, "tree");
  assert.equal(changes[0].record.trash, false);
  assert.deepEqual(changes[0].record.moves[0], {
    id: "row-plan",
    kind: "file",
    from: "projects/plan.md",
    to: "projects/plan-renamed.md",
    at: answer.at,
  });
  assert.equal(counts.flushes, 0, "a move does not wait for the mirror");
  assert.equal(counts.soon, 1);
});

test("a team note moved into a private folder needs no narrowing: only the tree change is queued", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/team-note.md", to: "projects/box/team-note.md", ...OWNER });
  assert.equal((await response.json()).ok, true);
  assert.equal(pathOf(store, "row-team"), "projects/box/team-note.md");
  const changes = queued(mirror);
  assert.deepEqual(changes.map((change) => change.op), ["tree"]);
});

test("a note private by its own base moved within a team folder: already private, so only the tree change is queued", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/plan.md", to: "projects/sub/plan.md", ...OWNER });
  assert.equal((await response.json()).ok, true);
  assert.equal(pathOf(store, "row-plan"), "projects/sub/plan.md");
  assert.deepEqual(queued(mirror).map((change) => change.op), ["tree"]);
});

test("a private note inside a private folder, moved into a team folder, is pinned private first: narrowBases then tree", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/secret/memo.md", to: "projects/memo.md", ...OWNER });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.deepEqual(answer, {
    ok: true,
    from: "projects/secret/memo.md",
    to: "projects/memo.md",
    count: 1,
    at: answer.at,
    files: [{ from: "projects/secret/memo.md", to: "projects/memo.md" }],
    etag: "e-memo",
  });
  assert.equal(pathOf(store, "row-memo"), "projects/memo.md");

  const changes = queued(mirror);
  assert.deepEqual(changes.map((change) => change.op), ["narrowBases", "tree"]);
  assert.deepEqual(changes[0].record.rows, [{ rowId: "row-memo", base: "private" }]);
  assert.equal(changes[0].record.baseVersion, 5);
  assert.equal(store.access.set().rows.find((row) => row.token === SECRET_NOTE).base, "private");
  assert.equal(changes[1].record.moves[0].to, "projects/memo.md");
});

test("not ready: with no access set held, a move answers DEFER, the rows stay, and nothing is queued", async () => {
  const { store, mirror, counts } = objectStore();
  // Rules are held (the object can see), but no access set has been taken, so nothing is judged by the object.
  store.rows.putRules({
    etag: "rules-1",
    accessVersion: 1,
    folders: [{ prefix: "projects", visibility: "team" }],
    notes: [],
  });
  const rename = await callMove(store, { from: "projects/team-note.md", to: "projects/renamed.md", ...OWNER });
  assert.deepEqual(await rename.json(), { ok: false, code: "DEFER" });
  const narrowing = await callMove(store, { from: "notes/me.md", to: "projects/me.md", ...OWNER });
  assert.deepEqual(await narrowing.json(), { ok: false, code: "DEFER" });
  assert.equal(pathOf(store, "row-team"), "projects/team-note.md");
  assert.equal(pathOf(store, "row-me"), "notes/me.md");
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("a team member cannot move a private note, nor a team note into a private folder: NOT_FOUND, nothing queued", async () => {
  const { store, mirror, counts } = await ready();
  const privateNote = await callMove(store, { from: "notes/me.md", to: "projects/me.md", ...TEAM });
  assert.deepEqual(await privateNote.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "row-me"), "notes/me.md");

  const hiddenDestination = await callMove(store, { from: "projects/team-note.md", to: "projects/box/team-note.md", ...TEAM });
  assert.deepEqual(await hiddenDestination.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "row-team"), "projects/team-note.md");

  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("a team member moves a team note it can see within projects: the tree change is queued", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/team-note.md", to: "projects/team-moved.md", ...TEAM });
  assert.equal((await response.json()).ok, true);
  assert.equal(pathOf(store, "row-team"), "projects/team-moved.md");
  assert.deepEqual(queued(mirror).map((change) => change.op), ["tree"]);
});

test("a destination taken by a live row is TAKEN and nothing is queued", async () => {
  const { store, mirror, counts } = await ready();
  const response = await callMove(store, { from: "projects/team-note.md", to: "projects/plan.md", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "TAKEN" });
  assert.equal(pathOf(store, "row-team"), "projects/team-note.md");
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("a move that would narrow to a taken name is TAKEN, and the access set is unchanged: no pinned record, nothing queued", async () => {
  const { store, mirror, counts } = await ready();
  const before = JSON.stringify(store.access.set());
  // The same note as the pinned case, to a name a live row holds: the narrowing it needs is never written.
  const response = await callMove(store, { from: "projects/secret/memo.md", to: "projects/plan.md", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "TAKEN" });
  assert.equal(JSON.stringify(store.access.set()), before);
  assert.equal(pathOf(store, "row-memo"), "projects/secret/memo.md");
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("moves the control plane decides answer DEFER and move nothing: a job folder, a folder in the Inbox, a folder to the top level, a name twinned by case", async () => {
  const cases = [
    ["a folder with a role", { from: "projects/launch", to: "projects/renamed-launch" }, "projects/launch"],
    ["a folder directly inside the Inbox", { from: "inbox/sub", to: "projects/sub" }, "inbox/sub"],
    ["a folder to the top level", { from: "notes/old", to: "old" }, "notes/old"],
    ["a destination that differs only by case from a live row", { from: "notes/me.md", to: "resources/brief.md" }, "notes/me.md"],
  ];
  for (const [label, move, heldAt] of cases) {
    const { store, mirror, counts } = await ready();
    const response = await callMove(store, { ...move, ...OWNER });
    assert.deepEqual(await response.json(), { ok: false, code: "DEFER" }, label);
    const rowIds = { "projects/launch": "row-launch", "inbox/sub": "row-inbox-sub", "notes/old": "row-old", "notes/me.md": "row-me" };
    assert.equal(pathOf(store, rowIds[heldAt]), heldAt, label);
    assert.equal(mirror.count(), 0, label);
    assert.equal(counts.flushes + counts.soon, 0, label);
  }
});

test("a note moved into Archive is made in the object: Convex marks its twins when the mirror takes it", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "notes/me.md", to: "archive/notes/me.md", ...OWNER });
  assert.equal((await response.json()).ok, true);
  assert.equal(pathOf(store, "row-me"), "archive/notes/me.md");
  assert.ok(queued(mirror).some((change) => change.op === "tree"));
});

test("a plain file moved out of the Inbox into a projects folder is not deferred: the move and its tree change are made", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "inbox/x.md", to: "projects/x.md", ...OWNER });
  assert.equal((await response.json()).ok, true);
  assert.equal(pathOf(store, "row-inbox-note"), "projects/x.md");
  assert.deepEqual(queued(mirror).map((change) => change.op), ["tree"]);
});

test("trash: true to a name among the old copies moves the note there, with no narrowing", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/plan.md", to: ".context/old-copies/x/plan.md", trash: true, ...OWNER });
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.to, ".context/old-copies/x/plan.md");
  assert.equal(pathOf(store, "row-plan"), ".context/old-copies/x/plan.md");
  const changes = queued(mirror);
  assert.deepEqual(changes.map((change) => change.op), ["tree"]);
  assert.equal(changes[0].record.trash, true);
  assert.equal(changes[0].record.moves[0].to, ".context/old-copies/x/plan.md");
});

test("trash: true to any other path is refused as a 422, and nothing is queued", async () => {
  const { store, mirror } = await ready();
  const response = await callMove(store, { from: "projects/plan.md", to: "projects/elsewhere.md", trash: true, ...OWNER });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "refused");
  assert.equal(pathOf(store, "row-plan"), "projects/plan.md");
  assert.equal(mirror.count(), 0);
});

test("a stale expectedEtag is CHANGED with the current etag, and nothing is queued; the right one moves the note", async () => {
  const { store, mirror } = await ready();
  const stale = await callMove(store, { from: "projects/team-note.md", to: "projects/team-moved.md", ...OWNER, expectedEtag: "e-old" });
  assert.deepEqual(await stale.json(), { ok: false, code: "CHANGED", currentEtag: "e-team" });
  assert.equal(pathOf(store, "row-team"), "projects/team-note.md");
  assert.equal(mirror.count(), 0);

  const current = await callMove(store, { from: "projects/team-note.md", to: "projects/team-moved.md", ...OWNER, expectedEtag: "e-team" });
  assert.equal((await current.json()).ok, true);
  assert.equal(pathOf(store, "row-team"), "projects/team-moved.md");
  assert.equal(mirror.count(), 1);
});

test("a move made for a person carries its audit line to the mirror; one made for nobody carries none", async () => {
  const { store, mirror } = await ready();
  const audited = await callMove(store, { from: "projects/team-note.md", to: "projects/team-moved.md", ...OWNER, userId: "user_1" });
  assert.equal((await audited.json()).ok, true);
  const anonymous = await callMove(store, { from: "projects/team-moved.md", to: "projects/team-again.md", ...OWNER });
  assert.equal((await anonymous.json()).ok, true);
  const [first, second] = queued(mirror);
  assert.deepEqual(first.record.audit, { actorUserId: "user_1", action: "move", files: 1 });
  assert.equal("audit" in second.record, false);
});

test("a body without a scope, or without from and to, is a 422 and queues nothing", async () => {
  const bad = [
    { from: "projects/team-note.md", to: "projects/team-moved.md" },
    { from: "projects/team-note.md", scope: "public" },
    { to: "projects/team-moved.md", ...OWNER },
    { from: "projects/team-note.md", ...OWNER },
  ];
  for (const body of bad) {
    const { store, mirror, counts } = await ready();
    const response = await callMove(store, body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal((await response.json()).error, "refused", JSON.stringify(body));
    assert.equal(pathOf(store, "row-team"), "projects/team-note.md", JSON.stringify(body));
    assert.equal(mirror.count(), 0, JSON.stringify(body));
    assert.equal(counts.flushes + counts.soon, 0, JSON.stringify(body));
  }
});

test("a move says how long the object spent on it and, of that, waiting for its writes to be durable", async () => {
  const { store } = await ready();
  store.settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  const answer = await (await callMove(store, { from: "projects/plan.md", to: "projects/plan-timed.md", ...OWNER })).json();
  assert.equal(answer.ok, true);
  assert.ok(answer.commit >= 10, JSON.stringify(answer));
  assert.ok(answer.took >= answer.commit, JSON.stringify(answer));
});

test("a timed move says when the call began and when its answer left, on the object's clock, and what it found", async () => {
  const { store } = await ready();
  store.settle = () => new Promise((resolve) => setTimeout(resolve, 15));
  const arrived = Date.now() - 7;
  const answer = await (await callMove(store, { from: "projects/plan.md", to: "projects/plan-stamped.md", ...OWNER }, { arrived, cold: true, alarm: true })).json();
  assert.equal(answer.ok, true);
  assert.equal(answer.arrived, arrived);
  assert.ok(answer.answered - answer.arrived >= answer.took, JSON.stringify(answer));
  assert.ok(answer.before >= 7, JSON.stringify(answer));
  assert.equal(answer.cold, true);
  assert.equal(answer.alarm, true);

  // An alarm that began while the call was in the object says so; one already counted before it arrived does not.
  let starts = 3;
  store.settle = async () => {
    starts += 1;
  };
  const during = await (await callMove(store, { from: "projects/plan-stamped.md", to: "projects/plan-during.md", ...OWNER }, { arrived: Date.now(), alarmsBefore: 3, alarmsNow: () => starts })).json();
  assert.equal(during.alarmDuring, true, JSON.stringify(during));
  // A move whose flush alarm it set itself says so; one that found an alarm already due does not.
  assert.equal("armed" in during, false, JSON.stringify(during));
  store.mirrorSoon = async () => true;
  const armed = await (await callMove(store, { from: "projects/plan-during.md", to: "projects/plan-armed-2.md", ...OWNER }, { arrived: Date.now() })).json();
  assert.equal(armed.armed, true, JSON.stringify(armed));
  store.mirrorSoon = async () => false;
  const found = await (await callMove(store, { from: "projects/plan-armed-2.md", to: "projects/plan-during.md", ...OWNER }, { arrived: Date.now() })).json();
  assert.equal("armed" in found, false, JSON.stringify(found));
  const quiet = await (await callMove(store, { from: "projects/plan-during.md", to: "projects/plan-stamped.md", ...OWNER }, { arrived: Date.now(), alarmsBefore: 9, alarmsNow: () => 9 })).json();
  assert.equal("alarmDuring" in quiet, false, JSON.stringify(quiet));

  // Without the object's view of the call (a caller that passes none), the answer says only its own time.
  const plain = await (await callMove(store, { from: "projects/plan-stamped.md", to: "projects/plan-plain.md", ...OWNER })).json();
  assert.equal(plain.ok, true);
  assert.equal("arrived" in plain || "answered" in plain || "cold" in plain || "alarm" in plain, false, JSON.stringify(plain));
});

test("a refused move says nothing of time, and waits for nothing", async () => {
  const { store } = await ready();
  let waited = 0;
  store.settle = async () => {
    waited += 1;
  };
  const answer = await (await callMove(store, { from: "projects/missing.md", to: "projects/x.md", ...OWNER })).json();
  assert.notEqual(answer.ok, true);
  assert.equal("took" in answer, false);
  assert.equal(waited, 0);
});

/* -- `archive` in place of `to`: the object names the destination itself (one trip, no `jobs` ask before it) -------- */

const ARCHIVE_ASK = { root: null, roots: [] };

test("an archive goes under the folder doing the Archive's job, at the note's own path there", async () => {
  const { store } = await ready();
  const answer = await (await callMove(store, { from: "projects/plan.md", archive: ARCHIVE_ASK, ...OWNER })).json();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.to, "archive/projects/plan.md");
  assert.equal(pathOf(store, "row-plan"), "archive/projects/plan.md");
});

test("an archive whose name is taken takes the next numbered name, as firstFreePath does", async () => {
  const { store } = await ready();
  store.rows.put([{ id: "row-held", noteId: "0190aaaa-0000-7000-8000-0000000000aa", path: "archive/projects/plan.md", kind: "file", storageKey: "notes/held.md", etag: "e-held", at: 2 }]);
  const answer = await (await callMove(store, { from: "projects/plan.md", archive: ARCHIVE_ASK, ...OWNER })).json();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.to, "archive/projects/plan (2).md");
});

test("a note already under the Archive, or under a root the rules name, is ARCHIVED and stays", async () => {
  const { store, mirror } = await ready();
  store.rows.put([{ id: "row-gone", noteId: "0190aaaa-0000-7000-8000-0000000000ab", path: "archive/old.md", kind: "file", storageKey: "notes/old.md", etag: "e-old", at: 2 }]);
  const inJob = await (await callMove(store, { from: "archive/old.md", archive: ARCHIVE_ASK, ...OWNER })).json();
  assert.deepEqual(inJob, { ok: false, code: "ARCHIVED" });
  const inRoot = await (await callMove(store, { from: "notes/me.md", archive: { root: null, roots: ["notes"] }, ...OWNER })).json();
  assert.deepEqual(inRoot, { ok: false, code: "ARCHIVED" });
  assert.equal(pathOf(store, "row-me"), "notes/me.md");
  assert.equal(mirror.count(), 0);
});

test("with no folder doing the Archive's job, the rules' root is used, and with neither the answer is NO_ARCHIVE", async () => {
  const { store } = await ready();
  // A top-level "archive" does the job by its name alone; "none" says it does no job.
  store.rows.put([{ id: "row-archive", path: "archive", kind: "folder", role: "none", at: 2 }]);
  const none = await (await callMove(store, { from: "projects/plan.md", archive: ARCHIVE_ASK, ...OWNER })).json();
  assert.deepEqual(none, { ok: false, code: "NO_ARCHIVE" });
  const ruled = await (await callMove(store, { from: "projects/plan.md", archive: { root: "notes/old", roots: ["notes/old"] }, ...OWNER })).json();
  assert.equal(ruled.ok, true, JSON.stringify(ruled));
  assert.equal(ruled.to, "notes/old/projects/plan.md");
});

test("an archive of a note that is not there, or that the caller cannot see, is NOT_FOUND before anything about the archive", async () => {
  const { store } = await ready();
  // A top-level "archive" does the job by its name alone; "none" says it does no job.
  store.rows.put([{ id: "row-archive", path: "archive", kind: "folder", role: "none", at: 2 }]);
  const missing = await (await callMove(store, { from: "projects/none.md", archive: ARCHIVE_ASK, ...OWNER })).json();
  assert.deepEqual(missing, { ok: false, code: "NOT_FOUND" });
  const hidden = await (await callMove(store, { from: "projects/secret/memo.md", archive: ARCHIVE_ASK, ...TEAM })).json();
  assert.deepEqual(hidden, { ok: false, code: "NOT_FOUND" });
});

test("an archive names no `to`, and a move with both is refused", async () => {
  const { store } = await ready();
  const both = await callMove(store, { from: "projects/plan.md", to: "x/plan.md", archive: ARCHIVE_ASK, ...OWNER });
  assert.equal(both.status, 422);
  const bad = await callMove(store, { from: "projects/plan.md", archive: { root: 3, roots: [] }, ...OWNER });
  assert.equal(bad.status, 422);
});

test("a move sets its flush alarm before waiting for durable writes, so one flush carries both", async () => {
  const { store } = await ready();
  const order = [];
  store.mirrorSoon = () => new Promise((resolve) => setTimeout(() => {
    order.push("alarm set");
    resolve();
  }, 5));
  store.settle = async () => {
    order.push("settle");
  };
  const answer = await (await callMove(store, { from: "projects/plan.md", to: "projects/plan-armed.md", ...OWNER })).json();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(order, ["alarm set", "settle"]);
});
