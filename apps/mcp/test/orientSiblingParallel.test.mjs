// `orient` reads each other workspace's front page beside its map (src/orient/workspaces.js): the two used to run
// one after the other, each a round trip to that workspace's object.
import { test } from "node:test";
import assert from "node:assert/strict";

import { surveyOtherContexts } from "../src/orient/workspaces.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";

const ROWS = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "index.md", visibility: "team" }, { prefix: "1-projects", visibility: "team" }], notes: [] };

/** A workspace whose `index.md` answers only once its map has been asked for: run in turn, the two never finish. */
function gatedWorkspace(files, { indexVisible = true } = {}) {
  let mapAsked;
  const asked = new Promise((resolve) => (mapAsked = resolve));
  const keys = Object.keys(files).sort();
  return {
    get: async (key) => {
      if (key === "index.md") await asked;
      return key in files ? { etag: `e-${key}`, text: async () => files[key] } : null;
    },
    treeManifest: async ({ folder } = {}) => {
      mapAsked();
      return {
        served: true,
        entries: keys.filter((k) => folder === undefined || k.startsWith(`${folder}/`)).map((path) => ({ path, etag: `e-${path}`, updatedAt: 1 })),
        cursor: null,
      };
    },
    treeEntries: async () => keys.map((key) => ({ key, uploaded: new Date(1) })),
  };
}

const store = { contexts: [{ name: "@here", current: true }, { name: "@one", role: "member", canWrite: true, grantWrites: true, tier: "team" }] };

// Sabotage: await `readFrontPage` before starting `surveyOf` and the block is "Map not loaded in time".
test("another workspace's front page and map are read together", async () => {
  const files = { "index.md": "# One\n\nA paragraph of One.\n", "1-projects/a.md": "# a\n" };
  const openContext = async () => ({ session: { scope: "team", workspaceId: "ws_one" }, store: withPrivacyAuthority(gatedWorkspace(files), { rules: ROWS }) });
  const { section } = await surveyOtherContexts(store, openContext);
  assert.match(section, /A paragraph of One\./);
  assert.match(section, /1-projects/);
});

// Sabotage: drop the `canSee` check in `readFrontPage` and the private front page's text appears.
test("a front page the caller may not see is read early but never shown", async () => {
  const hidden = { ...ROWS, folders: [{ prefix: "1-projects", visibility: "team" }] };
  const files = { "index.md": "# One\n\nSecret paragraph.\n", "1-projects/a.md": "# a\n" };
  const openContext = async () => ({ session: { scope: "team", workspaceId: "ws_one" }, store: withPrivacyAuthority(gatedWorkspace(files), { rules: hidden }) });
  const { section } = await surveyOtherContexts(store, openContext);
  assert.doesNotMatch(section, /Secret paragraph/);
  assert.match(section, /No front page here yet\./);
});
