/**
 * A group chat's routines kept in its home, `tex/groups/<words>/routines/` in `@context-lc` (the owner, 2026-11-02:
 * "we have to be able to see it in order to ... see what routines or reminders it's doing";
 * `src/agent/groupRoutines.js`, `src/agent/chatHomeSeal.js`, docs/decisions/texting-assistant/chat-routines.md).
 *
 * The turn is told to write there; a home routine needs no `chat:` line, since the control plane answers it into the
 * home's own chat; a guest chat or a tagger with no account still sets none; and a write there is reported with its
 * writer, through the home's door, for paths inside that home only.
 *
 * Sabotage record (2026-11-02), each fails a test here:
 *  - `announceRoutineChange` without `isHomeRoutinePath`: "a write in a home's routines is reported";
 *  - `attachHomeRoutineReports` without the `inChatHome` filter: "the home's door reports only its own home";
 *  - `chatRoutineRefusal` without its home early return: "a home routine needs no chat line".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { announceRoutineChange } from "../src/activity/record.js";
import { attachHomeRoutineReports, markChatHome } from "../src/agent/chatHomeSeal.js";
import { chatRoutinePrompt, chatRoutineRefusal } from "../src/agent/groupRoutines.js";

const HOME = "tex/groups/orbit-lamp-river";
const KEY = "d".repeat(64);
const group = (extra = {}) => ({ key: KEY, home: { folder: HOME }, ...extra });
const routine = "---\nat: 8:00 am\n---\nPost who is on shift today.\n";

test("a home routine needs no chat line, in every chat (2026-11-12), and someone with no account still sets none", () => {
  const args = { path: `${HOME}/routines/daily/shifts.md`, content: routine, context: "@context-lc" };
  assert.equal(chatRoutineRefusal(group(), "write_note", args), null);
  assert.equal(chatRoutineRefusal(group(), "write_note", { ...args, path: `@context-lc/${HOME}/routines/daily/shifts.md` }), null);
  // A chat that reaches no shared workspace keeps routines in its home like any chat, and only there.
  assert.equal(chatRoutineRefusal(group({ guestChat: true }), "write_note", args), null);
  assert.match(chatRoutineRefusal(group({ guestChat: true }), "write_note", { path: "tex/routines/daily/shifts.md", content: routine }), new RegExp(`${HOME}/routines/<how-often>/`));
  assert.match(chatRoutinePrompt(group({ guestChat: true })), /You can set reminders and routines for this chat/);
  assert.match(chatRoutineRefusal(group({ guestTagger: true }), "write_note", args), /on Context/);
  // Anywhere else, a routine still names its chat.
  assert.match(chatRoutineRefusal(group(), "write_note", { path: "tex/routines/daily/shifts.md", content: routine }), /chat: d{16}/);
});

test("a turn in a chat with a home is told to keep its routines there, and to pause rather than move one", () => {
  const told = chatRoutinePrompt(group());
  assert.match(told, new RegExp(`${HOME}/routines/<how-often>/<name>\\.md \\(context: "@context-lc"\\)`));
  assert.match(told, /paused: yes/);
  assert.doesNotMatch(told, /archive it/);
  assert.match(chatRoutinePrompt({ key: KEY }), /tex\/routines\/<how-often>\/<name>\.md, with chat: d{16}/);
});

test("a write in a home's routines is reported, with its writer", () => {
  const reports = [];
  const store = { actor: { userId: "user_ada" }, reportRoutineChange: (paths, who) => reports.push({ paths, who }) };
  announceRoutineChange(store, [`${HOME}/routines/daily/shifts.md`, `${HOME}/jobs.md`]);
  assert.deepEqual(reports, [{ paths: [`${HOME}/routines/daily/shifts.md`], who: "user_ada" }]);
});

test("the home's door reports only its own home, and a door to anywhere else reports nothing new", async () => {
  const sent = [];
  const controlPlane = { reportRoutineChange: async (workspaceId, userId, paths) => sent.push({ workspaceId, userId, paths }) };
  const store = {};
  attachHomeRoutineReports(store, { workspaceId: "ws_pin", chatHome: HOME }, controlPlane);
  markChatHome(store, HOME);
  await store.reportRoutineChange([`${HOME}/routines/daily/a.md`, "tex/groups/another-chat-home/routines/daily/b.md"], "user_ada");
  await store.reportRoutineChange(["tex/groups/another-chat-home/routines/daily/b.md"], "user_ada");
  assert.deepEqual(sent, [{ workspaceId: "ws_pin", userId: "user_ada", paths: [`${HOME}/routines/daily/a.md`] }]);
  const setup = {};
  attachHomeRoutineReports(setup, { workspaceId: "ws_pin" }, controlPlane);
  assert.equal(setup.reportRoutineChange, undefined);
});
