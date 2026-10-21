// Built-in folders (`packages/shared/src/folderRoles.cjs`): which top-level
// folder plays which role, which are protected, and the order they are drawn.
// The gateway, control plane, app and router all read it, so it is pinned once.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAIN_FOLDERS,
  DEFAULT_FOLDER,
  folderRole,
  plainFolderName,
  topLevelRole,
  isMainFolder,
  compareTopLevelFolders,
  rolesIn,
  missingMainRoles,
  isProtectedFolder,
  siblingTwin,
  indexingPriority,
  compareIndexingOrder,
  countByIndexingPriority,
  compareListingEntries,
  folderJobs,
  jobAt,
  jobPath,
} = require("../../../packages/shared/src/folderRoles.cjs");

test("the word decides the role, the number only sorts", () => {
  for (const name of ["archive", "Archive", "4-archive", "9-archive", "5-Archive"]) {
    assert.equal(folderRole(name), "archive", name);
  }
  assert.equal(folderRole("1-projects"), "projects");
  assert.equal(folderRole("4-clients"), "clients");
  assert.equal(folderRole("teams"), "teams");
});

test("near misses play no role", () => {
  for (const name of ["old-archive", "archive-2024", "my projects", "project", "1-project", "0-inbox.md", "", "-archive", "4_archive"]) {
    assert.equal(folderRole(name), null, name);
  }
  assert.equal(folderRole(undefined), null);
});

test("only top-level folders have a role", () => {
  assert.equal(topLevelRole("1-projects"), "projects");
  assert.equal(topLevelRole("1-projects/"), "projects");
  assert.equal(topLevelRole("1-projects/clients"), null);
  assert.equal(topLevelRole(""), null);
});

test("the five main folders are protected, extras and contents are not", () => {
  for (const path of ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "9-archive", "archive/"]) {
    assert.equal(isMainFolder(path), true, path);
  }
  for (const path of ["4-clients", "5-teams", "6-products", "recipes", "1-projects/launch", "0-inbox/meetings", "website"]) {
    assert.equal(isMainFolder(path), false, path);
  }
});

test("new workspaces get plain folder names, with no number in front (owner, 2026-10-21)", () => {
  assert.deepEqual(MAIN_FOLDERS, ["inbox", "projects", "areas", "resources", "archive"]);
  for (const name of Object.values(DEFAULT_FOLDER)) assert.doesNotMatch(name, /^\d/);
  // Each default name still plays its own role, so the row takes its job when it is made.
  for (const [role, name] of Object.entries(DEFAULT_FOLDER)) assert.equal(folderRole(name), role);
  // Sorted by job, not by name: Inbox first, Archive last.
  assert.deepEqual([...MAIN_FOLDERS].sort().sort(compareTopLevelFolders), MAIN_FOLDERS);
});

test("plainFolderName drops the sort number from a built-in folder's name, keeping how its word was typed", () => {
  assert.equal(plainFolderName("0-inbox"), "inbox");
  assert.equal(plainFolderName("1-projects"), "projects");
  assert.equal(plainFolderName("2-Areas"), "Areas");
  assert.equal(plainFolderName("9-archive"), "archive");
  assert.equal(plainFolderName("12-clients"), "clients");
  // Nothing to drop, or not a built-in folder's word: null, and the folder keeps its name.
  assert.equal(plainFolderName("inbox"), null);
  assert.equal(plainFolderName("Projects"), null);
  assert.equal(plainFolderName("1-plan"), null);
  assert.equal(plainFolderName("2026-plans"), null);
  assert.equal(plainFolderName("website"), null);
  assert.equal(plainFolderName("0-"), null);
  assert.equal(plainFolderName(""), null);
  assert.equal(plainFolderName(undefined), null);
});

test("archive is drawn last even when its number says otherwise", () => {
  const sorted = ["website", "4-archive", "recipes", "5-clients", "3-resources", "0-inbox", "2-areas", "1-projects", "6-teams"].sort(compareTopLevelFolders);
  assert.deepEqual(sorted, ["0-inbox", "1-projects", "2-areas", "3-resources", "5-clients", "6-teams", "website", "recipes", "4-archive"]);
});

test("rolesIn picks one folder per role regardless of listing order", () => {
  const a = rolesIn(["9-archive", "4-archive", "1-projects"]);
  const b = rolesIn(["1-projects", "4-archive", "9-archive"]);
  assert.deepEqual(a, b);
  assert.equal(a.archive, "4-archive");
  assert.equal(a.inbox, null);
});

test("missingMainRoles names what an older workspace lacks", () => {
  assert.deepEqual(missingMainRoles(["1-projects", "4-archive", "recipes"]), ["inbox", "areas", "resources"]);
  assert.deepEqual(missingMainRoles(MAIN_FOLDERS), []);
  assert.deepEqual(missingMainRoles(["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"]), []);
});

test("indexing priority: everything else first, then the inbox, then the archive", () => {
  assert.equal(indexingPriority("1-projects/a.md"), 1);
  assert.equal(indexingPriority("todo.md"), 1);
  assert.equal(indexingPriority("website/index.md"), 1);
  assert.equal(indexingPriority("1-projects/inbox/a.md"), 1, "only the top-level folder decides");
  assert.equal(indexingPriority("0-inbox/a.md"), 2);
  assert.equal(indexingPriority("Inbox/deep/a.md"), 2);
  assert.equal(indexingPriority("4-archive/a.md"), 3);
  assert.equal(indexingPriority("9-archive/x/y.md"), 3);
  assert.equal(indexingPriority("old-archive/a.md"), 1);
  assert.equal(indexingPriority("archive.md"), 1, "a note named archive is not the folder");

  const order = ["9-archive/a.md", "0-inbox/b.md", "1-projects/z.md", "0-inbox/a.md", "a.md"].sort(compareIndexingOrder);
  assert.deepEqual(order, ["1-projects/z.md", "a.md", "0-inbox/a.md", "0-inbox/b.md", "9-archive/a.md"]);

  const done = new Set(["1-projects/z.md", "0-inbox/a.md"]);
  assert.deepEqual(countByIndexingPriority(order, (p) => done.has(p), ["4-archive/gone.md"]), [
    { priority: 1, indexed: 1, pending: 1 },
    { priority: 2, indexed: 1, pending: 1 },
    { priority: 3, indexed: 0, pending: 2 },
  ]);
});

test("only one folder per main role is protected; its duplicate is an ordinary folder", () => {
  // @shyoh's workspace, 2026-10-14: an agent made `projects` beside `Projects`.
  const root = ["Projects", "projects", "Areas", "Resources", "Archive", "website"];
  assert.equal(isProtectedFolder("Projects", root), true);
  assert.equal(isProtectedFolder("projects", root), false);
  assert.equal(isProtectedFolder("projects/", root), false);
  // A numbered pair: the one rolesIn files into stays protected.
  assert.equal(isProtectedFolder("4-archive", ["4-archive", "9-archive"]), true);
  assert.equal(isProtectedFolder("9-archive", ["4-archive", "9-archive"]), false);
  // Alone, it is protected whether or not the caller passed its own name.
  assert.equal(isProtectedFolder("projects", ["Areas"]), true);
  assert.equal(isProtectedFolder("projects", []), true);
  // Never a folder without a main role, or one below the root.
  assert.equal(isProtectedFolder("clients", ["clients", "Clients"]), false);
  assert.equal(isProtectedFolder("Projects/projects", root), false);
});

test("a new name may not twin a sibling by case, nor a root folder's role", () => {
  assert.equal(siblingTwin("projects", ["Projects", "Areas"]), "Projects");
  assert.equal(siblingTwin("Pay.md", ["pay.md"]), "pay.md");
  assert.equal(siblingTwin("café", ["Cafe\u0301"]), "Cafe\u0301");
  assert.equal(siblingTwin("projects", ["Projects"], { topLevelFolder: true }), "Projects");
  assert.equal(siblingTwin("1-projects", ["Projects"], { topLevelFolder: true }), "Projects");
  assert.equal(siblingTwin("1-projects", ["Projects"]), null, "below the root a number is just a name");
  assert.equal(siblingTwin("Projects", ["Projects"]), null, "the name itself is not its twin");
  assert.equal(siblingTwin("project-x", ["Project-Y", "projects"]), null);
});

test("a new name may not twin a sibling it only looks like: another dash, an invisible character", () => {
  // Two rows reading "kings-1" in one folder (2026-10-14): most likely a
  // non-breaking hyphen beside an ASCII one. Every character is escaped so a
  // reviewer can see which one is meant.
  assert.equal(siblingTwin("kings\u20111.md", ["kings-1.md"]), "kings-1.md", "non-breaking hyphen");
  assert.equal(siblingTwin("kings\u20131.md", ["kings-1.md"]), "kings-1.md", "en dash");
  assert.equal(siblingTwin("kings-1.md", ["kings\u22121.md"]), "kings\u22121.md", "minus sign");
  assert.equal(siblingTwin("kings-1\u200b.md", ["kings-1.md"]), "kings-1.md", "zero-width space");
  assert.equal(siblingTwin("\u2068kings-1\u2069.md", ["kings-1.md"]), "kings-1.md", "display isolates");
  assert.equal(siblingTwin("\uff4b\uff49\uff4e\uff47\uff53-1.md", ["kings-1.md"]), "kings-1.md", "fullwidth letters");
  assert.equal(siblingTwin("kings-1.md", ["kings-10.md", "kings 1.md", "kings_1.md"]), null, "a different name is not a twin");
});

// Folder jobs on rows (owner, 2026-10-18): a built-in folder keeps its job
// through a rename or a move, and a writer naming the default name lands in it.
const row = (path, role) => ({ path, name: path.split("/").at(-1), top: !path.includes("/"), ...(role ? { role } : {}) });

test("a row's own job wins wherever the folder now is", () => {
  const answer = folderJobs([row("Capture", "inbox"), row("Work"), row("Work/Big plans", "projects"), row("2-areas"), row("Archive")]);
  assert.equal(answer.jobs.inbox, "Capture");
  assert.equal(answer.jobs.projects, "Work/Big plans");
  assert.equal(answer.jobs.areas, "2-areas", "an unclaimed job falls to its root name");
  assert.equal(answer.jobs.archive, "Archive");
  assert.equal(answer.jobs.resources, null);
  assert.equal(jobAt(answer, "Work/Big plans"), "projects");
  assert.equal(jobAt(answer, "Work"), null);
});

test("a folder named for a job another row claims does not take it", () => {
  // `Projects` at the root was made after the real Projects moved under Work.
  const answer = folderJobs([row("Projects"), row("Work/Projects", "projects")]);
  assert.equal(answer.jobs.projects, "Work/Projects");
});

test("the website job is the website folder until a row says otherwise", () => {
  assert.equal(folderJobs([row("website")]).jobs.website, "website");
  assert.equal(folderJobs([row("Site", "website"), row("website")]).jobs.website, "Site");
});

test("a default name is carried to the folder doing that job now", () => {
  const answer = folderJobs([row("Capture", "inbox"), row("1-projects"), row("Old stuff", "archive")]);
  assert.equal(jobPath(answer, "0-inbox/memories/a.md"), "Capture/memories/a.md");
  assert.equal(jobPath(answer, "inbox/email"), "Capture/email");
  assert.equal(jobPath(answer, "0-inbox"), "Capture");
  assert.equal(jobPath(answer, "4-archive/0-inbox/contacts/x.md"), "Old stuff/0-inbox/contacts/x.md", "only the first segment");
  assert.equal(jobPath(answer, "1-projects/a.md"), "1-projects/a.md", "the folder that has the name is the folder");
  assert.equal(jobPath(answer, "Capture/a.md"), "Capture/a.md");
  assert.equal(jobPath(answer, "recipes/a.md"), "recipes/a.md");
  assert.equal(jobPath(answer, "2-areas/a.md"), "2-areas/a.md", "no folder does the job: as given");
  assert.equal(jobPath(null, "0-inbox/a.md"), "0-inbox/a.md");
});

test("a real root folder with a job's name wins over the rule", () => {
  // A legacy twin: `inbox` beside the renamed Inbox, made before the twin guard.
  const answer = folderJobs([row("Capture", "inbox"), row("inbox")]);
  assert.equal(jobPath(answer, "inbox/a.md"), "inbox/a.md");
  assert.equal(jobPath(answer, "0-inbox/a.md"), "Capture/a.md");
});

test("listing order: a row's order first, then its job, then own folders, archive last", () => {
  const sorted = (parent, entries) => [...entries].sort((a, b) => compareListingEntries(parent, a, b)).map((e) => e.name);
  const f = (name, extra = {}) => ({ kind: "folder", name, ...extra });
  assert.deepEqual(
    sorted("", [f("Old stuff", { role: "archive" }), f("Recipes"), f("Capture", { role: "inbox" }), f("Library", { role: "resources" }), f("website")]),
    ["Capture", "Library", "website", "Recipes", "Old stuff"],
  );
  assert.deepEqual(
    sorted("", [f("Capture", { role: "inbox", order: 20 }), f("Recipes", { order: 0 }), f("1-projects", { order: 10 })]),
    ["Recipes", "1-projects", "Capture"],
  );
  // Below the root, folders are by name, a job folder moved there first.
  assert.deepEqual(sorted("Work", [f("b"), f("Projects", { role: "projects" }), f("a")]), ["Projects", "a", "b"]);
  assert.deepEqual(sorted("Work", [f("b", { order: 0 }), f("a", { order: 10 })]), ["b", "a"]);
  // Files stay after folders, by name.
  assert.deepEqual(sorted("", [{ kind: "file", name: "a.md" }, f("Recipes")]), ["Recipes", "a.md"]);
});
