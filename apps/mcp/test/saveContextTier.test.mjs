/**
 * A saved session names its tier on the put, as `write_note` does (2026-11-03), so a workspace whose notes live in its
 * object adopts the new note there (`store/objectLookup.js` adopt) rather than sending every session save to the
 * control plane (`cp:/gateway/note-ids/adopt`, about 1.4 s in production). An adopt without a tier is the control
 * plane's by construction.
 *
 * Sabotage: the `tier` dropped from `saveContext.js`'s put → both tests fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolSaveContext } from "../src/tools/saveContext.js";

function recordingStore() {
  const puts = [];
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    rowAccess: { setTier: async () => ({ ok: true }), addPeople: async () => ({ ok: true }) },
    get: async () => null,
    head: async () => null,
    exists: async () => false,
    existsMetadata: async () => false,
    list: async () => ({ objects: [], truncated: false }),
    treeManifest: async () => ({ served: true, entries: [], cursor: null }),
    treeFacts: async () => ({ served: true, files: [], folders: [] }),
    put: async (key, body, options) => {
      puts.push({ key, options });
      return { etag: `e-${puts.length}` };
    },
    delete: async () => undefined,
  };
  return { store, puts };
}

for (const visibility of ["private", "team"]) {
  test(`a ${visibility} session save names its tier on the put`, async () => {
    const { store, puts } = recordingStore();
    const rules = [{ prefix: "inbox", vis: "team" }];
    const result = await toolSaveContext(store, "private", rules, undefined, {
      platform: "claude",
      content: "What mattered.",
      completeness: "summary",
      visibility,
      ...(visibility === "team" ? { confirm_team_publish: true } : {}),
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const saved = puts.find((put) => put.options?.onlyIf?.absent === true);
    assert.ok(saved, JSON.stringify(puts));
    assert.equal(saved.options.tier, visibility);
  });
}
