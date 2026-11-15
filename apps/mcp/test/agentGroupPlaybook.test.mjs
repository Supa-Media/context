/**
 * A workspace's playbook for its group chats (`src/agent/groupPlaybook.js`,
 * `docs/decisions/texting-assistant/group-playbook.md`): read every group
 * turn; Tex decides when to change it (the owner, 2026-11-05), also on a turn
 * that read an email or a file (the owner, 2026-11-15).
 *
 * Sabotage record, each fails a test here:
 *  - `readPlaybook` never called in `readGroupMemory`: "every turn is shown"
 *    (2026-10-27);
 *  - a refusal after an outside read put back: "a member's ask is saved after
 *    an outside read" (2026-11-15);
 *  - the old teaching-word regex put back: "Tex decides when" (2026-11-05);
 *  - `playbookPath` back to `tex/groups/playbook.md` for a chat with a home: "a chat with a home keeps its playbook
 *    there" (2026-11-15: every save was refused, the chat's write surface being its home).
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PLAYBOOK_PATH, playbookPath, playbookPrompt, readPlaybook } from "../src/agent/groupPlaybook.js";

const TOKEN_CHAT = `cat_group_playbook_chat_${"0".repeat(15)}`;
const KEY = "a1".repeat(32);
const MEMBERS = "b2".repeat(32);

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane, team } = world;
  await controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  controlPlane.holdRules("ws_egress_team", { etag: "rules-playbook-1", accessVersion: 1, folders: [{ prefix: "tex/groups", visibility: "team" }], notes: [] });
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  team.set(PLAYBOOK_PATH, { body: "# Playbook\n\n## Weekly hours sheet\n\nTotal hours by client. PLAYBOOK-MARKER\n", etag: "p1" });
});
after(() => world.restore());

const tagged = (question) =>
  request(world.env, TOKEN_CHAT, "/agent", { question, group: { key: KEY, members: MEMBERS, from: "seyi", people: ["seyi"] }, timeZone: "UTC" });
const bodyAt = (path) => {
  const value = world.team.get(path)?.body;
  return typeof value === "string" ? value : value === undefined ? undefined : new TextDecoder().decode(value);
};

test("every turn is shown the workspace's playbook", async () => {
  world.model.install([{ text: "Got it." }]);
  const asked = await tagged("Tex what do we do with the hours sheet?");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const system = JSON.stringify(world.model.requests[0].system);
  assert.match(system, /PLAYBOOK-MARKER/);
  assert.ok(system.includes(PLAYBOOK_PATH));
});

test("Tex decides when the playbook changes: \"store this in your memories\" is kept", async () => {
  // 2026-11-05 Tex Devs: this was refused by a word list of teaching phrases.
  const write = { name: "write_note", args: { path: PLAYBOOK_PATH, content: "# Playbook\n\n## Invoices\n\nCc Dad. PLAYBOOK-MARKER\n", expected_etag: "p1" } };
  world.model.install([{ toolCalls: [write] }, { text: "Saved." }]);
  await tagged("Tex store this in your memories");
  const reply = toolReplies(world.model.requests.at(-1))[0];
  assert.doesNotMatch(reply, /can't change|changes only when/, reply);
  assert.match(bodyAt(PLAYBOOK_PATH), /Cc Dad/);
  const system = JSON.stringify(world.model.requests[0].system);
  assert.match(system, /You decide when to add to it/);
});

test("a member's ask is saved after the turn read from outside the chat", async () => {
  // 2026-11-15 Crystal Care: "Yes and any subsequent ones" was refused because the turn before had read the referral email.
  world.team.set("tex/groups/forwarded.md", { body: "---\ntrust: untrusted\n---\n\nNew referral from Careworks\n", etag: "f1" });
  const reads = [{ name: "read_note", args: { path: "tex/groups/forwarded.md" } }, { name: "read_note", args: { path: PLAYBOOK_PATH } }];
  const content = "# Playbook\n\n## Referrals\n\nPost each new referral here. REFERRAL-MARKER\n";
  const write = (req) => ({ toolCalls: [{ name: "write_note", args: { path: PLAYBOOK_PATH, content, expected_etag: toolReplies(req).at(-1).match(/^etag: (\S+)/)[1] } }] });
  world.model.install([{ toolCalls: reads }, write, { text: "Saved." }]);
  await tagged("Tex post every new referral here from now on");
  assert.doesNotMatch(toolReplies(world.model.requests.at(-1)).at(-1), /can't change/);
  assert.match(bodyAt(PLAYBOOK_PATH), /REFERRAL-MARKER/);
});

const HOME = "tex/groups/sand-crane-coast";
/** A dispatch over `notes` (path -> body) that records what it was asked; a missing note is "not found". */
function notesDispatch(notes, asked = []) {
  return async (name, args) => {
    asked.push({ name, ...args });
    if (name !== "read_note") return { isError: true, content: [{ type: "text", text: "unexpected" }] };
    const body = notes[args.path];
    return body === undefined ? { isError: true, content: [{ type: "text", text: "not found" }] } : { content: [{ type: "text", text: `etag: e1\n\n${body}` }] };
  };
}

test("a chat with a home keeps its playbook there, and is told to write it there", async () => {
  // 2026-11-15 Crystal Care: the write to tex/groups/playbook.md was refused, the chat's write surface being its home.
  const group = { home: { folder: HOME, dispatch: notesDispatch({ [`${HOME}/playbook.md`]: "## Referrals\nPost them. HOME-MARKER" }) } };
  assert.equal(playbookPath(group), `${HOME}/playbook.md`);
  const asked = [];
  group.playbook = await readPlaybook(notesDispatch({ [PLAYBOOK_PATH]: "OLD-MARKER" }, asked), group);
  assert.match(group.playbook, /HOME-MARKER/);
  assert.deepEqual(asked, [], "the old note is not read when the home keeps one");
  const told = playbookPrompt(group);
  assert.ok(told.includes(`${HOME}/playbook.md (context: "@context-lc")`), told);
  assert.ok(!told.includes(PLAYBOOK_PATH), "never told the old shared path");
});

test("a home with no playbook yet still follows the old workspace note, and is told to save in the home", async () => {
  const group = { home: { folder: HOME, dispatch: notesDispatch({}) } };
  group.playbook = await readPlaybook(notesDispatch({ [PLAYBOOK_PATH]: "OLD-MARKER" }), group);
  assert.match(group.playbook, /OLD-MARKER/);
  assert.match(playbookPrompt(group), new RegExp(`${HOME}/playbook\\.md`));
});

test("a chat with no home reads and is told the workspace note, and a guest chat reads none", async () => {
  assert.equal(playbookPath({}), PLAYBOOK_PATH);
  assert.equal(await readPlaybook(notesDispatch({ [PLAYBOOK_PATH]: "OLD-MARKER" }), {}), "OLD-MARKER");
  assert.equal(await readPlaybook(notesDispatch({ [PLAYBOOK_PATH]: "OLD-MARKER" }), { guestChat: true, home: { folder: HOME, dispatch: notesDispatch({}) } }), "");
});
