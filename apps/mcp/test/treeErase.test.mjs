// The tree's erase op `ws.write.erase` (`src/workspaceStore/treeWrites.js`, `ERASE_PAGE`) and the paged `limit` of
// `treeOps.remove` (`src/workspaceStore/treeOps.js`), over the same object store as treeWrites.test.mjs. An erase
// names only a stamp folder in the trash or a name in the old copies; anything else is a 422 and queues nothing; a big
// stamp folder goes a page at a time, no page is over the mirror's 500; a page waits for the mirror. Sabotage: make
// ERASABLE in treeWrites.js accept any path, and case 2 fails (the 422 becomes a 200 INVALID refusal).
import { test } from "node:test";
import assert from "node:assert/strict";

import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { workspaceMembers } from "../src/workspaceStore/members.js";
import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { ERASE_PAGE } from "../src/workspaceStore/treeWrites.js";
import { treeOps } from "../src/workspaceStore/treeOps.js";
import { durableSqlite } from "./durableSqlite.mjs";

const WS = "ws_one";
const STAMP = "2026-09-01T05-00-00-000Z";
const STAMP_BIG = "2026-08-01T00-00-00-000Z";
const NOW = Date.parse("2026-11-03T00:00:00.000Z");

const RULES = {
  etag: "rules-1",
  accessVersion: 1,
  folders: [{ prefix: "projects", visibility: "team" }],
  notes: [],
};

const ROWS = [
  { id: "d-projects", path: "projects", kind: "folder", role: "projects", at: 1 },
  { id: "f-plan", path: "projects/plan.md", kind: "file", at: 5, storageKey: "notes/f-plan.md", etag: "e-plan" },
  { id: "d-context", path: ".context", kind: "folder", at: 10 },
  { id: "d-trash", path: ".context/trash", kind: "folder", at: 11 },
  { id: "d-stamp", path: `.context/trash/${STAMP}`, kind: "folder", at: 12 },
  { id: "d-stamp-projects", path: `.context/trash/${STAMP}/projects`, kind: "folder", at: 13 },
  { id: "f-old", noteId: "n-old", path: `.context/trash/${STAMP}/projects/old.md`, kind: "file", at: 14, storageKey: "notes/f-old.md", etag: "e-old" },
  { id: "d-copies", path: ".context/old-copies", kind: "folder", at: 15 },
  { id: "f-copy", noteId: "n-copy", path: ".context/old-copies/plan-2025.md", kind: "file", at: 16, storageKey: "notes/f-copy.md", etag: "e-copy" },
];

/** One object as `ready()` builds it, with a flush that answers `flushDone` and counters for flushes and soon-flushes. */
function objectStore({ flushDone = true, extra = [] } = {}) {
  const { sql, transact } = durableSqlite();
  const rows = workspaceRows(sql);
  rows.pinWorkspace(WS);
  rows.put(ROWS);
  for (let at = 0; at < extra.length; at += 100) rows.put(extra.slice(at, at + 100));
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

const pathOf = (store, id) => store.rows.get([id])[0].path;
/** Whether the row is gone (removed): read straight from the object's SQL, since `rows.get` answers live rows only. */
const isGone = (store, id) => Number(store.sql.exec("SELECT gone FROM ws_rows WHERE id = ?", id).toArray()[0].gone) === 1;
/** Live rows strictly under `path`. */
const liveUnder = (store, path) =>
  store.sql.exec("SELECT id, path FROM ws_rows WHERE gone = 0 AND substr(path, 1, length(?) + 1) = ? || '/'", path, path).toArray();

/** Rows for a stamp folder with `perFolder` files in each of two subfolders, named so each sorts by its own path. */
function bigStampRows(perFolder) {
  const rows = [
    { id: "d-big-stamp", path: `.context/trash/${STAMP_BIG}`, kind: "folder", at: 20 },
    { id: "d-big-a", path: `.context/trash/${STAMP_BIG}/a`, kind: "folder", at: 21 },
    { id: "d-big-b", path: `.context/trash/${STAMP_BIG}/b`, kind: "folder", at: 22 },
  ];
  for (let i = 0; i < perFolder; i += 1) {
    for (const folder of ["a", "b"]) {
      rows.push({
        id: `f-big-${folder}-${i}`,
        noteId: `n-big-${folder}-${i}`,
        path: `.context/trash/${STAMP_BIG}/${folder}/file-${i}.md`,
        kind: "file",
        at: 100 + i,
        storageKey: `notes/f-big-${folder}-${i}.md`,
        etag: `e-big-${folder}-${i}`,
      });
    }
  }
  return rows;
}

test("erasing a due stamp folder removes it and everything under it, answers its files, and waits for the mirror", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.erase", { path: `.context/trash/${STAMP}` });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.more, false);
  assert.equal(answer.count, 4, "the stamp, its projects folder, the note, and the trash folder it empties");
  assert.deepEqual(answer.files, [{ noteId: "n-old", storageKey: "notes/f-old.md" }]);

  for (const id of ["d-stamp", "d-stamp-projects", "f-old"]) assert.equal(isGone(store, id), true, id);
  assert.equal(isGone(store, "d-trash"), true, "the trash folder it emptied goes with it");
  assert.equal(isGone(store, "d-context"), false, ".context still holds old copies");
  assert.equal(isGone(store, "f-copy"), false);
  assert.equal(pathOf(store, "f-plan"), "projects/plan.md");

  assert.equal(mirror.count(), 1, "exactly one tree change is queued");
  const [queued] = mirror.pending();
  assert.equal(queued.change.op, "tree");
  assert.equal(queued.change.record.erase, true);
  assert.deepEqual(queued.change.record.moves, []);
  const removedIds = queued.change.record.removed.map((entry) => entry.id);
  for (const id of ["d-stamp", "d-stamp-projects", "f-old", "d-trash"]) assert.ok(removedIds.includes(id), id);
  assert.ok(!removedIds.includes("f-copy"));
  assert.ok(!removedIds.includes("d-context"));
  assert.equal(counts.flushes, 1, "an erase waits for the mirror");
  assert.equal(counts.soon, 0);
});

test("a path outside the trash stamp folders or the old copies is 422, and queues nothing", async () => {
  const refused = [
    "projects/plan.md",
    ".context/trash",
    `.context/trash/${STAMP}/../../projects`,
    ".context/other/x",
    // A name inside a stamp folder is not an erase: the trash empties a whole stamp folder at a time.
    `.context/trash/2026-09-01T05-00-00-000Z/projects/old.md`,
    ".context/old-copies/",
    `.context/trash/${STAMP}/projects/../../../projects/plan.md`,
    "",
  ];
  for (const path of refused) {
    const { store, mirror, counts } = objectStore();
    const response = await call(store, "ws.write.erase", { path });
    assert.equal(response.status, 422, JSON.stringify(path));
    assert.equal((await response.json()).error, "refused");
    assert.equal(mirror.count(), 0, JSON.stringify(path));
    assert.equal(counts.flushes + counts.soon, 0, JSON.stringify(path));
    assert.equal(pathOf(store, "f-plan"), "projects/plan.md");
    assert.equal(isGone(store, "f-old"), false);
  }
});

test("erasing a name in the old copies works: the file goes, its note id and key are answered", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.erase", { path: ".context/old-copies/plan-2025.md" });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.more, false);
  assert.deepEqual(answer.files, [{ noteId: "n-copy", storageKey: "notes/f-copy.md" }]);
  assert.equal(isGone(store, "f-copy"), true);
  assert.equal(isGone(store, "d-copies"), true, "the old-copies folder it emptied goes too");
  assert.equal(isGone(store, "f-old"), false, "the trash is untouched");
  assert.equal(mirror.count(), 1);
  assert.equal(mirror.pending()[0].change.record.erase, true);
  assert.equal(counts.flushes, 1);
});

test("a missing stamp folder answers NOT_FOUND and queues nothing", async () => {
  const { store, mirror, counts } = objectStore();
  const response = await call(store, "ws.write.erase", { path: ".context/trash/2000-01-01T00-00-00-000Z" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(mirror.count(), 0);
  assert.equal(counts.flushes + counts.soon, 0);
  assert.equal(isGone(store, "f-old"), false);
});

test("a stamp folder bigger than a page goes a page at a time: each page is answered, and the stamp stays until the last", async () => {
  const perFolder = (ERASE_PAGE + 50) / 2;
  assert.equal(perFolder * 2, ERASE_PAGE + 50);
  const { store, mirror, counts } = objectStore({ extra: bigStampRows(perFolder) });
  const stamp = `.context/trash/${STAMP_BIG}`;

  const first = await (await call(store, "ws.write.erase", { path: stamp })).json();
  assert.equal(first.ok, true);
  assert.equal(first.more, true);
  assert.equal(first.count, ERASE_PAGE);
  assert.equal(first.files.length, ERASE_PAGE);
  assert.equal(isGone(store, "d-big-stamp"), false, "the stamp folder itself is still live");
  assert.equal(pathOf(store, "d-big-stamp"), stamp);
  // No live row is left under a folder the page removed.
  const goneFolders = store.sql.exec("SELECT path FROM ws_rows WHERE gone = 1 AND kind = 'folder' AND substr(path, 1, length(?) + 1) = ? || '/'", stamp, stamp).toArray();
  for (const { path } of goneFolders) assert.deepEqual(liveUnder(store, path), [], path);
  assert.equal(mirror.count(), 1);
  assert.equal(counts.flushes, 1);

  const second = await (await call(store, "ws.write.erase", { path: stamp })).json();
  assert.equal(second.ok, true);
  assert.equal(second.more, false);
  assert.equal(second.files.length, ERASE_PAGE + 50 - ERASE_PAGE);
  assert.equal(isGone(store, "d-big-stamp"), true, "the last page removes the stamp folder");
  assert.equal(isGone(store, "d-big-a"), true);
  assert.equal(isGone(store, "d-big-b"), true);
  assert.deepEqual(liveUnder(store, stamp), []);
  assert.equal(pathOf(store, "f-plan"), "projects/plan.md");

  const erased = [...first.files, ...second.files].map((file) => file.storageKey).sort();
  assert.equal(new Set(erased).size, ERASE_PAGE + 50, "every file is answered exactly once");

  assert.equal(mirror.count(), 2);
  for (const queued of mirror.pending()) {
    assert.equal(queued.change.op, "tree");
    assert.equal(queued.change.record.erase, true);
    assert.ok(queued.change.record.removed.length <= 500, `a change names ${queued.change.record.removed.length} rows`);
  }
  assert.equal(counts.flushes, 2);
});

test("a failed mirror flush answers 503 MIRROR_PENDING with the files, and the erase stays queued", async () => {
  const { store, mirror } = objectStore({ flushDone: false });
  const response = await call(store, "ws.write.erase", { path: `.context/trash/${STAMP}` });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "MIRROR_PENDING");
  assert.equal(body.answer.ok, true);
  assert.deepEqual(body.answer.files, [{ noteId: "n-old", storageKey: "notes/f-old.md" }]);
  assert.equal(mirror.count(), 1, "the change landed and stays queued");
});

test("treeOps.remove refuses a limit that is not a positive whole number, and removes nothing", () => {
  for (const limit of [0, 1.5, -1, "3", NaN]) {
    const { sql } = durableSqlite();
    const rows = workspaceRows(sql);
    rows.pinWorkspace(WS);
    rows.put(ROWS);
    const before = sql.exec("SELECT COUNT(*) AS n FROM ws_rows WHERE gone = 1").toArray()[0].n;
    const answer = treeOps(sql).remove({ path: `.context/trash/${STAMP}`, now: NOW, limit });
    assert.deepEqual({ ok: answer.ok, reason: answer.reason }, { ok: false, reason: "invalid" }, `limit ${String(limit)}`);
    assert.equal(sql.exec("SELECT COUNT(*) AS n FROM ws_rows WHERE gone = 1").toArray()[0].n, before);
  }
});

test("treeOps.remove with a limit at or above the subtree removes it whole, as no limit does", () => {
  const { sql } = durableSqlite();
  const rows = workspaceRows(sql);
  rows.pinWorkspace(WS);
  rows.put(ROWS);
  const answer = treeOps(sql).remove({ path: `.context/trash/${STAMP}`, now: NOW, limit: 10 });
  assert.equal(answer.ok, true);
  assert.equal(answer.more, false);
  assert.equal(answer.files.length, 1);
});
