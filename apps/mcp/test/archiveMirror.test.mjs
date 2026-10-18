// Archive keeps the shape of the workspace (`packages/shared/src/archiveMirror.cjs`):
// where an archived path lands, what Restore puts back, the numbered name a clash
// takes, and which built-in folders' twins an archived path sits in.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { archiveDestination, restoreTarget, numberedName, firstFreePath, twinsAlong, isArchiveStamp } = require(
  "../../../packages/shared/src/archiveMirror.cjs",
);
const { folderJobs } = require("../../../packages/shared/src/folderRoles.cjs");

test("archiving keeps the path: a project lands beside the others in Archive's Projects", () => {
  assert.equal(archiveDestination("5-archive", "1-projects/context-ci-cd"), "5-archive/1-projects/context-ci-cd");
  assert.equal(archiveDestination("Archive/", "/Work/Projects/launch/"), "Archive/Work/Projects/launch");
});

test("restore takes the archive's name off, and a date folder's too", () => {
  assert.equal(restoreTarget("Archive", "Archive/Work/Projects/launch"), "Work/Projects/launch");
  assert.equal(restoreTarget("9-archive", "9-archive/2026-10-15T22-16-49-545Z/1-projects/a.md"), "1-projects/a.md");
  assert.equal(restoreTarget("9-archive", "9-archive/2026-10-15T22-16-49-545Z-3/1-projects/a.md"), "1-projects/a.md");
  // Nothing to put back: not in the archive, the archive itself, or a date folder alone.
  assert.equal(restoreTarget("Archive", "Projects/a.md"), null);
  assert.equal(restoreTarget("Archive", "Archive"), null);
  assert.equal(restoreTarget("Archive", "Archived/a.md"), null);
  assert.equal(restoreTarget("Archive", "Archive/2026-10-15T22-16-49-545Z"), null);
  assert.equal(restoreTarget(null, "Archive/a.md"), null);
  // A folder that only looks like a date is still a name.
  assert.equal(restoreTarget("Archive", "Archive/2026-10-15/a.md"), "2026-10-15/a.md");
});

test("a taken name arrives numbered, the extension kept", async () => {
  assert.equal(numberedName("notes.md", 2), "notes (2).md");
  assert.equal(numberedName("launch", 3), "launch (3)");
  assert.equal(numberedName(".hidden", 2), ".hidden (2)");
  const taken = new Set(["A/notes.md", "A/notes (2).md"]);
  assert.equal(await firstFreePath("A/notes.md", (p) => taken.has(p)), "A/notes (3).md");
  assert.equal(await firstFreePath("A/free.md", (p) => taken.has(p)), "A/free.md");
  assert.equal(await firstFreePath("A/notes.md", () => true, 5), null);
});

test("an archived path sits in the twin of each built-in folder it came from, outermost first", () => {
  const jobs = folderJobs([
    { path: "Inbox", name: "Inbox", top: true, role: "inbox" },
    { path: "Work", name: "Work", top: true },
    { path: "Work/Projects", name: "Projects", top: false, role: "projects" },
    { path: "Areas", name: "Areas", top: true, role: "areas" },
    { path: "Areas/tex", name: "tex", top: false, role: "tex" },
    { path: "Archive", name: "Archive", top: true, role: "archive" },
  ]);
  assert.deepEqual(twinsAlong(jobs, "Archive", "Archive/Work/Projects/launch/plan.md"), [
    { path: "Archive/Work/Projects", role: "projects" },
  ]);
  assert.deepEqual(twinsAlong(jobs, "Archive", "Archive/Areas/tex/old.md"), [
    { path: "Archive/Areas", role: "areas" },
    { path: "Archive/Areas/tex", role: "tex" },
  ]);
  // A folder of the person's own, or a name that only starts the same, has no twin.
  assert.deepEqual(twinsAlong(jobs, "Archive", "Archive/Work/notes.md"), []);
  assert.deepEqual(twinsAlong(jobs, "Archive", "Archive/Inboxes/a.md"), []);
  assert.deepEqual(twinsAlong(jobs, "Archive", "Work/Projects/a.md"), []);
});

test("the stamp is exactly what archiving used to write", () => {
  assert.equal(isArchiveStamp(new Date(0).toISOString().replace(/[:.]/g, "-")), true);
  assert.equal(isArchiveStamp("1-projects"), false);
});

test("archiving onto a name already in Archive merges into it, and a taken note arrives numbered", async () => {
  const { mergeInto } = require("../../../packages/shared/src/archiveMirror.cjs");
  // A tree as paths: folders end in "/".
  const tree = new Set([
    "P/launch/", "P/launch/notes.md", "P/launch/plan.md", "P/launch/runs/", "P/launch/runs/a.md",
    "A/P/launch/", "A/P/launch/notes.md", "A/P/launch/runs/", "A/P/launch/runs/b.md",
  ]);
  const kindAt = async (path) => (tree.has(`${path}/`) ? "folder" : tree.has(path) ? "file" : null);
  const children = async (folder) =>
    [...tree].filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).replace(/\/$/, "").includes("/"))
      .map((p) => p.slice(folder.length + 1).replace(/\/$/, "")).filter((name) => name !== "").sort();
  const move = async (from, to) => {
    for (const p of [...tree]) {
      if (p === from || p === `${from}/` || p.startsWith(`${from}/`)) {
        tree.delete(p);
        tree.add(`${to}${p.slice(from.length)}`);
      }
    }
  };
  const moved = await mergeInto("P/launch", "A/P/launch", { kindAt, children, move });
  // notes.md is taken, so the newer one is numbered; plan.md is free; runs is merged into, one note at a time.
  assert.deepEqual(moved, [
    { from: "P/launch/notes.md", to: "A/P/launch/notes (2).md" },
    { from: "P/launch/plan.md", to: "A/P/launch/plan.md" },
    { from: "P/launch/runs/a.md", to: "A/P/launch/runs/a.md" },
  ]);
  assert.ok(tree.has("A/P/launch/notes.md") && tree.has("A/P/launch/runs/b.md") && tree.has("A/P/launch/runs/a.md"));

  // A free name takes the whole folder in one move.
  const once = await mergeInto("P/other", "A/P/other", { kindAt: async (p) => (p === "P/other" ? "folder" : null), children, move: async () => {} });
  assert.deepEqual(once, [{ from: "P/other", to: "A/P/other" }]);
});
