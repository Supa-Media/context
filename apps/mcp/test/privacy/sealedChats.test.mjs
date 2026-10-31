/**
 * GROUP TEX'S CHAT HOMES ARE SEALED IN THE GATEWAY TOO (owner, 2026-10-31;
 * docs/decisions/texting-assistant/chat-homes.md).
 *
 * The control plane renders `@context-lc`'s `tex/groups` folder as the sealed rule (`SEALED`) and every home beneath
 * it as the token of the people named on it. These pin the gateway's half:
 *
 *  - `canSee` answers a sealed path by name before scope: an owner's `private` scope opens nothing under it;
 *  - the home's own token opens it, and `team`, `private` or a stray rule beneath it opens it to nobody;
 *  - folded spellings of the path stay sealed;
 *  - `list_changes` drops an audit record about a sealed path for an owner.
 *
 * ## Sabotage record
 *
 *   `canSee` answering `private` scope before `sealedCovers` → "an owner's scope opens nothing under the seal" fails
 *   `sealedCovers` comparing unfolded paths → "a folded spelling is sealed as well" fails
 *   the `sealedCovers` skip dropped from `toolListChanges` → "list_changes leaves out a record about a chat" fails
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrivacyOverrides, SEALED, canSee, sealedCovers } from "../../src/privacy/engine.js";
import { toolListChanges } from "../../src/activity/changes.js";
import { recordChange } from "../../src/activity/record.js";
import { createMemoryStore } from "../gmailSync/fixtures.mjs";

const HOME_TOKEN = "@#00000000-0000-7000-8000-0000000000a1";
const RULES = [
  { prefix: "guides", vis: "team" },
  { prefix: "tex/groups", vis: SEALED },
  { prefix: "tex/groups/orbit-lamp", vis: HOME_TOKEN },
  { prefix: "tex/groups/orbit-lamp/open", vis: "team" },
];
const NOTE = "tex/groups/orbit-lamp/transcripts/2026-10-30.md";

test("an owner's scope opens nothing under the seal, and everything else as before", () => {
  const overrides = new PrivacyOverrides();
  assert.equal(canSee(NOTE, "private", RULES, overrides, new Set()), false);
  assert.equal(canSee("tex/groups/orbit-lamp", "private", RULES, overrides, new Set()), false);
  assert.equal(canSee("tex/groups/planted.md", "private", RULES, overrides, new Set()), false);
  assert.equal(canSee("guides/start.md", "private", RULES, overrides, new Set()), true);
  assert.equal(canSee("projects/secret.md", "private", RULES, overrides, undefined), true);
  assert.equal(canSee("tex/notes.md", "private", RULES, overrides, undefined), true);
});

test("the home's token opens it, and nothing a role gives does", () => {
  const overrides = new PrivacyOverrides();
  assert.equal(canSee(NOTE, "team", RULES, overrides, new Set([HOME_TOKEN])), true);
  assert.equal(canSee(NOTE, "private", RULES, overrides, new Set([HOME_TOKEN])), true);
  assert.equal(canSee(NOTE, "team", RULES, overrides, new Set()), false);
  // Nobody holds the sealed rule itself, and a `team` rule beneath the seal is open to nobody.
  assert.equal(canSee("tex/groups/x.md", "team", RULES, overrides, new Set([SEALED])), false);
  assert.equal(canSee("tex/groups/orbit-lamp/open/a.md", "private", RULES, overrides, new Set([HOME_TOKEN])), false);
  // A `team` override on a note beneath the seal is no way in either.
  const opened = new PrivacyOverrides();
  opened.set(NOTE, "team");
  assert.equal(canSee(NOTE, "private", RULES, opened, new Set()), false);
});

test("a folded spelling is sealed as well", () => {
  assert.equal(sealedCovers("Tex/Groups/orbit-lamp/a.md", RULES), true);
  assert.equal(sealedCovers("TEX/GROUPS", RULES), true);
  assert.equal(canSee("Tex/Groups/orbit-lamp/a.md", "private", RULES, new PrivacyOverrides(), new Set()), false);
  assert.equal(sealedCovers("tex/groupsx/a.md", RULES), false);
  assert.equal(sealedCovers("tex", RULES), false);
});

test("list_changes leaves out a record about a chat, for an owner too", async () => {
  const store = createMemoryStore();
  store.actor = { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts_group", client: "Tex" };
  await recordChange(store, "write_note", "team", [NOTE]);
  await recordChange(store, "write_note", "team", ["guides/start.md"]);
  const answer = await toolListChanges(store, "private", RULES, new PrivacyOverrides(), 20);
  const text = answer.content[0].text;
  assert.match(text, /guides\/start\.md/);
  assert.doesNotMatch(text, /orbit-lamp/);
});
