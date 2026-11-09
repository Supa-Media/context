/**
 * A NOTE MADE TEAM-VISIBLE WHERE ITS FOLDER ALREADY READS TEAM IS NOT JUDGED
 * (the owner, 2026-11-09: "if the folder it's in is team view, then don't run
 * the judge"). `wideningOf` marks it `folderDefaultOnly`; every other widening,
 * and a note in a private folder or a private subfolder of a team one, is not.
 *
 * ## Sabotage record
 *
 * Applied, file run, named checks observed failing, reverted (2026-11-09).
 *
 *   `toTeam` reading the note's own visibility instead of its folder's
 *     → "a note held private in a team folder only matches the folder" fails
 *   `folderDefault` true whatever the folder reads
 *     → "a note in a private folder is still judged" and "a private subfolder
 *       of a team folder is still judged" fail
 *   `summed` marking a call folderDefaultOnly when any one facet is
 *     → "naming people, a link or a picture beside it is still judged" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { wideningOf } from "../src/privacy/widening.js";

const rules = [
  { prefix: "", vis: "private" },
  { prefix: "projects", vis: "team" },
  { prefix: "projects/vault", vis: "private" },
];
const overrides = new Map([
  ["projects/plan.md", "private"],
  ["projects/vault/key.md", "private"],
  ["areas/diary.md", "private"],
]);
const privacy = async () => ({ rules, overrides });

test("a note held private in a team folder only matches the folder", async () => {
  const set = await wideningOf("set_visibility", { path: "projects/plan.md", visibility: "team" }, { privacy });
  assert.equal(set?.folderDefaultOnly, true);
  const written = await wideningOf(
    "write_note",
    { path: "projects/plan.md", content: "x", visibility: "team", confirm_team_publish: true },
    { privacy },
  );
  assert.equal(written?.folderDefaultOnly, true);
});

test("a note in a private folder is still judged", async () => {
  const set = await wideningOf("set_visibility", { path: "areas/diary.md", visibility: "team" }, { privacy });
  assert.equal(set?.folderDefaultOnly, false);
});

test("a private subfolder of a team folder is still judged", async () => {
  const set = await wideningOf("set_visibility", { path: "projects/vault/key.md", visibility: "team" }, { privacy });
  assert.equal(set?.folderDefaultOnly, false);
});

test("naming people, a link or a picture beside it is still judged", async () => {
  const named = await wideningOf(
    "set_visibility",
    { path: "projects/plan.md", visibility: "team", people: ["ana@example.com"] },
    { privacy },
  );
  assert.equal(named?.folderDefaultOnly, false);
  const linked = await wideningOf(
    "write_note",
    { path: "projects/plan.md", content: "x", visibility: "team", confirm_team_publish: true, share: "anyone" },
    { privacy },
  );
  assert.equal(linked?.folderDefaultOnly, false);
  const link = await wideningOf("create_link", { path: "projects/plan.md", audience: "members" }, { privacy });
  assert.notEqual(link?.folderDefaultOnly, true);
});

test("a folder made team is still judged", async () => {
  const folder = await wideningOf("set_folder_visibility", { path: "projects/vault", visibility: "team" }, { privacy });
  assert.notEqual(folder?.folderDefaultOnly, true);
});
