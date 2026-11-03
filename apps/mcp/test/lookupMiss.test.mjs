// Whether the object may answer that nothing is at a path (`workspaceStore/lookupMiss.js` `absentHere`), over a real
// workspace rows store on node:sqlite. A path with no live row is absent unless a built-in folder's name reroutes it
// (`inbox/...` once a root folder is not named so), or it is a Tex home (a folder with the tex role, `tex/`, or a group
// chat's `tex/groups/`), judged the same whatever the case of the path.
//
import { test } from "node:test";
import assert from "node:assert/strict";

import { absentHere } from "../src/workspaceStore/lookupMiss.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";

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
  return workspaceRows(sqlOver(db));
}

const ID = (n) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

test("no row at the path, and nothing reroutes it: absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "plans/x.md"), true);
});

test("a live row at the path is not absent", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(1), noteId: ID(1), path: "plans/x.md", kind: "file", at: 1 }]);
  assert.equal(absentHere(rows, "plans/x.md"), false);
});

test("a top-level path with no folders is absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "plans/x.md"), true);
  assert.equal(absentHere(rows, "x.md"), true);
});

test("inbox is a job name: with no root folder named inbox, a path under it is not absent (it is rerouted)", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "inbox/x.md"), false);
  // A numbered name plays the same job, so it is rerouted too.
  assert.equal(absentHere(rows, "0-inbox/x.md"), false);
});

test("inbox with a live root folder named inbox: the path is absent, the folder answers for itself", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(2), path: "inbox", kind: "folder", at: 1 }]);
  assert.equal(absentHere(rows, "inbox/x.md"), true);
});

test("a folder named inbox that is gone no longer answers the job, so the path is rerouted again", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(2), path: "inbox", kind: "folder", at: 1 }]);
  rows.remove([ID(2)], 2);
  assert.equal(absentHere(rows, "inbox/x.md"), false);
});

test("tex is a job: a path under tex is not absent when there is a tex folder", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(3), path: "tex", kind: "folder", at: 1 }]);
  assert.equal(absentHere(rows, "tex/x.md"), false);
});

test("tex with no folder named tex is still not absent: Tex's home is the control plane's to name", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "tex/x.md"), false);
});

test("a path under a folder with the tex role is not absent, whatever the folder is called", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(4), path: "assistant", kind: "folder", role: "tex", at: 1 }]);
  assert.equal(absentHere(rows, "assistant/x.md"), false);
  assert.equal(absentHere(rows, "assistant/deeper/y.md"), false);
});

test("a group chat's home is not absent, with no folders at all", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "tex/groups/abc/x.md"), false);
});

test("a group chat's home is not absent in any letter case", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, "Tex/Groups/abc/x.md"), false);
  assert.equal(absentHere(rows, "TEX/GROUPS/abc/x.md"), false);
});

test("a gone row at the path is absent again", { skip }, () => {
  const rows = fresh();
  rows.put([{ id: ID(5), noteId: ID(5), path: "plans/x.md", kind: "file", at: 1 }]);
  assert.equal(absentHere(rows, "plans/x.md"), false);
  rows.remove([ID(5)], 2);
  assert.equal(absentHere(rows, "plans/x.md"), true);
});

test("an empty or non-string path is never absent", { skip }, () => {
  const rows = fresh();
  assert.equal(absentHere(rows, ""), false);
  assert.equal(absentHere(rows, null), false);
});
