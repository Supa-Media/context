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
  topLevelRole,
  isMainFolder,
  compareTopLevelFolders,
  rolesIn,
  missingMainRoles,
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

test("new workspaces sort the same way in any app", () => {
  assert.deepEqual(MAIN_FOLDERS, ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"]);
  const names = Object.values(DEFAULT_FOLDER);
  assert.deepEqual([...names].sort(), [...names].sort(compareTopLevelFolders));
});

test("archive is drawn last even when its number says otherwise", () => {
  const sorted = ["website", "4-archive", "recipes", "5-clients", "3-resources", "0-inbox", "2-areas", "1-projects", "6-teams"].sort(compareTopLevelFolders);
  assert.deepEqual(sorted, ["0-inbox", "1-projects", "2-areas", "3-resources", "5-clients", "6-teams", "recipes", "website", "4-archive"]);
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
});
