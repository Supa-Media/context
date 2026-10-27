/**
 * Tex in a group chat whose people are members or invited by number (invited
 * family, the owner, 2026-10-27; `src/agent/groupTurn.js`,
 * `docs/decisions/texting-assistant/invited-family.md`).
 *
 * The chat reads its workspace at team tier like a chat of members. An
 * invited person has no account, so the control plane mints their tag on the
 * binder's grant and the Worker names no tagger handle. This file proves the
 * gateway reads a handle-less tag as nobody's own account.
 *
 * Sabotage record (2026-10-27), each fails a test here:
 *  - `groupOf` marking a handle-less tag only in guest chats: "an invited
 *    person's email goes only from a member" and "an invited person's yes";
 *  - dropping `noAccountTaggerCallTool`: "an invited person's email goes only
 *    from a member".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PENDING_PREFIX } from "../src/tools/approvals.js";

const TOKEN_CHAT = `cat_group_invited_chat_${"0".repeat(16)}`;
const KEY = "e".repeat(64);
const MEMBERS = "f".repeat(64);
const EMAIL = { to: ["client@example.com"], subject: "Hours", body: "Hi,\n\nThis week came to 32 hours.\n\nSeyi" };
const verdict = (value) => ({ text: JSON.stringify({ verdict: value, reason: "" }) });

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane, team } = world;
  // An ordinary chat's grant: team tier, named for nobody. The binder's (Seyi's), clamped to an editor's hand.
  await controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  controlPlane.holdRules("ws_egress_team", { etag: "rules-invited-1", accessVersion: 1, folders: [{ prefix: "clients", visibility: "team" }], notes: [] });
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.emailSender = "seyi@gmail.example";
  team.set("clients/acme.md", { body: "# Acme\n\nACME-MARKER\n", etag: "i1" });
});
after(() => world.restore());

const chat = (from) => ({ key: KEY, members: MEMBERS, from, people: ["seyi"] });
const tagged = (from, question, extra = {}) => request(world.env, TOKEN_CHAT, "/agent", { question, group: chat(from), timeZone: "UTC", ...extra });
const sends = () => world.controlPlane.emailCalls.filter((entry) => !entry.check);
const live = () => [...world.team.keys()].filter((key) => key.startsWith(PENDING_PREFIX) && !String(world.team.get(key)?.body ?? "").startsWith("context.logical-delete"));

test("an invited person's tag reads the whole workspace and is told sends go from a member", async () => {
  world.model.install([{ toolCalls: [{ name: "read_note", args: { path: "clients/acme.md" } }] }, { text: "Acme is on file." }]);
  const asked = await tagged("", "Tex what do we have on Acme?");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.match(toolReplies(world.model.requests.at(-1))[0], /ACME-MARKER/);
  const system = JSON.stringify(world.model.requests[0].system);
  assert.match(system, /THIS IS AN IMESSAGE GROUP CHAT/);
  assert.doesNotMatch(system, /WITH GUESTS/);
  assert.match(system, /invited to this workspace and not on Context yet/);
});

test("an invited person's email goes only from a member, on that member's yes", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, { text: "Couldn't." }]);
  await tagged("", "Tex email Acme the hours");
  assert.match(toolReplies(world.model.requests.at(-1))[0], /as naming one of @seyi/);
  assert.equal(sends().length, 0);
  assert.equal(live().length, 0, "nothing is held for the binder from an invited person's turn");

  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, as: "seyi" } } }] }, { text: "Drafted it for Seyi." }]);
  const offered = await tagged("", "Tex email Acme the hours from Seyi");
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  assert.equal(offered.body.askFor, "seyi", "Seyi's yes alone sends it");
  assert.equal(sends().length, 0);
});

test("an invited person's yes or 👍 releases nothing held for the binder", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] }, verdict("yes"), { text: "Drafted." }]);
  const seyi = await tagged("seyi", "Tex email Acme the hours");
  assert.equal(seyi.status, 200, JSON.stringify(seyi.body));
  assert.equal(live().length, 1, "held for Seyi");
  const ask = seyi.body.answer;

  world.model.install([{ text: "Only Seyi can OK that." }, { text: "Only Seyi can OK that." }]);
  await tagged("", "yes");
  await tagged("", "👍", { quoted: ask, tapback: "Liked" });
  assert.equal(sends().length, 0, "an invited person's yes is nobody's");
  assert.equal(live().length, 1);
});
