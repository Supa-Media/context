// The tree's trash, restore, remove and createFolder over a workspace object's rows (src/workspaceStore/treeOps.js),
// run on the same node:sqlite stand-in for the object as workspaceStore.test.mjs. Mirrors the intent of
// apps/convex/__tests__/nodes/keyedTrash.test.ts and keyedDelete.test.ts: ids survive a trash, the trash keeps a
// note's place by name, the main folders never go to the trash, and a removal leaves a clock behind it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceRows } from "../src/workspaceStore/rows.js";
import { treeOps, trashStamp } from "../src/workspaceStore/treeOps.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

const NOW = Date.UTC(2026, 10, 3, 1, 2, 3, 456);
const STAMP = trashStamp(NOW);
const TRASH = `.context/trash/${STAMP}`;

/** A fresh object, its rows, and the ops over it; `minted()` counts the ids the object made. */
function world() {
  const sql = durableSql();
  const rows = workspaceRows(sql);
  let n = 0;
  const ops = treeOps(sql, { mintId: () => `o_new${++n}` });
  return { rows, ops, minted: () => n };
}
const folder = (id, path, extra = {}) => ({ id, path, kind: "folder", at: 100, ...extra });
const note = (id, path, extra = {}) => ({
  id,
  noteId: `n-${id}`,
  path,
  kind: "file",
  storageKey: `notes/${id}.md`,
  etag: `e-${id}`,
  at: 100,
  ...extra,
});

test("trash moves a note under the stamp, keeps its id, and retires only a plain emptied parent", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), folder("d2", "projects/launch"), note("f1", "projects/launch/brief.md")]);
  const answer = ops.trash({ path: "projects/launch/brief.md", now: NOW });
  assert.equal(answer.ok, true);
  assert.equal(answer.to, `${TRASH}/projects/launch/brief.md`);
  assert.equal(rows.get(["f1"])[0].path, answer.to);
  assert.equal(rows.byPath("projects/launch/brief.md"), null);
  assert.deepEqual(answer.removed.map((entry) => entry.id), ["d2"]);
  assert.equal(rows.byPath("projects/launch"), null);
  assert.notEqual(rows.byPath("projects"), null);
});

test("trash of the only note in a top-level job folder leaves that folder standing", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md")]);
  const answer = ops.trash({ path: "projects/keep.md", now: NOW });
  assert.equal(answer.to, `${TRASH}/projects/keep.md`);
  assert.deepEqual(answer.removed, []);
  assert.equal(rows.byPath("projects").id, "d1");
});

test("trash of a folder moves it and every child under the trash path, each keeping its id", { skip }, () => {
  const { rows, ops } = world();
  rows.put([
    folder("d1", "projects"),
    folder("d2", "projects/launch"),
    note("f1", "projects/launch/brief.md"),
    folder("d3", "projects/launch/notes"),
    note("f2", "projects/launch/notes/x.md"),
  ]);
  const answer = ops.trash({ path: "projects/launch", now: NOW });
  assert.equal(answer.ok, true);
  assert.equal(answer.to, `${TRASH}/projects/launch`);
  assert.equal(answer.count, 4);
  const paths = Object.fromEntries(rows.get(["d2", "f1", "d3", "f2"]).map((row) => [row.id, row.path]));
  assert.deepEqual(paths, {
    d2: `${TRASH}/projects/launch`,
    f1: `${TRASH}/projects/launch/brief.md`,
    d3: `${TRASH}/projects/launch/notes`,
    f2: `${TRASH}/projects/launch/notes/x.md`,
  });
  assert.equal(rows.byPath("projects/launch"), null);
  assert.deepEqual(answer.removed, []);
});

test("a second trash of the same name in the same millisecond lands at <stamp>-2, then -3", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md")]);
  assert.equal(ops.trash({ path: "projects/keep.md", now: NOW }).to, `${TRASH}/projects/keep.md`);
  rows.put([note("f2", "projects/keep.md")]);
  assert.equal(ops.trash({ path: "projects/keep.md", now: NOW }).to, `${TRASH}-2/projects/keep.md`);
  rows.put([note("f3", "projects/keep.md")]);
  assert.equal(ops.trash({ path: "projects/keep.md", now: NOW }).to, `${TRASH}-3/projects/keep.md`);
  assert.equal(rows.get(["f1"])[0].path, `${TRASH}/projects/keep.md`);
  assert.equal(rows.get(["f2"])[0].path, `${TRASH}-2/projects/keep.md`);
  assert.equal(rows.get(["f3"])[0].path, `${TRASH}-3/projects/keep.md`);
});

test("trash with a stale expectedEtag is changed and writes nothing; the matching etag trashes", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md", { etag: "e1" })]);
  const stale = ops.trash({ path: "projects/keep.md", now: NOW, expectedEtag: "e0" });
  assert.deepEqual(stale, { ok: false, reason: "changed", currentEtag: "e1" });
  assert.equal(rows.get(["f1"])[0].path, "projects/keep.md");
  assert.equal(rows.get(["f1"])[0].at, 100);
  const fresh = ops.trash({ path: "projects/keep.md", now: NOW, expectedEtag: "e1" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.to, `${TRASH}/projects/keep.md`);
});

test("the five main folders are never trashed, and a refused trash writes nothing", { skip }, () => {
  const { rows, ops } = world();
  rows.put([
    folder("i", "inbox"),
    folder("p", "projects"),
    folder("a", "areas"),
    folder("r", "resources"),
    folder("ar", "archive"),
  ]);
  const before = rows.list().rows;
  for (const path of ["inbox", "projects", "areas", "resources", "archive"]) {
    assert.deepEqual(ops.trash({ path, now: NOW }), { ok: false, reason: "invalid" }, path);
  }
  assert.deepEqual(rows.list().rows, before);
});

test("a folder that plays the inbox job under another name is a main folder too", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("c", "capture", { role: "inbox" }), note("cf", "capture/x.md")]);
  const before = rows.list().rows;
  assert.deepEqual(ops.trash({ path: "capture", now: NOW }), { ok: false, reason: "invalid" });
  assert.deepEqual(rows.list().rows, before);
});

test("a website folder and a plain folder can be trashed", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("site", "mysite", { role: "website" }), folder("s", "scratch"), note("sf", "scratch/a.md")]);
  assert.equal(ops.trash({ path: "mysite", now: NOW }).to, `${TRASH}/mysite`);
  const plain = ops.trash({ path: "scratch", now: NOW });
  assert.equal(plain.ok, true);
  assert.equal(rows.get(["sf"])[0].path, `${TRASH}/scratch/a.md`);
});

test("a path under .context is never trashed", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("cx", ".context"), note("cn", ".context/notes/x.md")]);
  const before = rows.list().rows;
  assert.deepEqual(ops.trash({ path: ".context/notes/x.md", now: NOW }), { ok: false, reason: "invalid" });
  assert.deepEqual(ops.trash({ path: ".context", now: NOW }), { ok: false, reason: "invalid" });
  assert.deepEqual(rows.list().rows, before);
});

test("a note the judge hides is not_found; a folder with a hidden file under it is hidden", { skip }, () => {
  const { rows, ops } = world();
  rows.put([
    folder("d1", "projects"),
    note("f1", "projects/keep.md"),
    folder("d2", "projects/launch"),
    note("f2", "projects/launch/secret.md"),
  ]);
  const before = rows.list().rows;
  const notFound = ops.trash({ path: "projects/keep.md", now: NOW, judge: (path) => path !== "projects/keep.md" });
  assert.deepEqual(notFound, { ok: false, reason: "not_found" });
  const hidden = ops.trash({ path: "projects/launch", now: NOW, judge: (path) => path !== "projects/launch/secret.md" });
  assert.deepEqual(hidden, { ok: false, reason: "hidden" });
  assert.deepEqual(rows.list().rows, before);
});

test("restore puts a note back at its original path under the same id", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md")]);
  const { to } = ops.trash({ path: "projects/keep.md", now: NOW });
  const answer = ops.restore({ from: to, to: "projects/keep.md", now: NOW + 1000 });
  assert.equal(answer.ok, true);
  assert.equal(rows.byPath("projects/keep.md").id, "f1");
  assert.equal(rows.byPath(to), null);
});

test("restore of one note out of a trashed folder recreates its chain under a new id, the rest stays trashed", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([
    folder("d1", "projects"),
    folder("d2", "projects/launch"),
    note("f1", "projects/launch/brief.md"),
    note("f2", "projects/launch/other.md"),
  ]);
  const { to: trashed } = ops.trash({ path: "projects/launch", now: NOW });
  const base = minted(); // the trash stood up its own scaffolding first
  const answer = ops.restore({ from: `${trashed}/brief.md`, to: "projects/launch/brief.md", now: NOW + 1000 });
  assert.equal(answer.ok, true);
  assert.equal(rows.byPath("projects/launch").id, `o_new${base + 1}`);
  assert.equal(minted(), base + 1);
  assert.equal(rows.get(["f1"])[0].path, "projects/launch/brief.md");
  assert.equal(rows.byPath(`${trashed}/other.md`).id, "f2");
  assert.equal(rows.get(["d2"])[0].path, trashed);
});

test("restore of one note whose folder was retired revives that folder under its own id", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([folder("d1", "projects"), folder("d2", "projects/launch"), note("f1", "projects/launch/brief.md")]);
  const { to: inTrash } = ops.trash({ path: "projects/launch/brief.md", now: NOW });
  assert.equal(rows.byPath("projects/launch"), null);
  const base = minted();
  const answer = ops.restore({ from: inTrash, to: "projects/launch/brief.md", now: NOW + 1000 });
  assert.equal(answer.ok, true);
  assert.equal(rows.byPath("projects/launch").id, "d2");
  assert.equal(minted(), base);
  assert.deepEqual(answer.rows.map((row) => row.id).sort(), ["d2", "f1"]);
});

test("restore of a whole trashed folder brings it back under its own id with its children", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([folder("d1", "projects"), folder("d2", "projects/launch"), note("f1", "projects/launch/brief.md")]);
  const { to: trashed } = ops.trash({ path: "projects/launch", now: NOW });
  const base = minted();
  const answer = ops.restore({ from: trashed, to: "projects/launch", now: NOW + 1000 });
  assert.equal(answer.ok, true);
  assert.equal(rows.byPath("projects/launch").id, "d2");
  assert.equal(rows.get(["f1"])[0].path, "projects/launch/brief.md");
  assert.equal(minted(), base);
});

test("restore onto a name a live row holds is taken; a restore from outside the trash is invalid", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md")]);
  const { to } = ops.trash({ path: "projects/keep.md", now: NOW });
  rows.put([note("f2", "projects/keep.md")]);
  const before = rows.list().rows;
  assert.deepEqual(ops.restore({ from: to, to: "projects/keep.md", now: NOW + 1000 }), { ok: false, reason: "taken" });
  assert.equal(rows.get(["f1"])[0].path, to);
  assert.equal(rows.get(["f1"])[0].at, NOW);
  assert.deepEqual(rows.list().rows, before);
  assert.deepEqual(ops.restore({ from: "projects/keep.md", to: "elsewhere.md", now: NOW }), { ok: false, reason: "invalid" });
});

test("remove tombstones a trashed folder and everything under it, each with the later clock", { skip }, () => {
  const { rows, ops } = world();
  rows.put([
    folder("d1", "projects"),
    folder("d2", "projects/launch"),
    note("f1", "projects/launch/brief.md"),
    folder("d3", "projects/launch/notes"),
    note("f2", "projects/launch/notes/x.md"),
  ]);
  const { to: trashed } = ops.trash({ path: "projects/launch", now: NOW });
  const later = NOW + 5000;
  const answer = ops.remove({ path: trashed, now: later });
  assert.equal(answer.ok, true);
  assert.equal(answer.kind, "folder");
  // The four subtree rows, and the trash's own folders (o_new1..4) once the removal leaves them empty.
  assert.deepEqual(answer.removed.map((entry) => entry.id).sort(), ["d2", "d3", "f1", "f2", "o_new1", "o_new2", "o_new3", "o_new4"]);
  for (const entry of answer.removed) assert.equal(entry.at, later);
  assert.deepEqual(rows.get(["d2", "d3", "f1", "f2"]), []);
  assert.equal(rows.byPath(".context"), null);
  assert.equal(rows.byPath(trashed), null);
});

test("remove at a clock behind the row's own takes one past it, and a late older push is ignored", { skip }, () => {
  const { rows, ops } = world();
  rows.put([folder("d1", "projects"), note("f1", "projects/keep.md")]);
  const { to } = ops.trash({ path: "projects/keep.md", now: NOW });
  const answer = ops.remove({ path: to, now: NOW });
  assert.equal(answer.removed[0].id, "f1");
  assert.equal(answer.removed[0].at, NOW + 1);
  assert.deepEqual(rows.put([note("f1", "projects/keep.md", { at: NOW })]), { kept: 0 });
  assert.deepEqual(rows.get(["f1"]), []);
  assert.equal(rows.byPath("projects/keep.md"), null);
});

test("remove outside the trash is invalid, a missing trashed name is not_found, old copies can be removed", { skip }, () => {
  const { rows, ops } = world();
  rows.put([note("k", "projects/keep.md"), note("oc", ".context/old-copies/x.md")]);
  assert.deepEqual(ops.remove({ path: "projects/keep.md", now: NOW }), { ok: false, reason: "invalid" });
  assert.equal(rows.byPath("projects/keep.md").id, "k");
  assert.deepEqual(ops.remove({ path: `${TRASH}/nothing.md`, now: NOW }), { ok: false, reason: "not_found" });
  const answer = ops.remove({ path: ".context/old-copies/x.md", now: NOW });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.removed.map((entry) => entry.id), ["oc"]);
  assert.deepEqual(rows.get(["oc"]), []);
});

test("createFolder makes the folder and each missing parent under a fresh id, in order", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([folder("d1", "projects")]);
  const answer = ops.createFolder({ path: "projects/launch/deep", now: NOW });
  assert.equal(answer.ok, true);
  assert.equal(answer.created, true);
  assert.deepEqual(answer.rows.map((row) => row.id), ["o_new1", "o_new2"]);
  assert.equal(rows.byPath("projects/launch").id, "o_new1");
  assert.equal(rows.byPath("projects/launch/deep").id, "o_new2");
  assert.equal(rows.byPath("projects/launch/deep").kind, "folder");
  assert.equal(rows.byPath("projects/launch/deep").at, NOW);
  assert.equal(minted(), 2);
  assert.deepEqual(answer.removed, []);
});

test("createFolder on a folder already there answers created false and writes nothing", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([folder("d1", "projects")]);
  const before = rows.list().rows;
  assert.deepEqual(ops.createFolder({ path: "projects", now: NOW }), { ok: true, created: false, rows: [], removed: [], folders: [] });
  assert.deepEqual(rows.list().rows, before);
  assert.equal(minted(), 0);
});

test("createFolder is taken at a file's name, and at a file anywhere in its chain", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([note("f1", "projects/keep.md")]);
  assert.deepEqual(ops.createFolder({ path: "projects/keep.md", now: NOW }), { ok: false, reason: "taken" });
  assert.deepEqual(ops.createFolder({ path: "projects/keep.md/sub", now: NOW }), { ok: false, reason: "taken" });
  assert.equal(rows.byPath("projects/keep.md").id, "f1");
  assert.equal(minted(), 0);
});

test("createFolder refuses a path under .context", { skip }, () => {
  const { rows, ops, minted } = world();
  assert.deepEqual(ops.createFolder({ path: ".context/x", now: NOW }), { ok: false, reason: "invalid" });
  assert.equal(rows.count(), 0);
  assert.equal(minted(), 0);
});

test("createFolder gives a top-level inbox made when no inbox job exists the inbox role", { skip }, () => {
  const { rows, ops } = world();
  const answer = ops.createFolder({ path: "inbox", now: NOW });
  assert.equal(answer.created, true);
  assert.equal(rows.byPath("inbox").role, "inbox");
});

test("createFolder at the meetings setting's path gets the meetings role; another path gets none", { skip }, () => {
  const { rows, ops } = world();
  ops.createFolder({ path: "meetings", now: NOW, meetingsPath: "meetings" });
  ops.createFolder({ path: "notes", now: NOW, meetingsPath: "meetings" });
  assert.equal(rows.byPath("meetings").role, "meetings");
  assert.equal(rows.byPath("notes").role, null);
});

test("createFolder revives a retired folder row at the path under the same id, with the clock stepped on", { skip }, () => {
  const { rows, ops, minted } = world();
  rows.put([folder("d1", "projects"), folder("d2", "projects/launch"), note("f1", "projects/launch/brief.md")]);
  ops.trash({ path: "projects/launch/brief.md", now: NOW });
  assert.equal(rows.byPath("projects/launch"), null);
  const base = minted();
  const answer = ops.createFolder({ path: "projects/launch", now: NOW });
  assert.equal(answer.created, true);
  assert.equal(rows.byPath("projects/launch").id, "d2");
  assert.equal(rows.byPath("projects/launch").at, NOW + 1);
  assert.equal(minted(), base);
  assert.deepEqual(answer.rows.map((row) => row.id), ["d2"]);
});

test("every row a trash, restore or createFolder writes takes max(now, held + 1)", { skip }, () => {
  const { rows, ops } = world();
  rows.put([
    folder("d1", "projects"),
    folder("d2", "projects/launch", { at: NOW + 10 }),
    note("f1", "projects/launch/brief.md", { at: NOW + 20 }),
    note("f2", "projects/keep.md", { at: NOW + 50 }),
  ]);
  const folderTrash = ops.trash({ path: "projects/launch", now: NOW });
  assert.deepEqual(
    Object.fromEntries(rows.get(["d2", "f1"]).map((row) => [row.id, row.at])),
    { d2: NOW + 11, f1: NOW + 21 },
  );
  assert.equal(folderTrash.ok, true);
  const noteTrash = ops.trash({ path: "projects/keep.md", now: NOW });
  assert.equal(rows.get(["f2"])[0].at, NOW + 51);
  ops.restore({ from: noteTrash.to, to: "projects/keep.md", now: NOW });
  assert.equal(rows.get(["f2"])[0].at, NOW + 52);
  const made = ops.createFolder({ path: "areas", now: NOW });
  assert.equal(made.rows[0].at, NOW);
});
