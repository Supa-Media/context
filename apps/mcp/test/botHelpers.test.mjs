/**
 * A bot's helpers (`tools/notes/botHelpers.js`, `http/botHelperClaim.js`, `sessionPayload.js`; Dev, 2026-11-27: "it
 * doesn't register directly as Claude, but it registers as Claude by way of grok").
 *
 * ## Sabotage record
 *
 * Dropping the helper override in `mail.js` (signing a helper's line as its bot) failed "a helper's mail is signed
 * as itself". Removing `helperRefusal` from `setArea.js` failed "a helper can't bind, set a webhook or start helpers".
 * Letting `start_helper` run on an unbound connection failed "only a bound bot starts a helper". Accepting a session
 * helper with a note outside a bots folder failed "a malformed helper in the session is an auth failure".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolSetArea } from "../src/tools/notes/setArea.js";
import { toolMailNote } from "../src/tools/notes/mail.js";
import { activityBot } from "../src/live/activityBot.js";
import { normalizeSession } from "../src/sessionPayload.js";
import { handleBotHelperClaim, helperMcpConfig } from "../src/http/botHelperClaim.js";
import { helperOfNote, areaOfMailNote } from "../src/workspaceStore/botMail.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import mail from "../../../packages/shared/src/mail.cjs";
import botHelpers from "../../../packages/shared/src/botHelpers.cjs";
import areaBots from "../../../packages/shared/src/areaBots.cjs";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "bots", vis: "team" }];
const CARD = "---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n\n# Grok Bot\n";
const HELPER = Object.freeze({ helperId: "hlp_0123456789abcdef", workspaceId: "ws-test", bot: "grok-bot", botName: "Grok Bot", name: "Claude", mail: "grok-bot-claude-0123", note: "bots/grok-bot/helpers/2026-11-27-fix-search.md" });

async function world({ bound = true, helper = null, ...actor } = {}) {
  const base = createMemoryStore();
  await base.put("bots/grok-bot/about.md", CARD);
  await base.put("bots/grok-bot/mail/seyi.md", "# Mail with Grok Bot\n");
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "bots", visibility: "team" }], notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = {
    workspaceId: "ws-test",
    workspaceKind: "shared",
    workspaceSlug: "supa",
    client: helper ? "Claude via Grok Bot" : "Cursor",
    grantId: "grant-1",
    role: "editor",
    name: "@seyi",
    ...(helper ? { helper } : {}),
    ...actor,
  };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] } : served(request);
  store.treeEntries = async () => (await base.list({})).objects;
  // The helper acts as its bot's grant, which is bound as Grok Bot.
  const held = new Map(bound ? [["grant-1", [{ bot: "grok-bot", name: "Grok Bot" }]]] : []);
  const binds = [];
  store.objectReading = {
    client: {
      mail: {
        async bound({ grantId }) {
          return { served: true, bots: held.get(grantId) ?? [] };
        },
        async bind(fields) {
          binds.push(fields);
          return { served: true, ok: true };
        },
      },
    },
    home: "object",
    behind: false,
    scope: "team",
    names: [],
    workspaceId: "ws-test",
    userId: "u1",
  };
  store.botHooks = async (request) => (request.action === "carried" ? { bot: null } : { error: "not asked" });
  const helperCalls = [];
  store.botHelpers = {
    async start(fields) {
      helperCalls.push({ action: "start", ...fields });
      return { ticket: "tkt_abcdefghijklmnopqrstuv", expiresAt: Date.now() + 3600e3, ticketExpiresAt: Date.now() + 600e3 };
    },
    async end(helperId) {
      helperCalls.push({ action: "end", helperId });
      return { ended: true };
    },
  };
  Object.defineProperty(store, "botHelperUrl", { value: "https://mcp.example/api/bot-helper", enumerable: false });
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  return { store, base, text, binds, helperCalls };
}

const said = (result) => result.content.map((part) => part.text).join("\n");

test("start_helper writes the helper's note in its bot's folder and answers with the shell command, the command line and the brief", async () => {
  const { store, base, text, helperCalls } = await world();
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { start_helper: { task: "Fix the reading-list search miss" } });
  assert.equal(result.isError, undefined, said(result));
  const start = helperCalls.find((call) => call.action === "start");
  assert.ok(start, "the control plane is asked for a ticket");
  assert.equal(start.bot, "grok-bot");
  assert.equal(start.botName, "Grok Bot");
  assert.equal(start.name, "Claude");
  assert.match(start.helperId, /^hlp_[0-9a-f]{16}$/);
  assert.match(start.mail, /^grok-bot-claude-[0-9a-f]{4}$/);
  assert.match(start.note, /^bots\/grok-bot\/helpers\/\d{4}-\d{2}-\d{2}-fix-the-reading-list-search-miss\.md$/);
  const note = await text(start.note);
  assert.match(note, /status: working/);
  assert.match(note, new RegExp(`helper_id: ${start.helperId}`));
  assert.match(note, /## Progress/);
  const answer = said(result);
  // The ticket goes to a shell command whose output is a file; the token is never in this answer.
  assert.match(answer, /umask 077; curl -sS --fail-with-body -X POST -H 'Authorization: Bearer tkt_abcdefghijklmnopqrstuv' https:\/\/mcp\.example\/api\/bot-helper -o/);
  assert.match(answer, /claude -p --mcp-config/);
  assert.match(answer, /Claude via Grok Bot/);
  assert.match(answer, /every 5 minutes for up to 30 minutes/);
  assert.match(answer, /Report to Grok Bot in your note's mail/);
  assert.equal((await base.list({ prefix: "bots/grok-bot/helpers/" })).objects.length, 1);
});

test("only a bound bot starts a helper", async () => {
  const { store, helperCalls } = await world({ bound: false });
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { start_helper: { task: "Anything" } });
  assert.equal(result.isError, true);
  assert.match(said(result), /only a bot starts helpers/);
  assert.deepEqual(helperCalls, []);
});

test("a helper can't bind, set a webhook or start helpers of its own", async () => {
  for (const args of [{ bind_bot: "Grok Bot" }, { setup_bot: "Grok Bot" }, { start_helper: { task: "More" } }, { webhook: { bot: "Grok Bot", address: "https://x.example" } }, { test_webhook: "Grok Bot" }]) {
    const { store, binds, helperCalls } = await world({ helper: HELPER });
    const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(said(result), /you are a helper \(Claude via Grok Bot\)/);
    assert.deepEqual(binds, []);
    assert.deepEqual(helperCalls, []);
  }
});

test("a helper's mail is signed as itself, 'Claude via Grok Bot', never as the bot its grant is bound as", async () => {
  const { store, base, text } = await world({ helper: HELPER });
  await base.put(HELPER.note, "---\nstatus: working\n---\n\n# Fix search\n");
  const sent = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: HELPER.note, mail: { text: "Opened PR #12, CI running" } });
  assert.equal(sent.isError, undefined, said(sent));
  const [line] = mail.parseMail(await text(HELPER.note)).events.filter((event) => event.kind === "mail");
  assert.equal(line.from, "grok-bot-claude-0123");
  assert.equal(line.app, "Claude via Grok Bot · @seyi");
  const posing = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: HELPER.note, mail: { text: "hi", as: "grok-bot" } });
  assert.equal(posing.isError, true);
  const joining = await toolMailNote(store, "team", RULES, new PrivacyOverrides(), { path: HELPER.note, mail: { join: "grok-bot" } });
  assert.equal(joining.isError, true);
  assert.match(said(joining), /join only as "grok-bot-claude-0123"/);
});

test("a helper shows in agents active and on its caret as 'Claude via Grok Bot', one row of its own", async () => {
  const { store } = await world({ helper: HELPER });
  assert.deepEqual(await activityBot(store, { path: "areas/plans.md" }), { bot: "grok-bot-claude-0123", name: "Claude via Grok Bot", helper: true });
});

test("end_helper from the helper sets its note done, mails its bot the summary, then closes its connection", async () => {
  const { store, base, text, helperCalls } = await world({ helper: HELPER });
  await base.put(HELPER.note, "---\nhelper: \"Claude\"\nstatus: working\nprogress: \"Starting\"\n---\n\n# Fix search\n");
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { end_helper: { summary: "Merged PR #12" } });
  assert.equal(result.isError, undefined, said(result));
  const note = await text(HELPER.note);
  assert.match(note, /status: "done"/);
  assert.match(note, /progress: "Merged PR #12"/);
  const lines = mail.parseMail(note).events.filter((event) => event.kind === "mail");
  assert.equal(lines.at(-1).from, HELPER.mail);
  assert.match(lines.at(-1).text, /Done: Merged PR #12/);
  assert.deepEqual(helperCalls, [{ action: "end", helperId: HELPER.helperId }], "ended last, after the note and the mail");
});

test("end_helper from the bot names the helper's note and stops it", async () => {
  const { store, base, text, helperCalls } = await world();
  await base.put(HELPER.note, `---\nhelper_id: ${HELPER.helperId}\nstatus: working\n---\n\n# Fix search\n`);
  const result = await toolSetArea(store, "team", RULES, new PrivacyOverrides(), { end_helper: { note: HELPER.note, summary: "Not needed any more" } });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual(helperCalls, [{ action: "end", helperId: HELPER.helperId }]);
  assert.match(await text(HELPER.note), /status: "stopped"/);
});

test("a helper in the session is honoured only whole and well formed", () => {
  const raw = { grantId: "g1", clientId: "c1", actorUserId: "u1", scopes: ["context:read"], defaultWorkspaceId: "ws-1", workspaces: [{ workspaceId: "ws-1", role: "editor", kind: "shared", slug: "supa" }] };
  assert.equal(normalizeSession(raw).helper, undefined);
  assert.deepEqual({ ...normalizeSession({ ...raw, helper: HELPER }).helper }, { ...HELPER });
  for (const broken of [{ ...HELPER, note: "areas/x.md" }, { ...HELPER, helperId: "nope" }, { ...HELPER, mail: "Has Caps" }, { ...HELPER, name: "" }, "Claude"]) {
    assert.throws(() => normalizeSession({ ...raw, helper: broken }), /invalid_token/);
  }
});

test("POST /api/bot-helper spends the ticket into an MCP config whose token is only in the body", async () => {
  const asked = [];
  const controlPlane = {
    async botHelper(action, body) {
      asked.push({ action, ...body });
      return { accessToken: "cxh_secret_token", helperId: HELPER.helperId, expiresAt: 1 };
    },
  };
  const ok = await handleBotHelperClaim(new Request("https://mcp.example/api/bot-helper", { method: "POST", headers: { authorization: "Bearer tkt_abcdefghijklmnopqrstuv" } }), {}, { controlPlane });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ok.json(), helperMcpConfig("https://mcp.example", "cxh_secret_token"));
  assert.deepEqual(asked, [{ action: "claim", ticket: "tkt_abcdefghijklmnopqrstuv" }]);
  const bad = await handleBotHelperClaim(new Request("https://mcp.example/api/bot-helper", { method: "POST" }), {}, { controlPlane });
  assert.equal(bad.status, 401);
  const refused = await handleBotHelperClaim(new Request("https://mcp.example/api/bot-helper", { method: "POST", headers: { authorization: "Bearer tkt_abcdefghijklmnopqrstuv" } }), {}, { controlPlane: { botHelper: async () => ({ error: "spent" }) } });
  assert.equal(refused.status, 403);
  assert.doesNotMatch(await refused.text(), /cxh_/);
  const get = await handleBotHelperClaim(new Request("https://mcp.example/api/bot-helper"), {}, { controlPlane });
  assert.equal(get.status, 405);
});

test("a helper's note is mail to its bot, and only inside a bot's own folder", () => {
  assert.equal(helperOfNote("bots/grok-bot/helpers/2026-11-27-fix.md"), "bots/grok-bot");
  assert.equal(areaOfMailNote("bots/grok-bot/helpers/2026-11-27-fix.md"), "bots/grok-bot");
  assert.equal(helperOfNote("areas/finance/helpers/x.md"), null);
  assert.equal(areaOfMailNote("areas/finance/helpers/x.md"), null);
  assert.equal(areaOfMailNote("areas/finance/mail/seyi.md"), "areas/finance");
});

test("every bot's setup holds the helper rule itself, not only a tool's answer", () => {
  const prompt = areaBots.setupPrompt({ bot: "Grok Bot", kind: "grok", whose: "@seyi", workspace: "@supa", reach: "webhook" });
  assert.match(prompt, /start_helper/);
  assert.match(prompt, /Claude via <your name>/);
  assert.equal(botHelpers.helperShownName("Claude", "Pablo · Social Strategist"), "Claude via Pablo");
});
