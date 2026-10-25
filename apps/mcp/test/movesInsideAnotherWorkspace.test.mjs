/**
 * A MOVE INSIDE ANOTHER WORKSPACE IS A RELOCATION THERE (owner, 2026-10-25).
 *
 * On 2026-10-24 Tex was asked to "merge all the efforts into 1 coherent
 * project folder" in the owner's shared workspace @supa. Every `move_note`
 * and `move_notes` it sent with `context: "@supa"` was summed up for the
 * sharing judge as "move … into @supa", the judge read that as sharing, and
 * nothing moved. Both ends of such a call are inside @supa, and a move keeps
 * each note's visibility, so it is an ordinary write there (`elsewhereOnly`,
 * never judged), unless that workspace's own manifest reads the destination
 * wider, or the call asks to publish.
 *
 * ## Sabotage record
 *
 *   `anyWidens` answering false for every move
 *     → "a folder moved to where more people read it there is still judged" fails
 *   `anyWidens` measuring a note by its new folder alone (no `narrowerVisibility`)
 *     → "a private note moved into a team folder there lands private" fails
 *   the `elsewhere && !published` shortcut removed from `move_note`
 *     → "a note moved inside another workspace is an ordinary write there" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { wideningOf } from "../src/privacy/widening.js";

// @supa's own manifest: private by default, `projects/` open to its team.
const privacy = async () => ({
  rules: [
    { prefix: "", vis: "private" },
    { prefix: "projects", vis: "team" },
  ],
  overrides: new Map(),
});
const into = "@supa";
const options = { into, privacy, writes: true };

test("a note moved inside another workspace is an ordinary write there, never judged", async () => {
  const widening = await wideningOf(
    "move_note",
    { source: "projects/backlog/inbox/google-approval/casa.md", destination: "projects/google-oauth/casa/casa.md" },
    options,
  );
  assert.equal(widening?.elsewhereOnly, true);
});

test("a batch moved inside another workspace is an ordinary write there", async () => {
  const widening = await wideningOf(
    "move_notes",
    {
      moves: [
        { source: "projects/a/one.md", destination: "projects/b/one.md" },
        { source: "notes/private.md", destination: "archive/private.md" },
      ],
    },
    options,
  );
  assert.equal(widening?.elsewhereOnly, true);
});

test("a folder moved inside another workspace is an ordinary write there", async () => {
  const widening = await wideningOf("move_folder", { source: "projects/a", destination: "projects/b/a" }, options);
  assert.equal(widening?.elsewhereOnly, true);
});

test("a private note moved into a team folder there lands private, so it is not judged (2026-10-25, second refusal)", async () => {
  // The @supa case: the note held back by an exact override, its new folder open to the team.
  const held = async () => ({
    rules: [
      { prefix: "", vis: "private" },
      { prefix: "projects", vis: "team" },
    ],
    overrides: new Map([["projects/backlog/inbox/google-approval/casa.md", "private"]]),
  });
  const one = await wideningOf(
    "move_note",
    { source: "projects/backlog/inbox/google-approval/casa.md", destination: "projects/google-oauth/casa/casa.md" },
    { into, privacy: held, writes: true },
  );
  assert.equal(one?.elsewhereOnly, true);
  const batch = await wideningOf(
    "move_notes",
    { moves: [{ source: "notes/p.md", destination: "projects/p.md" }, { source: "projects/a/one.md", destination: "projects/b/one.md" }] },
    options,
  );
  assert.equal(batch?.elsewhereOnly, true);
});

test("a folder moved to where more people read it there is still judged", async () => {
  const folder = await wideningOf("move_folder", { source: "notes/drafts", destination: "projects/drafts" }, options);
  assert.notEqual(folder?.elsewhereOnly, true);
  assert.match(folder?.summary ?? "", /into @supa/);
});

test("a move asked to publish, or between two workspaces, is still judged", async () => {
  const published = await wideningOf(
    "move_note",
    { source: "projects/a/one.md", destination: "projects/b/one.md", confirm_team_publish: true },
    options,
  );
  assert.notEqual(published?.elsewhereOnly, true);
  assert.match(published?.summary ?? "", /published to its team/);
  const across = await wideningOf(
    "move_note",
    { source: "projects/a/one.md", destination: "projects/b/one.md", destination_context: "@band" },
    options,
  );
  assert.notEqual(across?.elsewhereOnly, true);
});

test("at home, a move that publishes nothing is still no widening at all", async () => {
  const home = await wideningOf("move_note", { source: "projects/a/one.md", destination: "projects/b/one.md" }, { privacy });
  assert.equal(home, null);
});
