/**
 * Tex in a group chat acts for whoever tagged it (the owner, 2026-10-21:
 * "calendar is necessary", "email too, write only not read", "computer use as
 * well"): one email from the tagger's Gmail and one change to the tagger's
 * calendar, each held for the tagger's own yes, and the web with a browser
 * that holds nobody's sign-ins. Never anyone's mail.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `groupWriteTools` dropping `groupOwnAccountTools` → "a group turn is
 *     offered email and calendar".
 *  2. `tools/session.js` dropping the `actsOnOwnAccount` exemption → "a member
 *     tagger's email is held" (the member's grant can't write).
 *  3. `textedAsk` keeping the 1:1 wording for a group → "the ask says to reply".
 *  4. The route settling a group's yes without `withoutTexName` → "the
 *     tagger's 'Tex, yes' sends it".
 *  5. `listPending` not filtering by the acting person → "somebody else's yes
 *     sends nothing".
 *  6. `turnWeb.js` handing a group turn no vault store → "a group turn can
 *     browse, and sign in only from its workspace's vault".
 *  7. The route opening no computer for a group → the same test.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PENDING_PREFIX } from "../src/tools/approvals.js";
import { GROUP_MEMORY_PREFIX } from "../src/agent/groupTurn.js";

const TOKEN_GROUP_EGRESS = `cat_group_act_egress_${"0".repeat(19)}`;
const TOKEN_GROUP_MEMBER = `cat_group_act_member_${"0".repeat(19)}`;
const KEY = "d".repeat(64);
const MEMBERS = "e".repeat(64);
const EMAIL = { to: ["jo@example.com"], subject: "Thursday", body: "Hi Jo,\n\nThursday at 7 at Bo's.\n\nCy" };
const CREATE = { action: "create", title: "Rehearsal", start: "2026-10-23T19:00:00-04:00", end: "2026-10-23T21:00:00-04:00" };
const verdict = (value) => ({ text: JSON.stringify({ verdict: value, reason: "" }) });

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  const groupGrant = (accessToken, userId, role, scopes) =>
    controlPlane.addGrant({ accessToken, workspaceId: "ws_egress_team", role, scopes, clientId: "context_texts_group", clientName: "Tex (group chats)", userId });
  await groupGrant(TOKEN_GROUP_EGRESS, "user_egress", "editor", ["context:read", "context:write"]);
  // A member of the shared workspace: it can't write there, but it can still send as itself.
  await groupGrant(TOKEN_GROUP_MEMBER, "user_member", "member", ["context:read"]);
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.emailSender = "cy@gmail.example";
  controlPlane.flags.calendarAddress = "cy@gmail.example";
});
after(() => world.restore());

const tagged = (token, question, from) => request(world.env, token, "/agent", { question, group: { key: KEY, members: MEMBERS, from }, timeZone: "UTC" });
const sends = () => world.controlPlane.emailCalls.filter((entry) => !entry.check);
const changes = () => world.controlPlane.calendarCalls.filter((entry) => !entry.check);
const live = (prefix) =>
  [...world.team.keys()].filter((key) => key.startsWith(prefix) && !String(world.team.get(key)?.body ?? "").startsWith("context.logical-delete"));
const sendTool = (sent) => (sent?.tools ?? []).find((tool) => tool.name === "send");

test("a group turn is offered email, calendar and the web, and nothing that reads mail", async () => {
  world.model.install([{ text: "Hi." }]);
  const { status } = await tagged(TOKEN_GROUP_MEMBER, "Tex hi", "cy");
  assert.equal(status, 200);
  const sent = world.model.requests.at(-1);
  const send = JSON.stringify(sendTool(sent) ?? {});
  assert.match(send, /- email: Send one email as the person/, "email is offered");
  assert.match(send, /- calendar: Add, move or cancel one event/, "calendar is offered");
  assert.match(send, /- open_page: /, "and the web");
  const shown = JSON.stringify(sent.tools);
  for (const reads of ["search_email", "read_email", "email_search"]) assert.ok(!shown.includes(`"${reads}"`), `${reads} is not a group turn's`);
  assert.match(send, /- fill_login: /, "signing in is offered, from the workspace's vault");
  assert.match(JSON.stringify(sent.system), /only with a login saved in this workspace for the whole workspace/);
});

test("a member tagger's email is held, the ask says to reply, and somebody else's yes sends nothing", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, verdict("yes"), { text: "Drafted it for Jo." }]);
  const asked = await tagged(TOKEN_GROUP_MEMBER, "Tex email Jo that it's Thursday at 7 at Bo's", "cy");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(sends().length, 0);
  assert.equal(live(PENDING_PREFIX).length, 1, "held in the chat's workspace");
  assert.match(asked.body?.answer ?? "", /From: cy@gmail\.example[\s\S]*Look good\? Give this a 👍 or reply yes and I'll send it/, "the ask says to reply");

  const before = world.model.requests.length;
  world.model.install([{ text: "That one's Cy's to approve." }]);
  await tagged(TOKEN_GROUP_EGRESS, "Tex, yes", "ada");
  assert.equal(sends().length, 0, "somebody else's yes sends nothing");
  assert.ok(world.model.requests.length > before, "it went to the model as an ordinary tag");
  assert.equal(live(PENDING_PREFIX).length, 1);

  const settled = world.model.requests.length;
  const yes = await tagged(TOKEN_GROUP_MEMBER, "Tex, yes", "cy");
  assert.equal(world.model.requests.length, settled, "the tagger's 'Tex, yes' sends it without a model");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].email.from, "cy@gmail.example");
  assert.match(yes.body?.answer ?? "", /^Done, I sent an email to jo@example\.com/);
  const memory = live(GROUP_MEMORY_PREFIX).map((key) => String(world.team.get(key)?.body ?? "")).join("");
  assert.match(memory, /Done, I sent an email/, "the chat remembers it");
});

test("a tagger's calendar change is held for their yes the same way", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "calendar", args: CREATE } }] }, { text: "Here it is." }]);
  const asked = await tagged(TOKEN_GROUP_MEMBER, "Tex put rehearsal on my calendar friday 7 to 9", "cy");
  assert.equal(asked.status, 200);
  assert.equal(changes().length, 0);
  assert.match(asked.body?.answer ?? "", /Rehearsal[\s\S]*Give this a 👍 or reply yes and I'll make the change/);
  const yes = await tagged(TOKEN_GROUP_MEMBER, "yes tex", "cy");
  assert.equal(changes().length, 1);
  assert.equal(yes.body?.answer, 'Done, I added "Rehearsal" to your calendar.');
});

test("a group turn can browse, and sign in only from its workspace's vault", async () => {
  world.model.install([
    { toolCalls: [{ name: "send", args: { action: "fill_login", args: { entry: "example" } } }, { name: "send", args: { action: "open_page", args: { urls: ["https://example.com/status"] } } }] },
    { text: "All fine." },
  ]);
  const { status } = await tagged(TOKEN_GROUP_EGRESS, "Tex is https://example.com/status up?", "ada");
  assert.equal(status, 200);
  const [login, page] = toolReplies(world.model.requests.at(-1));
  // Offered, and opened against the chat's workspace; whose keys count there is vaultGroupChat.test.mjs's.
  assert.doesNotMatch(login, /has no action/, login);
  assert.doesNotMatch(login, /filled|signed in/i, login);
  assert.match(page, /All fine/, "the page was read");
});
