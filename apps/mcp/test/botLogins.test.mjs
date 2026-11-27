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
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import mail from "../../../packages/shared/src/mail.cjs";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "bots", vis: "team" }];
const REVIEWER = "---\nholder: Reviewer\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n\n# Reviewer\n";
const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n\n# Grok Bot\n";

async function world({ bot, botName, carried = null, ...actor }, card = CARD) {
  const base = createMemoryStore();
  await base.put("bots/grok-bot/about.md", card);
  await base.put("bots/grok-bot/mail/seyi.md", "# Mail with Grok Bot\n");
  await base.put("bots/reviewer/about.md", REVIEWER);
  await base.put("bots/reviewer/mail/seyi.md", "# Mail with Reviewer\n");
  await base.put("areas/plans.md", "# Plans\n");
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
  // One connection may be several bots (an app such as Grok gives all its bots one connector), so a grant holds a list.
  const held = new Map(bot ? [["grant-1", [{ bot, name: botName ?? bot }]]] : []);
  const mailClient = {
    async bound({ grantId }) {
      asks.push(grantId);
      return { served: true, bots: held.get(grantId) ?? [] };
    },
    async bind({ grantId, bot: as, name }) {
      calls.push({ action: "bind", grantId, bot: as, name });
      held.set(grantId, [...(held.get(grantId) ?? []).filter((each) => each.bot !== as), { bot: as, name }]);
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

test("bind_bot finds a card by the full words it says, and binds it by its folder's name", async () => {
  // Tex Quality, 2026-11-26: "Tex Quality · Tex reply quality" found no card.
  const { store, calls } = await world({ role: "editor", name: "@seyi" }, CARD.replace("holder: Grok Bot", "holder: Grok Bot · Grok's ops"));
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { bind_bot: "Grok Bot · Grok's ops" });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual(calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot · Grok's ops" }]);
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
  assert.deepEqual(held.get("grant-1"), [{ bot: "grok-bot", name: "Grok Bot" }]);
  assert.deepEqual(calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot" }]);
});

test("a bound login joins only as its bot", async () => {
  const { store } = await world({ role: "editor", name: "@seyi", bot: "grok-bot", botName: "Grok Bot" });
  const result = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: "bots/grok-bot/mail/seyi.md", mail: { join: "cursor" } });
  assert.equal(result.isError, true);
  assert.match(said(result), /joins only as one of those/);
  assert.match(said(result), /"grok-bot"/);
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

// 2026-11-26, Grok Bot: "Every bot shares the same Context connection, so whichever bot binds last takes over the name
// for all of them, and Reviewer bound after me." Binding replaced the connection's one bot, so Grok Bot's reply was
// signed "reviewer". Now binding adds a bot, and each line is signed by the bot it names, or whose folder it is in.
test("two bots on one connection each sign as themselves", async () => {
  const { store, held, text } = await world({ role: "editor", name: "@seyi" });
  for (const name of ["Grok Bot", "Reviewer"]) {
    const bound = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { bind_bot: name });
    assert.equal(bound.isError, undefined, said(bound));
  }
  assert.deepEqual(held.get("grant-1").map((each) => each.bot), ["grok-bot", "reviewer"], "Reviewer binding after Grok Bot keeps Grok Bot");
  const send = (path, extra = {}) => toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path, mail: { text: "Done.", used: 0, ...extra } });
  // In its own folder each is itself, naming nothing.
  assert.equal((await send("bots/grok-bot/mail/seyi.md")).isError, undefined);
  assert.equal((await mailOf(text, "bots/grok-bot/mail/seyi.md")).at(-1).from, "grok-bot");
  assert.equal((await send("bots/reviewer/mail/seyi.md")).isError, undefined);
  assert.equal((await mailOf(text, "bots/reviewer/mail/seyi.md")).at(-1).from, "reviewer");
  // Naming itself wins over the folder: Grok Bot writing in Reviewer's mail is Grok Bot.
  assert.equal((await send("bots/reviewer/mail/seyi.md", { as: "grok-bot" })).isError, undefined);
  assert.equal((await mailOf(text, "bots/reviewer/mail/seyi.md")).at(-1).from, "grok-bot");
  // Elsewhere it says which, or is refused rather than guessed.
  const unnamed = await send("areas/plans.md");
  assert.equal(unnamed.isError, true);
  assert.match(said(unnamed), /several bots \(grok-bot, reviewer\)/);
  assert.equal((await send("areas/plans.md", { as: "reviewer" })).isError, undefined);
  assert.equal((await mailOf(text, "areas/plans.md")).at(-1).from, "reviewer");
  // A bot it is not bound as is refused, so a shared connection never speaks as a bot nobody bound.
  const other = await send("areas/plans.md", { as: "pipeline" });
  assert.equal(other.isError, true);
  assert.match(said(other), /not "pipeline"/);
});

// The preview run of the test above (2026-11-27) found mail.as refused before the tool ran: "unknown argument
// mail.as". The tool's own schema must take it, or a shared connection can never say which bot it is.
test("write_note's schema takes mail.as", async () => {
  const { noteWriteToolDefinitions } = await import("../src/tools/schemas/notes.js");
  const { validateArguments } = await import("../src/toolArguments.js");
  const writeNote = noteWriteToolDefinitions().find((tool) => tool.name === "write_note");
  assert.equal(validateArguments(writeNote.inputSchema, { path: "areas/plans.md", mail: { text: "hi", as: "grok-bot", used: 0 } }), null);
});

test("setup_bot binds, mails the check and answers with every step left, filled in for that bot", async () => {
  // Dev, 2026-11-27: "could we make a context mcp action that makes it easier?", after seven bots stopped part way
  // through the pasted steps. One call, whose answer is the rest, filled in.
  const { store, calls, text } = await world({ role: "editor", name: "@seyi", workspaceSlug: "supa" });
  const hooks = store.botHooks;
  store.botHooks = async (request) => (request.action === "test" ? (calls.push(request), { ok: true, status: 200 }) : hooks(request));
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" });
  assert.equal(result.isError, undefined, said(result));
  // A webhook bot's check goes to it as a test routine, so setup passes only when a routine wake reaches its main chat
  // and gets done (the Capabilities bot, 2026-11-27: mail got through, routine wakes were dropped).
  assert.deepEqual(calls, [{ action: "bind", grantId: "grant-1", bot: "grok-bot", name: "Grok Bot" }, { action: "test", bot: "grok-bot", routine: true }]);
  assert.equal((await mailOf(text, "bots/grok-bot/mail/context.md")).length, 1);
  const answer = said(result);
  // The relay routine (its card says reach: webhook), the test routine to let through, the as: name and its picture.
  const relay = answer.indexOf("Never write to Context, reply, or send anything from this run.");
  const routine = answer.indexOf('Context just sent your webhook a test routine whose job is to answer your setup check in "bots/grok-bot/mail/context.md"');
  const as = answer.indexOf('pass as: "grok-bot"');
  const picture = answer.indexOf('path: "bots/grok-bot/about.md"');
  assert.ok(relay > 0 && routine > relay && as > routine && picture > as, answer);
  // A webhook call may wait until the person writes in the bot's chat (Dev, 2026-11-27: "fix these PLEASE"), so a
  // webhook bot makes the 5-minute check-in too, and is never told to switch to a webhook it already has.
  const checkIn = answer.indexOf('runs every 5 minutes');
  assert.ok(checkIn > relay && checkIn < routine, answer);
  assert.match(answer, /orient \{ context: "@supa", for: "Grok Bot", check: true \}/);
  assert.doesNotMatch(answer, /switch you to a webhook/);
  // Not answered from the setup reply, which would prove nothing about routines.
  assert.doesNotMatch(answer, /Answer Context's setup check now/);
  assert.match(answer, /orient \{ context: "@supa", for: "Grok Bot" \}/);
  // Bots sharing one workspace save their pictures to one file: each takes a lock and uploads its own copy (#4442).
  assert.match(answer, /mkdir \/workspace\/\.profile-picture\.lock/);
  assert.match(answer, /\/workspace\/profile-picture-grok-bot\.png/);
});

test("setup_bot leaves out the relay routine for a bot that checks its own mail, and is refused as bind_bot is", async () => {
  const mailer = await world({ role: "editor", name: "@seyi" }, CARD.replace("reach: webhook\n", "reach: mail\n"));
  const result = await toolSetArea(mailer.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" });
  assert.equal(result.isError, undefined, said(result));
  assert.doesNotMatch(said(result), /webhook fires/);
  // It checks its own mail, so it answers the check from its chat, and no test routine is sent.
  assert.match(said(result), /Answer Context's setup check now/);
  assert.equal(mailer.calls.filter((call) => call.action === "test").length, 0);
  // Its guide is the check-in job: one cheap call every 5 minutes (`botApps.cjs`).
  assert.match(said(result), /runs every 5 minutes .* orient \{ for: "Grok Bot", check: true \}/);
  // No workspace name known: no context: argument is made up.
  assert.doesNotMatch(said(result), /context: "/);
  const theirs = await world({ role: "editor", name: "@sayo" });
  const refused = await toolSetArea(theirs.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" });
  assert.equal(refused.isError, true);
  assert.match(said(refused), /only their own connection binds it/);
  assert.deepEqual(theirs.calls, []);
  const member = await world({ role: "member", name: "@seyi" });
  assert.equal((await toolSetArea(member.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" })).isError, true);
});

test("a card with no reach is set up its app's way: Grok by webhook, Muse and Instinct by checking in", async () => {
  // Dev, 2026-11-27: "grokbot we know has webhooks so thats the most reliable, but for things like muse, instinct etc
  // it might be a little tough, so we should store skills or guides in the connect_bot action".
  const grok = await world({ role: "editor", name: "@seyi" }, CARD.replace("reach: webhook\n", ""));
  const grokSaid = said(await toolSetArea(grok.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" }));
  // Grok gets the relay routine and the test routine; since 2026-11-27 it keeps the 5-minute check-in as well.
  assert.match(grokSaid, /webhook fires/);
  assert.match(grokSaid, /check: true/);
  assert.equal(grok.calls.filter((call) => call.action === "test").length, 1);
  const muse = await world({ role: "editor", name: "@seyi" }, CARD.replace("reach: webhook\n", "").replace("bot: grok", "bot: muse"));
  const museSaid = said(await toolSetArea(muse.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" }));
  assert.match(museSaid, /Make a job in Muse that runs every 5 minutes/);
  assert.match(museSaid, /If Muse can't run a job on a schedule, tell your person/);
  assert.equal(muse.calls.filter((call) => call.action === "test").length, 0);
  // A card that says its reach keeps it, whatever its app prefers.
  const hooked = await world({ role: "editor", name: "@seyi" }, CARD.replace("bot: grok", "bot: instinct"));
  assert.match(said(await toolSetArea(hooked.store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" })), /webhook fires/);
});

test("setup_bot falls back to answering the check from the chat when the test routine can't be sent", async () => {
  const { store } = await world({ role: "editor", name: "@seyi" });
  store.botHooks = async (request) => (request.action === "test" ? { error: "Grok Bot has no webhook here" } : { bot: null });
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { setup_bot: "Grok Bot" });
  assert.match(said(result), /The test routine could not be sent \(Grok Bot has no webhook here\)/);
  assert.match(said(result), /Answer Context's setup check now/);
});
