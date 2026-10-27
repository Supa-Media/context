/**
 * Routines set from a group chat (the owner, 2026-10-27;
 * `src/agent/groupRoutines.js`,
 * `docs/decisions/texting-assistant/chat-routines.md`).
 *
 * A routine in a shared workspace runs only when it names the chat it answers
 * into, so one written from a chat must carry this chat's id, and a guest chat
 * or a tagger with no account sets none.
 *
 * Sabotage record (2026-10-27), each fails a test here:
 *  - dropping the `chat:` check in `chatRoutineRefusal`: "a routine naming
 *    another chat, or none, is refused";
 *  - dropping the `guestTagger` refusal: "somebody with no account sets no
 *    routine".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, toolReplies } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const TOKEN_CHAT = `cat_group_routines_chat_${"0".repeat(16)}`;
const KEY = "d".repeat(64);
const ID = "d".repeat(16);
const MEMBERS = "c".repeat(64);
const routine = (chat) => `---\nat: 8:00 am\n${chat ? `chat: ${chat}\n` : ""}---\nPost who is on shift today.\n`;

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  await controlPlane.addGrant({
    accessToken: TOKEN_CHAT,
    workspaceId: "ws_egress_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_egress",
  });
  controlPlane.holdRules("ws_egress_team", { etag: "rules-routines-1", accessVersion: 1, folders: [{ prefix: "tex", visibility: "team" }], notes: [] });
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
});
after(() => world.restore());

const chat = (from) => ({ key: KEY, members: MEMBERS, from, people: ["seyi"] });
const tagged = (from, question) => request(world.env, TOKEN_CHAT, "/agent", { question, group: chat(from), timeZone: "UTC" });
const saved = (path) => {
  const entry = world.team.get(path);
  return entry !== undefined && !String(entry.body ?? "").startsWith("context.logical-delete");
};

test("a member's routine for this chat is saved, and the turn is told how", async () => {
  world.model.install([{ toolCalls: [{ name: "write_note", args: { path: "tex/routines/daily/shifts.md", content: routine(ID) } }] }, { text: "Will do." }]);
  const asked = await tagged("seyi", "Tex every morning at 8 post who is on shift");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.doesNotMatch(toolReplies(world.model.requests.at(-1))[0], /Not saved|can't be set/);
  assert.ok(saved("tex/routines/daily/shifts.md"), "the routine was written");
  assert.match(JSON.stringify(world.model.requests[0].system), new RegExp(`chat: ${ID}`));
});

test("a routine naming another chat, or none, is refused", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "write_note", args: { path: "tex/routines/daily/other.md", content: routine("0123456789abcdef") } },
        { name: "write_note", args: { path: "tex/routines/weekly/none.md", content: routine(null) } },
      ],
    },
    { text: "Couldn't." },
  ]);
  await tagged("seyi", "Tex remind us weekly");
  const [other, none] = toolReplies(world.model.requests.at(-1));
  assert.match(other, new RegExp(`Put chat: ${ID}`));
  assert.match(none, new RegExp(`Put chat: ${ID}`));
  assert.ok(!saved("tex/routines/daily/other.md") && !saved("tex/routines/weekly/none.md"));
});

test("somebody with no account sets no routine", async () => {
  world.model.install([{ toolCalls: [{ name: "write_note", args: { path: "tex/routines/daily/invited.md", content: routine(ID) } }] }, { text: "Can't." }]);
  await tagged("", "Tex post the schedule every day");
  assert.match(toolReplies(world.model.requests.at(-1))[0], /Only someone here who is on Context/);
  assert.ok(!saved("tex/routines/daily/invited.md"));
});

test("a chat with shared mail is told a routine can wake on new mail; one without is not", async () => {
  const { chatRoutinePrompt } = await import("../src/agent/groupRoutines.js");
  const key = "e".repeat(64);
  assert.match(chatRoutinePrompt({ key, mail: [{ handle: "seyi", address: "seyi@work.example" }] }), /wake: new mail/);
  assert.doesNotMatch(chatRoutinePrompt({ key }), /wake: new mail/);
});
