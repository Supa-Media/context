/**
 * A NEW NOTE IN A SHARED WORKSPACE TAKES ITS FOLDER'S DEFAULT (owner, 2026-11-17; `src/tools/notes/write.js`
 * `folderDefault`; `docs/decisions/privacy-and-sharing/shared-folder-default.md`).
 *
 * A personal connection's new note with no visibility asked for was private everywhere, so a project Tex made in a
 * shared workspace's team folder came out private. Now, in a shared workspace only, it gets the folder's team tier,
 * with no confirmation asked (the folder already publishes to its members). A personal workspace, a private folder,
 * an explicit visibility and an existing note are all unchanged.
 *
 * Sabotage: set `folderDefault` to `false` and the shared-workspace tests fail (the note comes back private, or the
 * write asks for confirm_team_publish); drop the `workspaceKind === "shared"` test and the personal one fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [
  { prefix: "projects", vis: "team" },
  { prefix: "drafts", vis: "private" },
];

function harness(workspaceKind) {
  const asked = [];
  const store = withPrivacyAuthority(withServedTree(createMemoryStore()), {
    rules: {
      etag: "rows-v1",
      accessVersion: 1,
      folders: [
        { prefix: "projects", visibility: "team" },
        { prefix: "drafts", visibility: "private" },
      ],
      notes: [],
    },
    async setAccess(change) {
      asked.push(change);
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind, role: "owner" };
  return { store, asked };
}

const save = (store, args) => toolWriteNote(store, "private", RULES, new PrivacyOverrides(), args);
const visibilityLine = (result) => /visibility: (\w+)/.exec(result?.content?.[0]?.text ?? "")?.[1];

test("a new note in a shared workspace's team folder is team, with no confirmation asked", async () => {
  const { store, asked } = harness("shared");
  const result = await save(store, { path: "projects/servant/overview.md", content: "# Overview\n" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(visibilityLine(result), "team");
  assert.equal(asked.some((call) => call.base === "private"), false, "it was pinned private");
});

test("a new note in a shared workspace's private folder stays private", async () => {
  const { store } = harness("shared");
  const result = await save(store, { path: "drafts/idea.md", content: "# Idea\n" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(visibilityLine(result), "private");
});

test("an explicit private in a shared team folder is kept", async () => {
  const { store, asked } = harness("shared");
  const result = await save(store, { path: "projects/secret.md", content: "# Secret\n", visibility: "private" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(visibilityLine(result), "private");
  assert.deepEqual(asked.map((call) => [call.path, call.base]), [["projects/secret.md", "private"]]);
});

test("a personal workspace keeps the private default in a team folder", async () => {
  const { store } = harness("personal");
  const result = await save(store, { path: "projects/mine.md", content: "# Mine\n" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(visibilityLine(result), "private");
});
