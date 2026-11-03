// Object-originated row changes (`originate`, `originateNew`) and the pushes from Convex that keep them (`put`'s
// `objectAt` rule and `snapshot`'s replace): an older push keeps the fields the object wrote and takes the rest, a
// caught-up push takes the whole row and clears ownership, a folder's move is never an originated field change, and a
// table made by the old schema gets the two columns.
//
// Sabotage: make `put` ignore ownership (always write the whole row) and "an older push keeps the object's fields"
// fails; drop the `own_fields` union in `originate` and "originate stamps the object's clock" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceRows, WorkspaceRowRefused } from "../src/workspaceStore/rows.js";
import { treeOps, trashStamp } from "../src/workspaceStore/treeOps.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function sqlOver(db) {
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

function fresh() {
  const db = new DatabaseSync(":memory:");
  return { db, rows: workspaceRows(sqlOver(db)) };
}

/** The ws_rows table as it was before the ownership columns: the production objects that already hold rows. */
const OLD_SCHEMA = `CREATE TABLE ws_rows (
    id TEXT PRIMARY KEY,
    note_id TEXT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_key TEXT,
    etag TEXT,
    size INTEGER,
    collaborates INTEGER NOT NULL DEFAULT 0,
    uploaded INTEGER,
    role TEXT,
    ord REAL,
    archive_of TEXT,
    at INTEGER NOT NULL,
    gone INTEGER NOT NULL DEFAULT 0
  )`;

test("originate stamps the object's clock and records the fields it set", { skip }, () => {
  const { rows } = fresh();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10, noteId: "note1" }]);

  const out = rows.originate({ id: "n1", fields: { etag: "e2", size: 20 } }, 3);
  assert.equal(out.at, 6, "max(now, held.at + 1)");
  assert.equal(out.etag, "e2");
  assert.equal(out.size, 20);
  assert.equal(out.path, "a.md", "fields not named are untouched");
  assert.equal(out.noteId, "note1");
  assert.deepEqual(rows.ownership("n1"), { ownAt: 6, ownFields: ["etag", "size"] });

  const later = rows.originate({ id: "n1", fields: { path: "b.md" } }, 100);
  assert.equal(later.at, 100);
  assert.deepEqual(rows.ownership("n1"), { ownAt: 100, ownFields: ["etag", "size", "path"] });
});

test("an older push keeps the object's fields and takes the pushed path", { skip }, () => {
  const { rows } = fresh();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10, objectAt: 0 }]);
  rows.originate({ id: "n1", fields: { etag: "e2", size: 20 } }, 10);

  // Convex saw the object at 5, before its write at 10 (objectAt < ownAt): a rename in Convex arrives, the object's bytes stay.
  rows.put([{ id: "n1", path: "renamed.md", kind: "file", at: 12, etag: "e1", size: 10, objectAt: 5 }]);
  let row = rows.get(["n1"])[0];
  assert.equal(row.path, "renamed.md");
  assert.equal(row.etag, "e2");
  assert.equal(row.size, 20);
  assert.equal(row.at, 12);
  assert.deepEqual(rows.ownership("n1"), { ownAt: 10, ownFields: ["etag", "size"] });

  // A push that names no objectAt counts as older than any ownership.
  rows.put([{ id: "n1", path: "third.md", kind: "file", at: 13, etag: "e1", size: 10 }]);
  row = rows.get(["n1"])[0];
  assert.equal(row.path, "third.md");
  assert.equal(row.etag, "e2");
  assert.deepEqual(rows.ownership("n1"), { ownAt: 10, ownFields: ["etag", "size"] });
});

test("a caught-up push takes the whole row and clears ownership", { skip }, () => {
  const { rows } = fresh();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10 }]);
  rows.originate({ id: "n1", fields: { etag: "e2", size: 20 } }, 10);

  rows.put([{ id: "n1", path: "x.md", kind: "file", at: 13, etag: "e9", size: 1, objectAt: 10 }]);
  const row = rows.get(["n1"])[0];
  assert.equal(row.path, "x.md");
  assert.equal(row.etag, "e9");
  assert.equal(row.size, 1);
  assert.equal(row.at, 13);
  assert.deepEqual(rows.ownership("n1"), { ownAt: 0, ownFields: null });
});

test("a snapshot replace keeps the object's fields the same way", { skip }, () => {
  const { rows } = fresh();
  rows.put([
    { id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10 },
    { id: "n2", path: "b.md", kind: "file", at: 5, etag: "e2" },
  ]);
  rows.originate({ id: "n1", fields: { etag: "e2" } }, 10);

  rows.snapshot({
    epoch: "s1",
    last: true,
    rows: [
      { id: "n1", path: "moved.md", kind: "file", at: 6, etag: "e1", size: 11, objectAt: 3 },
      { id: "n3", path: "c.md", kind: "file", at: 6, etag: "e3" },
    ],
  });
  let row = rows.get(["n1"])[0];
  assert.equal(row.path, "moved.md", "pushed path taken");
  assert.equal(row.etag, "e2", "owned etag kept");
  assert.equal(row.size, 11, "unowned size taken");
  assert.deepEqual(rows.ownership("n1"), { ownAt: 10, ownFields: ["etag"] });
  assert.deepEqual(rows.get(["n2"]), [], "a row the copy does not name is dropped");
  assert.deepEqual(rows.ownership("n3"), { ownAt: 0, ownFields: null });

  // A copy that has caught up with the object's write takes the etag and clears ownership.
  rows.snapshot({ epoch: "s2", last: true, rows: [{ id: "n1", path: "moved.md", kind: "file", at: 11, etag: "e7", size: 11, objectAt: 10 }] });
  row = rows.get(["n1"])[0];
  assert.equal(row.etag, "e7");
  assert.deepEqual(rows.ownership("n1"), { ownAt: 0, ownFields: null });
});

test("a table made by the old schema gets the two columns and keeps its rows", { skip }, () => {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD_SCHEMA);
  db.exec("INSERT INTO ws_rows (id, path, kind, at, etag) VALUES ('old1', 'a.md', 'file', 4, 'e1')");

  const rows = workspaceRows(sqlOver(db));
  const columns = db.prepare("SELECT name FROM pragma_table_info('ws_rows')").all().map((column) => column.name);
  assert.ok(columns.includes("own_at") && columns.includes("own_fields"));
  assert.deepEqual(rows.ownership("old1"), { ownAt: 0, ownFields: null });

  const out = rows.originate({ id: "old1", fields: { etag: "e2" } }, 9);
  assert.equal(out.etag, "e2");
  assert.equal(out.at, 9);

  // Opening the same table again (every object start) changes nothing and does not fail on the existing columns.
  const again = workspaceRows(sqlOver(db));
  assert.equal(again.get(["old1"])[0].etag, "e2");
  assert.deepEqual(again.ownership("old1"), { ownAt: 9, ownFields: ["etag"] });
});

test("originate refuses a folder's path move and any field it does not own", { skip }, () => {
  const { rows } = fresh();
  rows.put([{ id: "f1", path: "projects", kind: "folder", at: 5 }]);
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5 }]);

  assert.throws(
    () => rows.originate({ id: "f1", fields: { path: "elsewhere" } }, 9),
    (error) => error instanceof WorkspaceRowRefused && error.message === "move a folder with its own op",
  );
  assert.equal(rows.get(["f1"])[0].path, "projects");
  assert.deepEqual(rows.ownership("f1"), { ownAt: 0, ownFields: null });

  assert.equal(rows.originate({ id: "f1", fields: { role: "projects" } }, 9).role, "projects", "a folder's other fields are not a move");
  assert.equal(rows.originate({ id: "n1", fields: { path: "b.md" } }, 9).path, "b.md", "a file's path is originated");

  for (const fields of [{}, { bogus: 1 }, { kind: "link" }, { path: "" }, { size: "12" }, { noteId: 5 }]) {
    assert.throws(() => rows.originate({ id: "n1", fields }, 10), WorkspaceRowRefused, JSON.stringify(fields));
  }
});

test("originate returns null for a gone or missing row", { skip }, () => {
  const { rows } = fresh();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5 }]);
  rows.remove(["n1"], 8);
  assert.equal(rows.originate({ id: "n1", fields: { etag: "x" } }, 9), null);
  assert.equal(rows.originate({ id: "nope", fields: { etag: "x" } }, 9), null);
  assert.equal(rows.ownership("nope"), null);
});

test("originateNew adds a row at the object's clock and refuses an id that exists", { skip }, () => {
  const { rows } = fresh();
  const out = rows.originateNew({ id: "n9", path: "new.md", kind: "file", noteId: "note9", etag: "e1", size: 3 }, 7);
  assert.equal(out.id, "n9");
  assert.equal(out.at, 7);
  assert.equal(out.noteId, "note9");
  assert.equal(out.uploaded, null);
  assert.deepEqual(rows.ownership("n9"), { ownAt: 7, ownFields: ["path", "kind", "noteId", "etag", "size"] });

  assert.throws(() => rows.originateNew({ id: "n9", path: "x.md", kind: "file" }, 8), WorkspaceRowRefused);
  rows.remove(["n9"], 9);
  assert.throws(() => rows.originateNew({ id: "n9", path: "x.md", kind: "file" }, 10), WorkspaceRowRefused, "a tombstone holds the id too");

  rows.put([{ id: "n9", path: "renamed.md", kind: "file", at: 12, etag: "e0", objectAt: 0 }]);
  assert.equal(rows.get(["n9"]).length, 1);
});

// The tree's own writes (`treeOps`: move, trash, remove, folder stand-up) record what they own, and the pushes that
// follow them: an agreeing push takes the row whole, a trashed note removed by the object stays gone against an older
// push, a moved folder's child keeps its new path, and a snapshot keeps what the object owns and drops what it does not.

const NOW = Date.UTC(2026, 10, 3, 1, 2, 3, 456);
const TRASH = `.context/trash/${trashStamp(NOW)}`;

/** A fresh object with its rows and the tree's ops over the same SQLite; the ids the object mints are `o_new<n>`. */
function treeWorld() {
  const db = new DatabaseSync(":memory:");
  const sql = sqlOver(db);
  const rows = workspaceRows(sql);
  let minted = 0;
  const ops = treeOps(sql, { mintId: () => `o_new${++minted}` });
  return { rows, ops };
}

/** A file row as Convex pushes it: its clock `at`, and an `objectAt` only when the push names one. */
const pushedNote = (id, path, at, extra = {}) => ({ id, noteId: `n-${id}`, path, kind: "file", storageKey: `notes/${id}.md`, etag: `e-${id}`, at, ...extra });

/** A note the object trashed and then removed for good: its row is a tombstone at NOW + 1, owned as gone. */
function removedFromTrash() {
  const world = treeWorld();
  world.rows.put([pushedNote("f1", "a.md", 100)]);
  assert.equal(world.ops.trash({ path: "a.md", now: NOW }).ok, true);
  assert.equal(world.ops.remove({ path: `${TRASH}/a.md`, now: NOW + 1 }).ok, true);
  assert.deepEqual(world.rows.get(["f1"]), []);
  assert.equal(world.rows.ownership("f1").ownAt, NOW + 1);
  return world;
}

test("a push agreeing with every owned field clears ownership, even when its objectAt is older than own_at", { skip }, () => {
  const { rows } = treeWorld();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10 }]);
  rows.originate({ id: "n1", fields: { etag: "e2", size: 20 } }, 10);
  assert.deepEqual(rows.ownership("n1"), { ownAt: 10, ownFields: ["etag", "size"] });

  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 11, etag: "e2", size: 20, objectAt: 3 }]);
  assert.deepEqual(rows.ownership("n1"), { ownAt: 0, ownFields: null });
  assert.equal(rows.get(["n1"])[0].at, 11);
});

test("a push disagreeing on an owned field keeps the object's value and its ownership", { skip }, () => {
  const { rows } = treeWorld();
  rows.put([{ id: "n1", path: "a.md", kind: "file", at: 5, etag: "e1", size: 10 }]);
  rows.originate({ id: "n1", fields: { etag: "e2", size: 20 } }, 10);

  rows.put([{ id: "n1", path: "renamed.md", kind: "file", at: 11, etag: "e9", size: 20, objectAt: 3 }]);
  const row = rows.get(["n1"])[0];
  assert.equal(row.path, "renamed.md", "the unowned path is taken");
  assert.equal(row.etag, "e2", "the owned etag is kept");
  assert.deepEqual(rows.ownership("n1"), { ownAt: 10, ownFields: ["etag", "size"] });
});

test("a push older than the object's removal of a trashed note leaves it gone; one that reaches the removal brings it back", { skip }, () => {
  for (const objectAt of [undefined, NOW]) {
    const { rows } = removedFromTrash();
    rows.put([pushedNote("f1", "a.md", NOW + 5, { objectAt })]);
    assert.deepEqual(rows.get(["f1"]), [], `objectAt ${objectAt}`);
  }

  const { rows } = removedFromTrash();
  rows.put([pushedNote("f1", "a.md", NOW + 5, { objectAt: NOW + 1 })]);
  const row = rows.get(["f1"]);
  assert.equal(row.length, 1);
  assert.equal(row[0].path, "a.md");
});

test("a moved folder's child keeps its new path against an old push, and a push with the new path clears ownership", { skip }, () => {
  const { rows, ops } = treeWorld();
  rows.put([
    { id: "d1", path: "projects", kind: "folder", at: 100 },
    { id: "d2", path: "projects/launch", kind: "folder", at: 100 },
    pushedNote("f1", "projects/launch/brief.md", 100),
  ]);
  assert.equal(ops.move({ from: "projects/launch", to: "areas/launch", now: NOW }).ok, true);

  rows.put([pushedNote("f1", "projects/launch/brief.md", NOW + 10)]);
  assert.equal(rows.get(["f1"])[0].path, "areas/launch/brief.md");
  assert.equal(rows.ownership("f1").ownAt, NOW);

  rows.put([pushedNote("f1", "areas/launch/brief.md", NOW + 11)]);
  assert.equal(rows.get(["f1"])[0].path, "areas/launch/brief.md");
  assert.deepEqual(rows.ownership("f1"), { ownAt: 0, ownFields: null });
});

test("a snapshot that omits a row the object made and not yet confirmed keeps it with its fields", { skip }, () => {
  const { rows } = treeWorld();
  rows.originateNew({ id: "o_new1", path: "notes/new.md", kind: "file", noteId: "note-new", etag: "e1", size: 3 }, 10);

  rows.snapshot({ epoch: "e1", last: true, rows: [{ id: "c1", path: "copy.md", kind: "file", at: 1 }] });
  const row = rows.get(["o_new1"]);
  assert.equal(row.length, 1);
  assert.equal(row[0].path, "notes/new.md");
  assert.equal(row[0].noteId, "note-new");
  assert.equal(row[0].etag, "e1");
  assert.equal(row[0].size, 3);
  assert.deepEqual(rows.ownership("o_new1"), { ownAt: 10, ownFields: ["path", "kind", "noteId", "etag", "size"] });
});

test("a snapshot drops a row whose ownership an agreeing push cleared, when the copy leaves it out", { skip }, () => {
  const { rows } = treeWorld();
  rows.originateNew({ id: "o_new2", path: "notes/gone.md", kind: "file", noteId: "note-gone", etag: "e2", size: 4 }, 20);
  rows.put([{ id: "o_new2", path: "notes/gone.md", kind: "file", noteId: "note-gone", etag: "e2", size: 4, at: 21 }]);
  assert.deepEqual(rows.ownership("o_new2"), { ownAt: 0, ownFields: null });

  rows.snapshot({ epoch: "e3", last: true, rows: [{ id: "c2", path: "other.md", kind: "file", at: 1 }] });
  assert.deepEqual(rows.get(["o_new2"]), []);
});

test("a snapshot naming a row the object removed stays gone against a staged row with no objectAt, and is live with objectAt >= own_at", { skip }, () => {
  const { rows } = removedFromTrash();
  rows.snapshot({ epoch: "e4", last: true, rows: [pushedNote("f1", `${TRASH}/a.md`, NOW + 10)] });
  assert.deepEqual(rows.get(["f1"]), [], "no objectAt: stays gone");

  const live = removedFromTrash();
  live.rows.snapshot({ epoch: "e5", last: true, rows: [pushedNote("f1", `${TRASH}/a.md`, NOW + 10, { objectAt: NOW + 1 })] });
  assert.equal(live.rows.get(["f1"]).length, 1, "objectAt >= own_at: live");
});
