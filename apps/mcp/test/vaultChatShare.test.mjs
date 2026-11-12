/**
 * A login saved from a link Tex texted in a group chat (Dev2, 2026-11-12, the
 * Crystal Care chat's Gusto login): the page lets its saver give it to that
 * chat, to the whole workspace, or keep it to themselves, and Tex carries on
 * in the chat once it's saved.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `actorAccessOf` counting any `#chat:` share, not the turn's own chat →
 *     "a login given to one chat is used there and nowhere else".
 *  2. It answering "see" for a chat share → the same test.
 *  3. It counting `createdBy` against the grant's person rather than the
 *     token's own tagger → "only me fills on its saver's own tag, never on
 *     a guest's".
 *  4. `withGroupVault` picking a workspace when the chat reaches several, or
 *     overriding one the model named → "a group's link goes to the one
 *     workspace it reaches".
 *  5. `linkHash` hashing anything but the token as Convex does → "the
 *     watched link is the one texted, hashed as the control plane does".
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { actorAccessOf, chatShareTo, CHAT_SHARE_PREFIX } from "../src/vault/access.js";
import { linkHash, withGroupVault, withVaultWatch } from "../src/agent/vaultSaved.js";

const CHAT = "a".repeat(64);
const OTHER_CHAT = "b".repeat(64);
const SAVER = "user_seyi";
const GROUP = { workspaceId: "ws_crystal", workspaceKind: "shared", userId: SAVER, clientId: "context_texts_group", groupChat: true, groups: [] };

test("a login given to one chat is used there and nowhere else, and never seen", () => {
  assert.equal(chatShareTo(CHAT), `${CHAT_SHARE_PREFIX}${CHAT}`);
  const toChat = { createdBy: "user_ada", people: ["user_ada"], shares: [{ to: chatShareTo(CHAT), level: "use", label: "Group chat with Seyi" }] };
  assert.equal(actorAccessOf(toChat, { ...GROUP, chat: CHAT }), "use");
  assert.equal(actorAccessOf(toChat, { ...GROUP, chat: OTHER_CHAT }), null);
  assert.equal(actorAccessOf(toChat, GROUP), null);
  // Even a "see" level from a chat share is only used.
  assert.equal(actorAccessOf({ ...toChat, shares: [{ to: chatShareTo(CHAT), level: "see" }] }, { ...GROUP, chat: CHAT }), "use");
  // A person's own texts never reach a chat's share through it: it names no person or group.
  assert.equal(actorAccessOf(toChat, { ...GROUP, clientId: "context_texts", groupChat: undefined, userId: "user_mom" }), null);
});

test("only me fills on its saver's own tag, never on a guest's or anybody else's", () => {
  const mine = { createdBy: SAVER, people: [SAVER] };
  assert.equal(actorAccessOf(mine, { ...GROUP, chat: CHAT, taggerId: SAVER }), "use");
  // The same grant, a guest's tag: the token carries no tagger, so the saver's own key stays shut.
  assert.equal(actorAccessOf(mine, { ...GROUP, chat: CHAT }), null);
  assert.equal(actorAccessOf(mine, { ...GROUP, chat: CHAT, taggerId: "user_mom" }), null);
  assert.equal(actorAccessOf(mine, { ...GROUP, chat: CHAT, taggerId: "" }), null);
  // A key given to the tagger by someone else is still theirs to give, not the chat's.
  assert.equal(actorAccessOf({ createdBy: "user_ada", people: ["user_ada"], shares: [{ to: SAVER, level: "see" }] }, { ...GROUP, taggerId: SAVER }), null);
});

test("a group's link goes to the one workspace it reaches; several, or a named one, are left as they are", async () => {
  const calls = [];
  const call = async (name, args) => (calls.push([name, args]), { content: [] });
  await withGroupVault({ reach: ["crystal-care"] }, call)("vault_add_link", { name: "Gusto" });
  await withGroupVault({ reach: ["crystal-care"] }, call)("vault_add_link", { name: "Gusto", context: "@other" });
  await withGroupVault({ reach: ["crystal-care", "seyi-co"] }, call)("vault_add_link", { name: "Gusto" });
  await withGroupVault({ reach: ["crystal-care"] }, call)("vault_list", {});
  await withGroupVault(null, call)("vault_add_link", { name: "Gusto" });
  assert.deepEqual(calls, [
    ["vault_add_link", { name: "Gusto", context: "@crystal-care" }],
    ["vault_add_link", { name: "Gusto", context: "@other" }],
    ["vault_add_link", { name: "Gusto" }],
    ["vault_list", {}],
    ["vault_add_link", { name: "Gusto" }],
  ]);
});

test("the watched link is the one texted, hashed as the control plane does", async () => {
  const token = "0123456789abcdef".repeat(3);
  const want = createHash("sha256").update(token).digest("hex");
  assert.equal(await linkHash({ content: [{ type: "text", text: `Send this: https://context.test/vault/${token}?name=Gusto` }] }), want);
  assert.equal(await linkHash({ content: [{ type: "text", text: `https://context.test/vault/${token}` }] }), want);
  assert.equal(await linkHash({ content: [{ type: "text", text: "no link here" }] }), null);
  assert.equal(await linkHash(null), null);

  const ledger = {};
  const watched = withVaultWatch(ledger, async () => ({ content: [{ type: "text", text: `https://context.test/vault/${token}` }] }));
  await watched("vault_add_link", {});
  await watched("vault_add_link", {});
  assert.equal(ledger.vaultLink, true);
  assert.deepEqual(ledger.vaultLinks, [want]);
  // A refused call watches nothing.
  const refused = {};
  await withVaultWatch(refused, async () => ({ isError: true, content: [] }))("vault_add_link", {});
  assert.equal(refused.vaultLink, undefined);
});
