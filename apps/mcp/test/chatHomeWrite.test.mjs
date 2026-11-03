/**
 * A CHAT'S HOME IS WRITTEN WITHOUT SETTING A ROW'S ACCESS (2026-11-02).
 *
 * Under the seal (`docs/decisions/texting-assistant/chat-homes.md`) the control plane refuses every access change a
 * chat's grant asks for (`sealedChange`, `apps/convex/functions/lib/nodes/sealedChats.ts`): the seal is the access.
 * A home's session is `team` (an editor's), so `write_note` asked to set each new note's row to `team` after the
 * text was in; the refusal threw, and no chat's history page was ever reported written (`rowswriterefused`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";
import { markChatHome } from "../src/agent/chatHomeSeal.js";

const HOME = "tex/groups/orbit-lamp-river";
const FOLDERS = [{ prefix: "tex", vis: "team" }, { prefix: "notes", vis: "team" }];

function homeStore() {
  const asked = [];
  const sealed = (path) => path === "tex/groups" || path.startsWith("tex/groups/");
  const store = withPrivacyAuthority(withServedTree(createMemoryStore()), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: FOLDERS.map(({ prefix }) => ({ prefix, visibility: "team" })), notes: [] },
    async setAccess(change) {
      asked.push(change);
      return sealed(change.path) ? { ok: false, code: "FORBIDDEN" } : { ok: true, version: 2 };
    },
  });
  markChatHome(store, HOME);
  return { store, asked };
}

test("a new note in a chat's home is written, and no row's access is asked to change", async () => {
  const { store, asked } = homeStore();
  const result = await toolWriteNote(store, "team", FOLDERS, new PrivacyOverrides(), { path: `${HOME}/history.md`, content: "# History\n" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.deepEqual(asked, [], "the seal is the access: nothing to set");
  assert.equal(await (await store.get(`${HOME}/history.md`)).text(), "# History\n");
});

test("a note outside the home on the same kind of store is written as before, its folder giving it team", async () => {
  const { store, asked } = homeStore();
  markChatHome(store, "tex/groups/another-chat");
  const result = await toolWriteNote(store, "team", FOLDERS, new PrivacyOverrides(), { path: "notes/plain.md", content: "# Plain\n" });
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  assert.equal(await (await store.get("notes/plain.md")).text(), "# Plain\n");
  // `notes/` already gives it `team`: since 2026-11-03 that is no row write at all (`rowAccess.inherits`), where it
  // was an `inherit` the control plane answered and changed nothing with.
  assert.deepEqual(asked, []);
});

test("a note in a chat's home can't be asked to be private, and nothing is written", async () => {
  const { store, asked } = homeStore();
  const result = await toolWriteNote(store, "team", FOLDERS, new PrivacyOverrides(), { path: `${HOME}/secret.md`, content: "# Secret\n", visibility: "private" });
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /can't be made private/);
  assert.deepEqual(asked, []);
  assert.equal(await store.get(`${HOME}/secret.md`), null);
});
