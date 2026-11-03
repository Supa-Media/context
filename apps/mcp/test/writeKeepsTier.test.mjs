/**
 * SAVING AN EXISTING NOTE KEEPS ITS TIER UNLESS THE SAVE ASKS FOR ONE (`src/tools/notes/write.js`, `tierKept`).
 *
 * A save with no `visibility` and no `share` used to re-pin the note's own tier from the request's rules: a control-
 * plane round trip on every save (a median 2.1 s, 2026-11-02), and a possible undo of another person's change made
 * since the note was read. Now an existing note saved that way makes no row-tier write (`store.rowAccess.setTier`,
 * which calls the authority's `setAccess`). The tier is still set when the save asks for one: an explicit
 * `visibility`, or a `share` that publishes a private note to the team.
 *
 * Sabotage: change `const tierKept = exists && ...` to `const tierKept = false;` and the no-op tests fail, because
 * the existing team note and the existing private note are each re-pinned on save.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

// The workspace's folder rule is `team`, so a note under `notes/` inherits team unless it has its own row.
const FOLDER = { prefix: "notes", visibility: "team" };
const FOLDER_RULE = { prefix: "notes", vis: "team" };
const PRIVATE_NOTE = "notes/private.md";
const TEAM_NOTE = "notes/team.md";

/**
 * A rows-mode store: the tree and notes live in the memory store, and every row's tier is recorded as `setAccess`.
 * `held` is the rules the control plane renders for this reader, so a row's own private override is part of it.
 */
function harness() {
  const asked = [];
  const store = withPrivacyAuthority(withServedTree(createMemoryStore()), {
    rules: {
      etag: "rows-v1",
      accessVersion: 1,
      folders: [FOLDER],
      notes: [{ path: PRIVATE_NOTE, visibility: "private" }],
    },
    async setAccess(change) {
      asked.push(change);
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  const overrides = new PrivacyOverrides();
  overrides.set(PRIVATE_NOTE, "private");
  return { store, asked, overrides };
}

/** Seeds a note straight into the bucket, and returns the etag a caller would have read. */
async function seed(store, path, text) {
  await store.put(path, text);
  return (await store.get(path)).etag;
}

async function save(store, overrides, args, scope = "private") {
  return toolWriteNote(store, scope, [FOLDER_RULE], overrides, args);
}

test("creating a new note sets its tier", async () => {
  const { store, asked, overrides } = harness();
  const result = await save(store, overrides, { path: "notes/new.md", content: "# New\n", visibility: "private" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(
    asked.map((call) => [call.path, call.base]),
    [["notes/new.md", "private"]],
    "a new note's tier is one row write",
  );
});

test("an existing note saved with explicit visibility keeps that visibility, and sets the row", async () => {
  const { store, asked, overrides } = harness();
  const etag = await seed(store, TEAM_NOTE, "# Team\n");
  const result = await save(store, overrides, {
    path: TEAM_NOTE,
    content: "# Team\n\nedited\n",
    expected_etag: etag,
    visibility: "private",
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(
    asked.map((call) => [call.path, call.base]),
    [[TEAM_NOTE, "private"]],
    "an explicit private on an existing note is still written",
  );
});

test("an existing private note saved with explicit team visibility sets the row to team", async () => {
  const { store, asked, overrides } = harness();
  const etag = await seed(store, PRIVATE_NOTE, "# Private\n");
  const result = await save(store, overrides, {
    path: PRIVATE_NOTE,
    content: "# Private\n\nedited\n",
    expected_etag: etag,
    visibility: "team",
    confirm_team_publish: true,
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  // Team is what the folder gives this note, so the row is written as `inherit` (a row with no tier of its own).
  assert.deepEqual(
    asked.map((call) => [call.path, call.base]),
    [[PRIVATE_NOTE, "inherit"]],
    "an explicit team on an existing private note is still written",
  );
});

test("an existing private note saved with share is published to team", async () => {
  const { store, asked, overrides } = harness();
  const etag = await seed(store, PRIVATE_NOTE, "# Private\n");
  const result = await save(store, overrides, {
    path: PRIVATE_NOTE,
    content: "# Private\n\nshared\n",
    expected_etag: etag,
    share: "anyone",
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(
    asked.map((call) => [call.path, call.base]),
    [[PRIVATE_NOTE, "inherit"]],
    "a link over a private note sets the row to team",
  );
});

test("NO-OP: an existing team note saved with no visibility and no share makes no row write", async () => {
  const { store, asked, overrides } = harness();
  const etag = await seed(store, TEAM_NOTE, "# Team\n");
  const result = await save(store, overrides, {
    path: TEAM_NOTE,
    content: "# Team\n\nsaved again\n",
    expected_etag: etag,
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(asked, [], "the tier is kept: no setAccess");
  assert.equal(await (await store.get(TEAM_NOTE)).text(), "# Team\n\nsaved again\n", "the content is still written");
});

test("NO-OP: an existing private note saved with no visibility and no share makes no row write", async () => {
  const { store, asked, overrides } = harness();
  const etag = await seed(store, PRIVATE_NOTE, "# Private\n");
  const result = await save(store, overrides, {
    path: PRIVATE_NOTE,
    content: "# Private\n\nsaved again\n",
    expected_etag: etag,
  });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(asked, [], "the private tier is kept: no setAccess");
  assert.equal(await (await store.get(PRIVATE_NOTE)).text(), "# Private\n\nsaved again\n");
});
