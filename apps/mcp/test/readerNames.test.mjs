/**
 * EVERY NOTE TOOL JUDGES A PATH WITH THE NAMES OF THE PERSON READING (the owner, 2026-11-03;
 * docs/decisions/privacy-and-sharing/ai-connection-names.md).
 *
 * The control plane gives an AI connection the person's names (groups, handle, row tokens), and the session holds
 * them (`session.js` `grantedGroupsOf`). Until this, no note tool passed them on: `list_notes`, `read_note` and the
 * rest called `canSee` with the rules alone, so a note shared to the person by name, a note pointed at their group,
 * and a Tex group chat's sealed home all listed and read as missing to every AI connection. The store a session opens
 * now carries the names on the rules it serves (`privacyAuthority.js`, `engine.js` `READER_NAMES`), and `canSee` uses
 * them only when its caller leaves the names out.
 *
 * ## Sabotage record
 *
 *   `parsedRules` not tagging the rules → "a chat's sealed home lists and reads for a person named on it" and
 *     "a note shared by name, and one pointed at the person's group, open at team" fail
 *   `canSee` taking the tag when `undefined` is passed (`grantedGroups ?? readerNamesOf(rules)`) → "names passed
 *     as undefined or null are never the reader's" fails
 *   `sessionStore.js` not passing `{ names: session.grantedGroups }` → "the store a session opens serves its rules
 *     with that session's names" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool } from "../src/tools/dispatch.js";
import { canSee, PrivacyOverrides, readerNamesOf } from "../src/privacy/engine.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const HOME = "tex/groups/orbit-lamp-river";
const HOME_TOKEN = "@#00000000-0000-7000-8000-0000000000a1";
const SHARED_TOKEN = "@#00000000-0000-7000-8000-0000000000b2";
const SECRET = "projects/secret.md";

const RULES = {
  etag: "rows-v1",
  accessVersion: 1,
  folders: [
    { prefix: "tex/groups", visibility: "@#sealed-chats" },
    { prefix: HOME, visibility: HOME_TOKEN },
    { prefix: "projects", visibility: "private" },
    { prefix: "crew", visibility: "@leads" },
  ],
  notes: [{ path: "projects/shared.md", visibility: SHARED_TOKEN }],
};

async function storeFor(names) {
  const raw = createMemoryStore();
  for (const key of [`${HOME}/about.md`, `${HOME}/voice.md`, SECRET, "projects/shared.md", "crew/plan.md"]) {
    await raw.put(key, `# ${key}\n`);
  }
  return withPrivacyAuthority(withServedTree(raw), { rules: RULES }, names === undefined ? {} : { names });
}

const text = (result) => result.content.map((part) => part.text).join("");

test("a chat's sealed home lists and reads for a person named on it, and for nobody else, an owner included", async () => {
  const named = await storeFor(new Set([HOME_TOKEN]));
  const listed = text(await callTool("list_notes", { prefix: "tex/groups/" }, named, "private"));
  assert.match(listed, /orbit-lamp-river\/about\.md/);
  assert.match(listed, /orbit-lamp-river\/voice\.md/);
  const read = await callTool("read_note", { path: `${HOME}/about.md` }, named, "private");
  assert.notEqual(read.isError, true, text(read));
  assert.match(text(read), /about\.md/);

  for (const names of [undefined, new Set(), new Set(["@leads"])]) {
    const owner = await storeFor(names);
    assert.equal(text(await callTool("list_notes", { prefix: "tex/groups/" }, owner, "private")), "(no visible notes under that prefix)");
    assert.equal((await callTool("read_note", { path: `${HOME}/about.md` }, owner, "private")).isError, true);
  }
});

test("a note shared by name, and one pointed at the person's group, open at team; a private note does not", async () => {
  const member = await storeFor(new Set([SHARED_TOKEN, "@leads"]));
  const listed = text(await callTool("list_notes", { prefix: "" }, member, "team"));
  assert.match(listed, /projects\/shared\.md/);
  assert.match(listed, /crew\/plan\.md/);
  assert.doesNotMatch(listed, /secret\.md/);
  assert.doesNotMatch(listed, /orbit-lamp-river/);

  const without = await storeFor(new Set());
  const bare = text(await callTool("list_notes", { prefix: "" }, without, "team"));
  assert.doesNotMatch(bare, /shared\.md|plan\.md|secret\.md/);
});

test("names passed as undefined or null are never the reader's: a check about somebody else stays theirs", async () => {
  const store = await storeFor(new Set([HOME_TOKEN, "@leads"]));
  const { rules, overrides } = await loadPrivacyState(store);
  assert.ok(readerNamesOf(rules)?.has(HOME_TOKEN), "the served rules carry the reader's names");
  assert.equal(canSee("crew/plan.md", "team", rules, overrides), true, "left out: the reader's");
  // A recipient with no names (`live/relayAuthorization.js`), and the members at large (`moves/keyedCollaboration.js`).
  assert.equal(canSee("crew/plan.md", "team", rules, overrides, undefined), false);
  assert.equal(canSee("crew/plan.md", "team", rules, overrides, null), false);
  assert.equal(canSee(`${HOME}/about.md`, "private", rules, overrides, new Set()), false);
  // Untagged rules, as every caller that builds its own has, judge with none.
  const plain = RULES.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility }));
  assert.equal(canSee("crew/plan.md", "team", plain, new PrivacyOverrides()), false);
});

test("the store a session opens serves its rules with that session's names, and none to a session without", async () => {
  const { storeForSession } = await import("../src/sessionStore.js");
  const bucket = { get: async () => null, head: async () => null, put: async () => ({}), delete: async () => {}, list: async () => ({ objects: [], truncated: false }) };
  const env = { NATIVE_BINDINGS: "BUCKET", BUCKET: bucket };
  const binding = { provider: "r2-binding", bindingName: "BUCKET", workspaceId: "w1", conditionalWrite: true, conditionalCreate: true, status: "active" };
  const controlPlane = { getStorageBinding: async () => ({ binding }), privacyAuthority: () => ({ rules: RULES }) };
  const namesOf = async (session) => readerNamesOf((await loadPrivacyState(await storeForSession(session, env, controlPlane))).rules);
  const names = new Set([HOME_TOKEN]);
  assert.equal(await namesOf({ workspaceId: "w1", accessToken: "tok", scope: "private", grantedGroups: names }), names);
  assert.equal(await namesOf({ workspaceId: "w1", accessToken: "tok", scope: "private" }), undefined);
});
