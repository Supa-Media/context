/**
 * An email offered for somebody else in a group chat (the owner, 2026-10-24):
 * people refine it together, it goes from one person's own Gmail, and only
 * that person's 👍 or yes sends it (`src/tools/offerFor.js`).
 *
 * Sabotage record (2026-10-24): letting `liked` through in a group without
 * `addressedTo` fails "somebody else's 👍 on the offer sends nothing";
 * dropping the `people` check in `offerTarget` fails "only someone in the
 * chat"; leaving `askFor` out of the answer fails "the Worker is told whose
 * yes it waits for".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PENDING_PREFIX } from "../src/tools/approvals.js";
import { addressedTo, offerLine } from "../src/tools/offerFor.js";

const TOKEN_ADA = `cat_group_offer_ada_${"0".repeat(20)}`;
const TOKEN_CY = `cat_group_offer_cyy_${"0".repeat(20)}`;
const KEY = "a".repeat(64);
const MEMBERS = "b".repeat(64);
const EMAIL = { to: ["jo@example.com"], subject: "Thursday", body: "Hi Jo,\n\nThursday at 7 at Bo's.\n\nCy" };
const verdict = (value) => ({ text: JSON.stringify({ verdict: value, reason: "" }) });

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  const groupGrant = (accessToken, userId, role, scopes) =>
    controlPlane.addGrant({ accessToken, workspaceId: "ws_egress_team", role, scopes, clientId: "context_texts_group", clientName: "Tex (group chats)", userId });
  await groupGrant(TOKEN_ADA, "user_egress", "editor", ["context:read", "context:write"]);
  await groupGrant(TOKEN_CY, "user_member", "member", ["context:read"]);
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.emailSender = "cy@gmail.example";
});
after(() => world.restore());

const tagged = (token, from, question, extra = {}) =>
  request(world.env, token, "/agent", { question, group: { key: KEY, members: MEMBERS, from, people: ["ada", "cy"] }, timeZone: "UTC", ...extra });
const sends = () => world.controlPlane.emailCalls.filter((entry) => !entry.check);
const live = () => [...world.team.keys()].filter((key) => key.startsWith(PENDING_PREFIX) && !String(world.team.get(key)?.body ?? "").startsWith("context.logical-delete"));

test("an email for someone else in the chat is shown to them by name, never held for the tagger", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, as: "@cy" } } }] }, { text: "Drafted it for Cy." }]);
  const asked = await tagged(TOKEN_ADA, "ada", "Tex make that shorter, it's from cy");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(sends().length, 0);
  assert.equal(live().length, 0, "nothing is held: a hold would be the tagger's");
  const offer = offerLine({ who: "cy", tool: "send_email", detail: "To: jo@example.com\nSubject: Thursday\n\nHi Jo,\n\nThursday at 7 at Bo's.\n\nCy" });
  assert.ok(asked.body.answer.includes(offer), asked.body.answer);
  assert.match(offer, /from @cy's email[\s\S]*@cy, give it a 👍 or say yes[\s\S]*Only @cy can OK it/);
  assert.deepEqual(asked.body.verbatim, [offer]);
  assert.equal(asked.body.askFor, "cy", "the Worker is told whose yes it waits for");
});

test("only someone in the chat, and only for a group", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, as: "bo" } } }] }, { text: "Couldn't." }]);
  await tagged(TOKEN_ADA, "ada", "Tex send it as bo");
  assert.match(toolReplies(world.model.requests.at(-1))[0], /@bo isn't in this chat/);
  assert.equal(sends().length, 0);
});

test("somebody else's 👍 on the offer sends nothing; the sender's 👍 sends that exact copy once", async () => {
  const offer = offerLine({ who: "cy", tool: "send_email", detail: "To: jo@example.com\nSubject: Thursday\n\nHi Jo,\n\nThursday at 7 at Bo's.\n\nCy" });
  // Ada likes it: not addressed to her, so the same call is held for her own yes instead.
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, verdict("yes"), { text: "Drafted." }]);
  const ada = await tagged(TOKEN_ADA, "ada", "👍", { quoted: offer, tapback: "Liked" });
  assert.equal(ada.status, 200, JSON.stringify(ada.body));
  assert.equal(sends().length, 0, "somebody else's 👍 on the offer sends nothing");
  assert.match(ada.body.answer, /@ada, give it a 👍/);

  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, verdict("yes"), { text: "Sent ✓" }]);
  const cy = await tagged(TOKEN_CY, "cy", "👍", { quoted: offer, tapback: "Liked" });
  assert.equal(cy.status, 200, JSON.stringify(cy.body));
  assert.equal(sends().length, 1, "the sender's 👍 sends it");
  assert.equal(sends()[0].email.body, EMAIL.body);
  assert.doesNotMatch(cy.body.answer, /give it a 👍/, "not asked twice");
});

test("a yes counts only from the person the words ask by name", () => {
  const offer = offerLine({ who: "cy", tool: "send_email", detail: "To: jo@example.com" });
  assert.equal(addressedTo(offer, "cy"), true);
  assert.equal(addressedTo(offer, "ada"), false);
  assert.equal(addressedTo("Give it a 👍 and I'll send it.", "cy"), false);
  assert.equal(addressedTo(offer, "not a handle"), false);
});
