// The tree's move (`workspaceStore/treeOps.js` `move`) over the object's `ws_rows`: a rename or a folder move keeps
// every id and etag, refusals write nothing, the clock only goes forward, and the Archive, the job folders and the
// Tex chat homes keep their places. Mirrors apps/convex/__tests__/nodes/keyedRowMove.test.ts, archiveMirror.test.ts
// and the sealed chat homes' rules (sealedChats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceRows } from "../src/workspaceStore/rows.js";
import { chatHomesMoveRefused, treeOps } from "../src/workspaceStore/treeOps.js";

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

/** A fresh object with `seed` rows put in it. `minted()` counts the ids the object made. */
function world(seed = []) {
  const sql = durableSql();
  const rows = workspaceRows(sql);
  let n = 0;
  const ops = treeOps(sql, { mintId: () => `o_new${++n}` });
  if (seed.length > 0) rows.put(seed);
  return { sql, rows, ops, minted: () => n };
}

const file = (id, path, extra = {}) => ({ id, noteId: `n${id.slice(1)}`, path, kind: "file", storageKey: `notes/n${id.slice(1)}.md`, etag: `e${id.slice(1)}`, at: 100, ...extra });
const folder = (id, path, extra = {}) => ({ id, path, kind: "folder", at: 100, ...extra });
const snapshot = (rows) => JSON.stringify(rows.list().rows);
const refused = (answer, reason) => {
  assert.equal(answer.ok, false, `expected refusal ${reason}, got ${JSON.stringify(answer)}`);
  assert.equal(answer.reason, reason);
};
const rowAt = (rows, path) => rows.byPath(path);

test("a file rename keeps its id, note, etag and key, and answers the moved row", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/launch/brief.md")]);
  const answer = ops.move({ from: "projects/launch/brief.md", to: "projects/launch/brief-v2.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(answer.kind, "file");
  assert.equal(answer.count, 1);
  assert.deepEqual(answer.files, [{ from: "projects/launch/brief.md", to: "projects/launch/brief-v2.md" }]);
  assert.equal(answer.etag, "e1");
  assert.equal(rowAt(rows, "projects/launch/brief.md"), null);
  const moved = rowAt(rows, "projects/launch/brief-v2.md");
  assert.equal(moved.id, "f1");
  assert.equal(moved.noteId, "n1");
  assert.equal(moved.etag, "e1");
  assert.equal(moved.storageKey, "notes/n1.md");
  assert.equal(moved.at, 1000);
  const listed = answer.rows.find((row) => row.id === "f1");
  assert.equal(listed?.path, "projects/launch/brief-v2.md");
});

test("a folder move rewrites every path beneath it through several levels, keeping ids; count is folder plus descendants", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "projects"),
    folder("d2", "projects/launch"),
    folder("d3", "projects/launch/q1"),
    folder("d4", "projects/launch/q1/deep"),
    file("f1", "projects/launch/brief.md"),
    file("f2", "projects/launch/q1/plan.md"),
    file("f3", "projects/launch/q1/deep/x.md"),
  ]);
  const answer = ops.move({ from: "projects/launch", to: "areas/launch", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(answer.kind, "folder");
  assert.equal(answer.count, 6);
  assert.deepEqual(answer.removed, []);
  assert.deepEqual(
    answer.files.map((file) => file.to).sort(),
    ["areas/launch/brief.md", "areas/launch/q1/deep/x.md", "areas/launch/q1/plan.md"],
  );
  assert.equal(rowAt(rows, "projects/launch/q1/deep/x.md"), null);
  assert.equal(rowAt(rows, "areas/launch/q1/deep/x.md").id, "f3");
  assert.equal(rowAt(rows, "areas/launch").id, "d2");
  assert.equal(rowAt(rows, "areas/launch/q1").id, "d3");
  assert.equal(rowAt(rows, "areas/launch/q1/deep").id, "d4");
  assert.equal(rowAt(rows, "areas/launch/brief.md").id, "f1");
  // The old top-level folder is a job folder, so it stays even when empty.
  assert.equal(rowAt(rows, "projects").id, "d1");
});

test("a destination chain is made where nothing stands, and a folder already on it is left as it was", { skip }, () => {
  const { rows, ops, minted } = world([folder("d1", "areas", { at: 100 }), file("f1", "projects/brief.md")]);
  const answer = ops.move({ from: "projects/brief.md", to: "areas/deep/x.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(minted(), 1, "only the missing folder is made");
  const made = answer.rows.find((row) => row.path === "areas/deep");
  assert.equal(made?.id, "o_new1");
  assert.equal(made?.kind, "folder");
  assert.equal(rowAt(rows, "areas/deep/x.md").id, "f1");
  const kept = rows.get(["d1"])[0];
  assert.equal(kept.path, "areas");
  assert.equal(kept.at, 100, "the folder that was there is not rewritten");
});

test("a chain of two missing folders is made outermost first, each with a fresh id", { skip }, () => {
  const { rows, ops, minted } = world([file("f1", "projects/brief.md")]);
  const answer = ops.move({ from: "projects/brief.md", to: "areas/deep/x.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(minted(), 2);
  assert.equal(rowAt(rows, "areas").id, "o_new1");
  assert.equal(rowAt(rows, "areas/deep").id, "o_new2");
});

test("a removed folder on the destination chain is revived under its own id, not replaced", { skip }, () => {
  const { rows, ops, minted } = world([folder("d1", "areas", { at: 10 }), file("f1", "projects/brief.md")]);
  rows.remove(["d1"], 50);
  assert.equal(rows.get(["d1"]).length, 0);
  const answer = ops.move({ from: "projects/brief.md", to: "areas/x.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(minted(), 0, "no new folder was made");
  assert.ok(answer.rows.some((row) => row.id === "d1" && row.path === "areas"));
  assert.equal(rows.get(["d1"])[0].path, "areas");
  assert.equal(rowAt(rows, "areas").id, "d1");
  assert.equal(rowAt(rows, "areas/x.md").id, "f1");
});

test("the only file leaving a plain folder retires it and each emptied plain parent above, clocked", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "scratch"),
    folder("d2", "scratch/2024"),
    folder("d3", "scratch/2024/jan"),
    file("f1", "scratch/2024/jan/a.md"),
  ]);
  const answer = ops.move({ from: "scratch/2024/jan/a.md", to: "projects/a.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.removed, [
    { id: "d3", at: 1000 },
    { id: "d2", at: 1000 },
    { id: "d1", at: 1000 },
  ]);
  assert.deepEqual(rows.get(["d1", "d2", "d3"]), []);
  assert.equal(rowAt(rows, "projects/a.md").id, "f1");
});

for (const name of ["resources", "3-resources", "archive"]) {
  test(`a top-level folder named for the job ${name} is not retired when it empties`, { skip }, () => {
    const { rows, ops } = world([folder("d1", name), file("f1", `${name}/a.md`)]);
    const answer = ops.move({ from: `${name}/a.md`, to: "projects/a.md", now: 1000 });
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.removed, []);
    assert.equal(rowAt(rows, name).id, "d1");
  });
}

test("a folder with a role is not retired when it empties, and nor is anything above it", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "work"),
    folder("d2", "work/meetings", { role: "meetings" }),
    file("f1", "work/meetings/m.md"),
  ]);
  const answer = ops.move({ from: "work/meetings/m.md", to: "areas/m.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.removed, []);
  assert.equal(rowAt(rows, "work/meetings").id, "d2");
  assert.equal(rowAt(rows, "work").id, "d1");
});

// Refusals: each builds its own world, asks for the move, and checks that the rows did not change.
const refusals = [
  ["a live file at the destination is taken", [file("f1", "projects/brief.md"), file("f2", "areas/x.md")], "projects/brief.md", "areas/x.md", "taken"],
  [
    "a folder onto an existing folder is taken, never merged",
    [folder("d1", "projects"), folder("d2", "projects/launch"), file("f1", "projects/launch/a.md"), folder("d3", "areas")],
    "projects/launch",
    "areas",
    "taken",
  ],
  [
    "a live row beneath the destination, with no folder row there, is taken",
    [file("f1", "projects/brief.md"), file("f2", "areas/people/notes.md")],
    "projects/brief.md",
    "areas/people",
    "taken",
  ],
  [
    "a destination below a live file is taken",
    [file("f1", "projects/brief.md"), file("f2", "a.md")],
    "projects/brief.md",
    "a.md/b.md",
    "taken",
  ],
  [
    "a folder into itself is invalid",
    [folder("d1", "projects"), file("f1", "projects/a.md")],
    "projects",
    "projects/sub",
    "invalid",
  ],
  ["a folder onto its ancestor is invalid", [folder("d1", "projects"), folder("d2", "projects/launch")], "projects/launch", "projects", "invalid"],
  ["a move onto itself is invalid", [file("f1", "projects/a.md")], "projects/a.md", "projects/a.md", "invalid"],
  ["a missing source is not_found", [file("f1", "projects/a.md")], "nope.md", "x.md", "not_found"],
];

for (const [title, seed, from, to, reason] of refusals) {
  test(`refused, nothing written: ${title}`, { skip }, () => {
    const { rows, ops } = world(seed);
    const before = snapshot(rows);
    refused(ops.move({ from, to, now: 1000 }), reason);
    assert.equal(snapshot(rows), before);
  });
}

test("a file in the subtree with no storage key is unkeyed, and nothing moves", { skip }, () => {
  const { rows, ops } = world([folder("d1", "projects"), file("f1", "projects/a.md", { storageKey: null })]);
  const before = snapshot(rows);
  refused(ops.move({ from: "projects", to: "areas/projects", now: 1000 }), "unkeyed");
  assert.equal(snapshot(rows), before);
});

test("an expected etag that is not the file's is changed, with the current etag named", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/a.md")]);
  const before = snapshot(rows);
  const answer = ops.move({ from: "projects/a.md", to: "areas/a.md", now: 1000, expectedEtag: "old" });
  refused(answer, "changed");
  assert.equal(answer.currentEtag, "e1");
  assert.equal(snapshot(rows), before);
});

test("an expected etag on a folder is invalid, not a conflict", { skip }, () => {
  const { rows, ops } = world([folder("d1", "projects"), file("f1", "projects/a.md")]);
  const before = snapshot(rows);
  refused(ops.move({ from: "projects", to: "areas/projects", now: 1000, expectedEtag: "e1" }), "invalid");
  assert.equal(snapshot(rows), before);
});

test("planned files must be exactly the files under the move: a missing one is changed, the exact list moves", { skip }, () => {
  const seed = [folder("d1", "projects"), file("f1", "projects/a.md"), file("f2", "projects/b.md")];
  const short = world(seed);
  const before = snapshot(short.rows);
  refused(short.ops.move({ from: "projects", to: "areas/projects", now: 1000, plannedFiles: ["projects/a.md"] }), "changed");
  assert.equal(snapshot(short.rows), before);

  const exact = world(seed);
  const answer = exact.ops.move({ from: "projects", to: "areas/projects", now: 1000, plannedFiles: ["projects/b.md", "projects/a.md"] });
  assert.equal(answer.ok, true);
  assert.equal(answer.count, 3);
});

test("a non-trash move into or out of .context is invalid", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/a.md"), file("f2", ".context/x.md")]);
  const before = snapshot(rows);
  refused(ops.move({ from: "projects/a.md", to: ".context/a.md", now: 1000 }), "invalid");
  refused(ops.move({ from: ".context/x.md", to: "projects/x.md", now: 1000 }), "invalid");
  assert.equal(snapshot(rows), before);
});

test("a trash move with neither end under .context/trash is invalid", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/a.md")]);
  const before = snapshot(rows);
  refused(ops.move({ from: "projects/a.md", to: "areas/a.md", now: 1000, trash: true }), "invalid");
  assert.equal(snapshot(rows), before);
});

test("invalid paths are refused at either end", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/a.md")]);
  const before = snapshot(rows);
  for (const bad of ["", "/a", "a//b", "../x"]) {
    refused(ops.move({ from: bad, to: "ok/x.md", now: 1000 }), "invalid");
    refused(ops.move({ from: "projects/a.md", to: bad, now: 1000 }), "invalid");
  }
  assert.equal(snapshot(rows), before);
});

test("a judge that hides the source answers not_found, for a file and for a folder", { skip }, () => {
  const { rows, ops } = world([folder("d1", "projects"), file("f1", "projects/a.md")]);
  const before = snapshot(rows);
  const judge = (path) => path !== "projects/a.md" && path !== "projects";
  refused(ops.move({ from: "projects/a.md", to: "areas/a.md", now: 1000, judge }), "not_found");
  refused(ops.move({ from: "projects", to: "areas/projects", now: 1000, judge }), "not_found");
  assert.equal(snapshot(rows), before);
});

test("a judge that hides one file under a moved folder refuses the whole move as hidden", { skip }, () => {
  const { rows, ops } = world([folder("d1", "projects"), file("f1", "projects/a.md"), file("f2", "projects/secret.md")]);
  const before = snapshot(rows);
  const judge = (path) => path !== "projects/secret.md";
  refused(ops.move({ from: "projects", to: "areas/projects", now: 1000, judge }), "hidden");
  assert.equal(snapshot(rows), before);
  assert.equal(rowAt(rows, "projects/secret.md").id, "f2");
});

test("a tombstone at the destination does not block the move; the moved row takes the name", { skip }, () => {
  const { rows, ops } = world([file("f1", "projects/a.md"), file("f2", "areas/x.md")]);
  rows.remove(["f2"], 200);
  assert.equal(rows.get(["f2"]).length, 0);
  const answer = ops.move({ from: "projects/a.md", to: "areas/x.md", now: 1000 });
  assert.equal(answer.ok, true);
  assert.equal(rowAt(rows, "areas/x.md").id, "f1");
  assert.deepEqual(rows.get(["f2"]), [], "the tombstone stays gone");
});

test("each moved row takes the later of now and its own clock plus one", { skip }, () => {
  const solo = world([file("f1", "projects/a.md", { at: 5000 })]);
  assert.equal(solo.ops.move({ from: "projects/a.md", to: "projects/b.md", now: 1000 }).ok, true);
  assert.equal(solo.rows.get(["f1"])[0].at, 5001);

  const tree = world([folder("d1", "projects", { at: 100 }), file("f1", "projects/b.md", { at: 100 })]);
  assert.equal(tree.ops.move({ from: "projects", to: "areas/projects", now: 1000 }).ok, true);
  assert.equal(tree.rows.get(["d1"])[0].at, 1000);
  assert.equal(tree.rows.get(["f1"])[0].at, 1000);
});

test("Archive stays at the top, and a built-in folder cannot go into it", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "archive"),
    folder("d2", "projects"),
    folder("d3", "projects/launch"),
    file("f1", "archive/old.md"),
    file("f2", "projects/launch/x.md"),
  ]);
  const before = snapshot(rows);
  refused(ops.move({ from: "archive", to: "old/archive", now: 1000 }), "archive_stays");
  refused(ops.move({ from: "projects", to: "archive/projects", now: 1000 }), "built_in_archived");
  assert.equal(snapshot(rows), before);

  const renamed = ops.move({ from: "archive", to: "done", now: 1000 });
  assert.equal(renamed.ok, true);
  assert.equal(rowAt(rows, "done").id, "d1");
  assert.equal(rowAt(rows, "done").role, "archive", "the job is written down before the name goes");

  const plain = ops.move({ from: "projects/launch", to: "done/launch", now: 1000 });
  assert.equal(plain.ok, true);
  assert.equal(rowAt(rows, "done/launch/x.md").id, "f2");
});

test("a plain folder holding a meetings-role folder cannot be moved into Archive", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "archive"),
    folder("d2", "work"),
    folder("d3", "work/meetings", { role: "meetings" }),
    file("f1", "work/meetings/m.md"),
  ]);
  const before = snapshot(rows);
  refused(ops.move({ from: "work", to: "archive/work", now: 1000 }), "built_in_archived");
  assert.equal(snapshot(rows), before);
});

test("a job is claimed before a built-in folder is renamed, and a plain folder keeps no role", { skip }, () => {
  const { rows, ops } = world([folder("d1", "inbox"), file("f1", "inbox/a.md"), folder("d2", "notes"), file("f2", "notes/b.md")]);
  assert.equal(ops.move({ from: "inbox", to: "capture", now: 1000 }).ok, true);
  assert.equal(rowAt(rows, "capture").role, "inbox");
  assert.equal(rowAt(rows, "capture/a.md").id, "f1");

  assert.equal(ops.move({ from: "notes", to: "ideas", now: 1000 }).ok, true);
  assert.equal(rowAt(rows, "ideas").role, null);
});

test("sealed chat homes: a home cannot move, a note moves within its home, and nothing leaves or crosses one", { skip }, () => {
  const seed = [
    folder("d1", "tex"),
    folder("d2", "tex/groups"),
    folder("d3", "tex/groups/g1"),
    file("f1", "tex/groups/g1/a.md"),
    file("f2", "notes/a.md"),
  ];
  const sealed = world(seed);
  const before = snapshot(sealed.rows);
  const opts = { now: 1000, sealsChatHomes: true };
  refused(sealed.ops.move({ from: "tex/groups/g1", to: "tex/groups/g9", ...opts }), "invalid");
  refused(sealed.ops.move({ from: "tex/groups/g1/a.md", to: "tex/groups/g2/a.md", ...opts }), "invalid");
  refused(sealed.ops.move({ from: "tex/groups/g1/a.md", to: "notes/a.md", ...opts }), "invalid");
  assert.equal(snapshot(sealed.rows), before);

  const within = sealed.ops.move({ from: "tex/groups/g1/a.md", to: "tex/groups/g1/b.md", ...opts });
  assert.equal(within.ok, true);
  assert.equal(rowAt(sealed.rows, "tex/groups/g1/b.md").id, "f1");

  const unsealed = world(seed);
  assert.equal(unsealed.ops.move({ from: "tex/groups/g1", to: "tex/groups/g9", now: 1000, sealsChatHomes: false }).ok, true);
});

test("chatHomesMoveRefused: a note may leave and enter a home by trash, a home itself may not", () => {
  // Trashing a note out of its home, and restoring one into it, are allowed.
  assert.equal(chatHomesMoveRefused("tex/groups/g1/a.md", ".context/trash/s/tex/groups/g1/a.md", true), false);
  assert.equal(chatHomesMoveRefused(".context/trash/s/tex/groups/g1/a.md", "tex/groups/g1/a.md", true), false);
  // A home folder, or the chat folder above it, may not be trashed or restored.
  assert.equal(chatHomesMoveRefused("tex/groups/g1", ".context/trash/s/g1", true), true);
  assert.equal(chatHomesMoveRefused(".context/trash/s/g1", "tex/groups/g1", true), true);
  assert.equal(chatHomesMoveRefused("tex/groups", ".context/trash/s/groups", true), true);
  // Paths that never touch the chat homes are not refused.
  assert.equal(chatHomesMoveRefused("notes/a.md", "notes/trash.md", true), false);
  assert.equal(chatHomesMoveRefused("notes/a.md", "areas/a.md", false), false);
  // Without trash, moving the chat folder itself, or into it from outside, is refused.
  assert.equal(chatHomesMoveRefused("tex", "x/tex", false), true);
  assert.equal(chatHomesMoveRefused("notes/a.md", "tex/groups/g1/a.md", false), true);
});

// A folder's contents are read as a range on the path index (`path >= "a/" AND path < "a0"`, '0' being the byte after
// '/'), not a `substr` test over every row (2026-11-03). Its neighbours by name must stay where they are.
test("a folder move takes only what is under it, never a sibling that shares its name's start", { skip }, () => {
  const { rows, ops } = world([
    folder("d1", "a"),
    file("f1", "a/x.md"),
    folder("d2", "a/sub"),
    file("f2", "a/sub/w.md"),
    file("f3", "a.md"),
    folder("d3", "a-b"),
    file("f4", "a-b/y.md"),
    folder("d4", "ab"),
    file("f5", "ab/z.md"),
    folder("d5", "a0"),
    file("f6", "a0/q.md"),
  ]);
  const answer = ops.move({ from: "a", to: "c", now: 1000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.files.map((pair) => pair.to).sort(), ["c/sub/w.md", "c/x.md"]);
  for (const kept of ["a.md", "a-b/y.md", "ab/z.md", "a0/q.md"]) assert.notEqual(rowAt(rows, kept), null, kept);
  assert.equal(rowAt(rows, "a/x.md"), null);
});
