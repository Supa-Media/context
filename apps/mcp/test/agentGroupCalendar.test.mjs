/**
 * Calendars shared with a group chat (Dev2, 2026-11-19; `src/agent/groupCalendar.js`).
 *
 * The control plane decides every read (`apps/convex/__tests__/textGroupCalendar.test.ts`); this file proves the
 * gateway keeps the calendars the Worker names, tells the turn whose they are, and tells a chat with none that nothing
 * is shared and how its own person shares it.
 *
 * Sabotage record (2026-11-19), each fails a test here:
 *  - `groupOf` dropping `calendar`: "groupOf keeps the shared calendars the Worker names";
 *  - `chatCalendarOf` keeping a malformed entry: "a malformed calendar entry is dropped";
 *  - `groupPrompt` leaving out `chatCalendarPrompt`: "the turn is told whose calendar it can read".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chatCalendarOf, chatCalendarPrompt } from "../src/agent/groupCalendar.js";
import { groupOf, groupPrompt } from "../src/agent/groupTurn.js";

const KEY = "a".repeat(64);
const MEMBERS = "b".repeat(64);
const shared = [{ handle: "kofi", address: "kofi@example.com" }];

test("groupOf keeps the shared calendars the Worker names", () => {
  const group = groupOf({ group: { key: KEY, members: MEMBERS, from: "john", calendar: shared } });
  assert.deepEqual(group.calendar, shared);
  assert.equal(groupOf({ group: { key: KEY, members: MEMBERS, from: "john" } }).calendar, undefined);
});

test("a malformed calendar entry is dropped", () => {
  assert.deepEqual(chatCalendarOf([...shared, { handle: "Bad Handle", address: "x@y.z" }, { handle: "ok", address: "not-an-address" }, null]), shared);
  assert.deepEqual(chatCalendarOf("kofi@example.com"), []);
});

test("the turn is told whose calendar it can read, and to ask about a clash rather than guess", () => {
  const words = groupPrompt(groupOf({ group: { key: KEY, members: MEMBERS, from: "john", calendar: shared } }), "truck");
  assert.match(words, /calendars shared with it: @kofi's kofi@example\.com/);
  assert.match(words, /read_calendar \(account: the address\)/);
  assert.match(words, /ask the person it belongs to which is right/);
});

test("a chat with no calendar shared is told so, and how its own person shares one", () => {
  const words = chatCalendarPrompt({});
  assert.match(words, /Nobody's calendar is shared with this chat yet/);
  assert.match(words, /chat_share_calendar/);
});
