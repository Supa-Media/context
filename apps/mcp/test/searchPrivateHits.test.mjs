/**
 * A group chat's search says which hits are private notes (`tools/search.js` `PRIVATE_HIT_LABEL`,
 * `search/config/nodes.js` `markPrivate`; Dev2, 2026-11-28), so the Room check keeps a private note out of the group
 * unless its asker names it (`packages/tex/gateway/agent/roomCheck.js`). Every other client sees the hits as before.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-28):
 *   `toolSearchNotes`'s `markPrivate` ignored → "a group's search marks a private hit" fails.
 *   `session.js`'s group-client line removed  → "a group's search marks a private hit" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PRIVATE_HIT_LABEL } from "../src/tools/search.js";
import { callToolForSession } from "../src/tools/session.js";
import { TEXTS_GROUP_CLIENT_ID } from "../src/machines/reach.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

function workspaceStore(notes, rules) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort().map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
  };
  return withPrivacyAuthority(withServedTree(store), { rules });
}

const NOTES = {
  "projects/kiln-plans.md": "# Kiln plans\n\nThinking of moving the kiln firing to Sunday.\n",
  "shared/kiln-firing.md": "# Kiln firing\n\nThe kiln firing rota is on the board.\n",
};
const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "shared", visibility: "team" }], notes: [] };
const search = (clientId) => callToolForSession({ name: "search_notes", arguments: { query: "kiln firing" } }, workspaceStore(NOTES, RULES), { scope: "private", workspaceId: "ws-own", actorClientId: clientId });
const text = (result) => result.content.map((part) => part.text).join("\n");
const hitBlock = (words, key) => words.split("\n\n").find((block) => block.startsWith(key)) ?? "";

test("a group's search marks a private hit, and not a team one", async () => {
  const words = text(await search(TEXTS_GROUP_CLIENT_ID));
  assert.match(hitBlock(words, "projects/kiln-plans.md"), new RegExp(`\\(${PRIVATE_HIT_LABEL}\\)`), words);
  assert.doesNotMatch(hitBlock(words, "shared/kiln-firing.md"), new RegExp(PRIVATE_HIT_LABEL), words);
});

test("any other client's search is unmarked", async () => {
  const words = text(await search("some-client"));
  assert.ok(words.includes("projects/kiln-plans.md"), words);
  assert.doesNotMatch(words, new RegExp(PRIVATE_HIT_LABEL));
});
