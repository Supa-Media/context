// The tree's write ops `ws.write.trash` and `ws.write.restore` (`src/workspaceStore/treeWrites.js`), over a real
// object store (rows, rules, mirror outbox) through `serveWorkspaceStore`. A caller judged by the object's rules
// moves only what it may see; a refusal queues nothing; a trash waits for the mirror, a restore does not.
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { durableSqlite } from "./durableSqlite.mjs";

const WS = "ws_one";

const RULES = {
  etag: "rules-1",
  accessVersion: 1,
  // `projects` is team; the two notes named below are private inside it.
  folders: [{ prefix: "projects", visibility: "team" }],
  notes: [
    { path: "projects/plan-private.md", visibility: "private" },
    { path: "projects/box/private.md", visibility: "private" },
  ],
};

const ROWS = [
  { id: "d-projects", path: "projects", kind: "folder", role: "projects", at: 1 },
  { id: "d-launch", path: "projects/launch", kind: "folder", at: 2 },
  { id: "d-box", path: "projects/box", kind: "folder", at: 3 },
  { id: "f-brief", path: "projects/launch/brief.md", kind: "file", at: 4, storageKey: "notes/f-brief.md", etag: "e-brief" },
  { id: "f-plan", path: "projects/plan.md", kind: "file", at: 5, storageKey: "notes/f-plan.md", etag: "e-plan" },
  { id: "f-private", path: "projects/plan-private.md", kind: "file", at: 6, storageKey: "notes/f-private.md", etag: "e-private" },
  { id: "f-box-private", path: "projects/box/private.md", kind: "file", at: 7, storageKey: "notes/f-box-private.md", etag: "e-box" },
];

/** One object as `ready()` builds it, with a flush that answers `flushDone` and counters for flushes and soon-flushes. */
function objectStore({ flushDone = true } = {}) {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  rows.pinWorkspace(WS);
  rows.put(ROWS);
  rows.putRules(RULES);
  const mirror = mirrorOutbox(sql);
  const counts = { flushes: 0, soon: 0 };
  const store = {
    sql,
    rows,
    objects: texObjects(sql),
    members: workspaceMembers(sql),
    mirror,
    transact,
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

function call(store, op, fields) {
  const request = new Request(`https://object.test/${op}`, {
    method: "POST",
    headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
    body: JSON.stringify({ workspaceId: WS, ...fields }),
  });
  return serveWorkspaceStore(store, request);
}

const OWNER = { scope: "private" };
const TEAM = { scope: "team" };
const pathOf = (store, id) => store.rows.get([id])[0].path;

test("an owner trashes a note: it moves under the trash, one tree change is queued, and the flush is awaited", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects/launch/brief.md", ...OWNER });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.match(answer.to, /^\.context\/trash\/[^/]+\/projects\/launch\/brief\.md$/);
  assert.equal(answer.count, 1);
  assert.equal(pathOf(store, "f-brief"), answer.to);
  assert.equal(mirror.count(), 1);
  const [queued] = mirror.pending();
  assert.equal(queued.change.op, "tree");
  assert.equal(queued.change.record.trash, true);
  assert.equal(queued.change.record.moves.length, 1);
  assert.equal(queued.change.record.moves[0].id, "f-brief");
  assert.equal(queued.change.record.moves[0].from, "projects/launch/brief.md");
  assert.equal(queued.change.record.moves[0].to, answer.to);
  assert.equal(queued.change.record.moves[0].at, answer.at);
  // The folders the trash stood up carry the object's own ids, and the emptied folder it removed is named.
  assert.ok(queued.change.record.folders.length > 0);
  for (const folder of queued.change.record.folders) assert.match(folder.id, /^o_[0-9a-f]{32}$/);
  assert.deepEqual(queued.change.record.removed.map((entry) => entry.id), ["d-launch"]);
  assert.equal(queued.change.objectAt >= answer.at, true);
  assert.equal(counts.flushes, 1, "a trash waits for the mirror");
  assert.equal(counts.soon, 0);
});

test("a team member trashing a private note is NOT_FOUND, and nothing is queued", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects/plan-private.md", ...TEAM });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "f-private"), "projects/plan-private.md");
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("a path with no live row is NOT_FOUND for the owner too, and queues nothing", async () => {
  const { store, mirror } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects/missing.md", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(mirror.count(), 0);
});

test("a team member trashing a folder that holds a note it may not see is HIDDEN, and nothing moves", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects/box", ...TEAM });
  assert.deepEqual(await response.json(), { ok: false, code: "HIDDEN" });
  assert.equal(pathOf(store, "d-box"), "projects/box");
  assert.equal(pathOf(store, "f-box-private"), "projects/box/private.md");
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
});

test("a main folder is INVALID to trash, and nothing moves", async () => {
  const { store, mirror } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "INVALID" });
  assert.equal(pathOf(store, "d-projects"), "projects");
  assert.equal(mirror.count(), 0);
});

test("a stale expectedEtag is CHANGED with the current etag, and nothing is queued", async () => {
  const { store, mirror } = objectStore();
  const response = await call(store, "ws.write.trash", { path: "projects/plan.md", ...OWNER, expectedEtag: "e-old" });
  assert.deepEqual(await response.json(), { ok: false, code: "CHANGED", currentEtag: "e-plan" });
  assert.equal(pathOf(store, "f-plan"), "projects/plan.md");
  assert.equal(mirror.count(), 0);
});

test("a failed mirror flush answers 503 MIRROR_PENDING, and the trash change stays queued", async () => {
  const { store, mirror } = objectStore({ flushDone: false });
  const response = await call(store, "ws.write.trash", { path: "projects/plan.md", ...OWNER });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "MIRROR_PENDING" });
  assert.equal(mirror.count(), 1);
});

test("restore brings a trashed note back to its name: no flush awaited, one more tree change queued", async () => {
  const { store, mirror, counts } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/launch/brief.md", ...OWNER })).json();
  const flushesAfterTrash = counts.flushes;
  const response = await call(store, "ws.write.restore", { from: trashed.to, to: "projects/launch/brief.md", ...OWNER });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.count, 1);
  assert.equal(pathOf(store, "f-brief"), "projects/launch/brief.md");
  assert.equal(pathOf(store, "d-launch"), "projects/launch", "the folder the restore stood up takes its old id back");
  assert.equal(mirror.count(), 2);
  assert.equal(mirror.pending()[1].change.op, "tree");
  assert.equal(counts.flushes, flushesAfterTrash, "a restore does not wait for the mirror");
  assert.equal(counts.soon, 1);
});

test("a team member restores a note it can see at its old name: the restore is judged at the name it returns to", async () => {
  const { store, mirror } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/plan.md", ...OWNER })).json();
  const response = await call(store, "ws.write.restore", { from: trashed.to, to: "projects/plan.md", ...TEAM });
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(pathOf(store, "f-plan"), "projects/plan.md");
  assert.equal(mirror.count(), 2);
});

test("a team member trashes a note it can see, and the trash is queued", async () => {
  const { store, mirror } = objectStore();
  const answer = await (await call(store, "ws.write.trash", { path: "projects/plan.md", ...TEAM })).json();
  assert.equal(answer.ok, true);
  assert.equal(mirror.count(), 1);
});

test("a restore onto a name a live row holds is TAKEN, and the note stays in the trash", async () => {
  const { store, mirror } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/plan.md", ...OWNER })).json();
  // Another note took the name while this one sat in the trash.
  store.rows.put([{ id: "f-new", noteId: "n-new", path: "projects/plan.md", kind: "file", storageKey: "notes/n-new.md", etag: "e-new", at: Date.now() + 60_000 }]);
  const response = await call(store, "ws.write.restore", { from: trashed.to, to: "projects/plan.md", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "TAKEN" });
  assert.equal(pathOf(store, "f-plan"), trashed.to);
  assert.equal(mirror.count(), 1, "only the trash is queued");
});

test("a team member cannot restore a note to a name it may not see: NOT_FOUND, and nothing moves", async () => {
  const { store, mirror } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/plan-private.md", ...OWNER })).json();
  const response = await call(store, "ws.write.restore", { from: trashed.to, to: "projects/plan-private.md", ...TEAM });
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "f-private"), trashed.to);
  assert.equal(mirror.count(), 1, "only the trash is queued");
});

test("a restore only returns a note to the name it was trashed from: elsewhere is NOT_FOUND, and nothing moves", async () => {
  const { store, mirror } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/plan-private.md", ...OWNER })).json();
  // A team member who may see projects/ must not bring the owner's private note out under a name of its choosing.
  const response = await call(store, "ws.write.restore", { from: trashed.to, to: "projects/now-mine.md", ...TEAM });
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "f-private"), trashed.to);
  assert.equal(mirror.count(), 1, "only the trash is queued");
});

test("a restore from a path outside the trash is NOT_FOUND, and nothing moves", async () => {
  const { store, mirror } = objectStore();
  const response = await call(store, "ws.write.restore", { from: "projects/plan.md", to: "projects/elsewhere.md", ...OWNER });
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(pathOf(store, "f-plan"), "projects/plan.md");
  assert.equal(mirror.count(), 0);
});

test("a body that is not a write is 422 for both ops, and queues nothing", async () => {
  const bad = [
    ["ws.write.trash", { path: "", ...OWNER }],
    ["ws.write.trash", { path: "projects/plan.md", scope: "public" }],
    ["ws.write.trash", { path: "projects/plan.md" }],
    ["ws.write.trash", { path: "projects/plan.md", ...OWNER, expectedEtag: 7 }],
    ["ws.write.trash", { path: "projects/plan.md", ...OWNER, plannedFiles: "a.md" }],
    ["ws.write.trash", { path: "projects/plan.md", ...OWNER, sealsChatHomes: "yes" }],
    ["ws.write.trash", { path: "projects/plan.md", ...OWNER, groups: "design" }],
    ["ws.write.trash", { path: "projects/plan.md", ...OWNER, userId: 3 }],
    ["ws.write.restore", { from: ".context/trash/x/projects/plan.md", scope: "private" }],
    ["ws.write.restore", { to: "projects/plan.md", scope: "private" }],
    ["ws.write.restore", { from: ".context/trash/x/a.md", to: "a.md", scope: "bogus" }],
  ];
  for (const [op, body] of bad) {
    const { store, mirror, counts } = objectStore();
    const response = await call(store, op, body);
    assert.equal(response.status, 422, `${op} ${JSON.stringify(body)}`);
    assert.equal((await response.json()).error, "refused");
    assert.equal(mirror.count(), 0, `${op} ${JSON.stringify(body)}`);
    assert.equal(counts.flushes + counts.soon, 0);
  }
});

test("a trash and restore made for a person carry their audit line to the mirror; one for nobody carries none", async () => {
  const { store, mirror } = objectStore();
  const trashed = await (await call(store, "ws.write.trash", { path: "projects/launch/brief.md", ...OWNER, userId: "user_1" })).json();
  await call(store, "ws.write.restore", { from: trashed.to, to: "projects/launch/brief.md", ...OWNER, userId: "user_1" });
  await call(store, "ws.write.trash", { path: "projects/plan.md", ...OWNER });
  const [trash, restore, anonymous] = mirror.pending().map((entry) => entry.change.record.audit);
  assert.deepEqual(trash, { actorUserId: "user_1", action: "trash", files: 1 });
  assert.deepEqual(restore, { actorUserId: "user_1", action: "restore", files: 1 });
  assert.equal(anonymous, undefined);
});
