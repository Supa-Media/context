/**
 * The connect-time sketch names the top level from the Convex tree
 * (`mcp/sessionInstructions.js`, `tree/served.js`). A workspace keeps its
 * notes under their ids, so the bucket's root is `notes/` and `files/`: a
 * sketch listed from the bucket would tell every client those are the
 * person's folders.
 *
 * Sabotage-checked: listing the raw store in `instructionsForSession` names
 * `notes/` and misses the real folders.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { R2Store } from "../src/store/r2.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { instructionsForSession } from "../src/mcp/sessionInstructions.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";

test("the connect sketch names the tree's folders, never the bucket's id keys", async () => {
  const raw = memoryBucket();
  await raw.put("notes/0190a000-0000-7000-8000-000000000001.md", "# Plan\n");
  await raw.put("files/0190a000-0000-7000-8000-000000000002.png", "png");
  const listed = [];
  const list = raw.list.bind(raw);
  raw.list = async (options = {}) => {
    const prefix = options.prefix ?? "";
    if (!prefix.startsWith(".")) listed.push(prefix);
    return list(options);
  };
  // The access rows, as the control plane sends them with a session.
  const rules = { etag: "rows-1", accessVersion: 1, folders: [{ prefix: "projects", visibility: "team" }], notes: [] };
  const store = Object.create(withPrivacyAuthority(new R2Store(raw), { rules }));
  Object.defineProperty(store, "treeManifest", {
    value: async () => ({
      served: true,
      entries: [{ path: "projects/launch/plan.md" }, { path: "todo.md" }],
      cursor: null,
    }),
    enumerable: false,
  });

  const text = await instructionsForSession(store, { scope: "private" });

  assert.match(text, /Top level: projects\/, todo\.md/);
  assert.doesNotMatch(text, /notes\//);
  assert.doesNotMatch(text, /files\//);
  assert.deepEqual(listed, [], "no note listing of the bucket");
});
