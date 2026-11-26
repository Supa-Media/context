/**
 * A bot's login bound to its card (`tools/notes/botBind.js`, `tools/notes/mail.js`; Dev, 2026-11-26: "anything that
 * login writes shows as Grok Bot, Pipeline and so on instead of Cursor. Any write that isn't bound gets rejected",
 * and "Context sends one test mail as the last step").
 *
 * ## Sabotage record
 *
 * Signing a bound login's line with its app's name again failed "a bound login's mail is signed by its bot". Dropping
 * the card check from the join failed "another connection can't join under a bot's name". Letting an unnamed card be
 * bound by anybody (2026-11-26) failed "bind_bot is refused on a card that names nobody".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolSetArea } from "../src/tools/notes/setArea.js";
import { toolMailNote } from "../src/tools/notes/mail.js";
import { boundBotOf } from "../src/mail/boundBot.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import mail from "../../../packages/shared/src/mail.cjs";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "bots", vis: "team" }];
const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n\n# Grok Bot\n";

async function world({ bot, botName, carried = null, ...actor }, card = CARD) {
  const base = createMemoryStore();
  await base.put("bots/grok-bot/about.md", card);
  await base.put("bots/grok-bot/mail/seyi.md", "# Mail with Grok Bot\n");
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "bots", visibility: "team" }], notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind: "shared", client: "Cursor · @seyi", clientName: "Cursor", grantId: "grant-1", ...actor };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] } : served(request);
  store.treeEntries = async () => (await base.list({})).objects;
  const calls = [];
  const asks = [];
  // Which bot this connection is lives in the workspace's object (`workspaceStore/mailBots.js`), never the control plane.
  const held = new Map(bot ? [["grant-1", { bot, name: botName ?? bot }]] : []);
  const mailClient = {
    async bound({ grantId }) {
      asks.push(grantId);
      return { served: true, bound: held.get(grantId) ?? null };
    },
    async bind({ grantId, bot: as, name }) {
      calls.push({ action: "bind", grantId, bot: as, name });
      held.set(grantId, { bot: as, name });
      return { served: true, ok: true };
    },
  };
  store.objectReading = { client: { mail: mailClient }, home: "object", behind: false, scope: "team", names: [], workspaceId: "ws-test", userId: "u1" };
  // A login bound before bindings moved to the object (`apps/convex/functions/botLoginsCarry.ts`), carried once.
  store.botHooks = async (request) => {
    if (request.action === "carried") return carried ?? { bot: null };
    calls.push(request);
    return { error: "the control plane is not asked about bots' logins" };
  };
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  return { store, calls, asks, held, text };
}

const said = (result) => result.content.map((part) => part.text).join("\n");
const mailOf = async (text, key) => mail.parseMail((await text(key)) ?? "").events.filter((event) => event.kind === "mail");

test("bind_bot binds this connection as the card's bot and mails it a check, with no area", async () => {
  const { store, calls, text } = await world({ role: "editor", name: "@seyi" });
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot" });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual(calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot" }]);
  const check = await mailOf(text, "bots/grok-bot/mail/context.md");
  assert.equal(check.length, 1);
  assert.equal(check[0].from, "context");
  assert.match(check[0].text, /answer here/);
  assert.match(said(result), /bots\/grok-bot\/mail\/context\.md/);
});

test("bind_bot is refused for a bot with no card, or one that is somebody else's", async () => {
  const none = await world({ role: "editor", name: "@seyi" });
  const missing = await toolSetArea(none.store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Payroll" });
  assert.equal(missing.isError, true);
  assert.match(said(missing), /no card for Payroll/);
  const other = await world({ role: "editor", name: "@kim" });
  const theirs = await toolSetArea(other.store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot" });
  assert.equal(theirs.isError, true);
  assert.match(said(theirs), /@seyi's bot/);
  assert.deepEqual([...none.calls, ...other.calls], []);
});

// A card that names nobody left `whose` empty, and the check short-circuits on that, so any connection that could see
// the card bound itself as the bot: its mail is then signed by the bot, its reads say the bot, and its answer marks the
// bot answering. Binding is an identity, so an unnamed card is an owner's to bind.
test("bind_bot is refused on a card that names nobody, unless an owner's connection asks", async () => {
  const unnamed = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nreach: webhook\n---\n\n# Grok Bot\n";
  const anyone = await world({ role: "editor", name: "@kim" }, unnamed);
  const tried = await toolSetArea(anyone.store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot" });
  assert.equal(tried.isError, true, said(tried));
  assert.match(said(tried), /names nobody/);
  assert.deepEqual(anyone.calls, [], "nothing is bound");
  const owner = await world({ role: "owner", name: "@seyi" }, unnamed);
  const bound = await toolSetArea(owner.store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot" });
  assert.equal(bound.isError, undefined, said(bound));
  assert.deepEqual(owner.calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot" }]);
});

test("a bound login's mail is signed by its bot, asking its workspace once", async () => {
  const { store, calls, asks, text } = await world({ role: "editor", name: "@seyi", bot: "grok-bot", botName: "Grok Bot" });
  const deferred = [];
  store.defer = (work) => deferred.push(work);
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { text: "Done.", used: 1 } });
  assert.equal(result.isError, undefined, said(result));
  await Promise.all(deferred);
  const lines = await mailOf(text, "bots/grok-bot/mail/seyi.md");
  assert.equal(lines.at(-1).from, "grok-bot");
  assert.deepEqual(calls, []);
  // One ask per connection, however many lines it writes.
  await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { text: "Again.", used: 0 } });
  assert.equal(asks.length, 1);
});

test("only an owner's or editor's connection binds a bot", async () => {
  const { store, calls } = await world({ role: "member", name: "@seyi" });
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot" });
  assert.equal(result.isError, true);
  assert.match(said(result), /only an owner or editor/);
  assert.deepEqual(calls, []);
});

test("a login bound before bindings moved to the object is carried there once, and signs as its bot", async () => {
  const { store, calls, held, text } = await world({ role: "editor", name: "@seyi", carried: { bot: "grok-bot", name: "Grok Bot" } });
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { text: "Here.", used: 0 } });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await mailOf(text, "bots/grok-bot/mail/seyi.md")).at(-1).from, "grok-bot");
  assert.deepEqual(held.get("grant-1"), { bot: "grok-bot", name: "Grok Bot" });
  assert.deepEqual(calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot" }]);
});

test("a bound login joins only as its bot", async () => {
  const { store } = await world({ role: "editor", name: "@seyi", bot: "grok-bot", botName: "Grok Bot" });
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { join: "cursor" } });
  assert.equal(result.isError, true);
  assert.match(said(result), /joins only as "grok-bot"/);
});

test("another connection can't join under a bot's name", async () => {
  const { store } = await world({ role: "editor", name: "@seyi" });
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { join: "grok-bot" } });
  assert.equal(result.isError, true);
  assert.match(said(result), /isn't bound as that bot/);
});

test("an unbound connection still sends under its app's name", async () => {
  const { store, calls, text } = await world({ role: "editor", name: "@seyi" });
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { text: "hi", used: 0 } });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await mailOf(text, "bots/grok-bot/mail/seyi.md")).at(-1).from, "cursor--seyi");
  assert.deepEqual(calls, []);
});
