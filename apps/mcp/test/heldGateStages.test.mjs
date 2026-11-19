/**
 * A held email or calendar change carries the clock of each stage it took
 * (`stages`), so a slow held call can be read off the turn's trace
 * (`turnTiming.js`). The forward email's read starts with the Mail checker,
 * before the control plane's check, and the held text stays as it was.
 *
 * Sabotage: move the forward read back after `store.email.check` (the
 * `readForward` call below the room check) → "the forward read starts before
 * the room check answers" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emailGate } from "../src/tools/emailGate.js";
import { calendarGate } from "../src/tools/calendarGate.js";
import { REFUSED } from "../src/tools/email.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const HELD_TEXT =
  "Held for their 👍, and nothing failed: right after your answer they are texted this exact email and asked " +
  "for their 👍, and it sends then. Say in one short line what you drafted. Don't repeat the email, don't give " +
  "them a copy to send themselves, and don't call send_email again in this turn.";

const FORWARD = { to: ["jo@example.com"], subject: "Fwd", body: "Passing this on.", forward: "email:me@example.com/Msg_1" };

function texting(mailChecker = async () => ({ verdict: "unsure", reason: "" })) {
  return { actorUserId: "user_1", actorClientId: "context_texts", workspaceId: "ws_1", scope: "private", scopes: [], egress: { texting: true, ledger: { asked: [] } }, mailChecker };
}

const isSettled = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

test("a held forward starts its read before the room check answers, and keeps its text and stages", { timeout: 5_000 }, async () => {
  const store = createMemoryStore();
  store.actor = { userId: "user_1" };
  const events = [];
  let readStarted;
  const readCalled = new Promise((resolve) => (readStarted = resolve));
  store.email = {
    check: async () => {
      // Waits for the read, but not for ever: a reorder fails the assertion below, not the timeout.
      await Promise.race([readCalled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      events.push({ check: "answered", readBefore: events.some((e) => e.read === "asked") });
      return { ok: true, from: "me@example.com" };
    },
    read: async (address, messageId) => {
      events.push({ read: "asked", address, messageId });
      readStarted();
      return { ok: true, message: { from: "Jo <jo@example.com>", subject: "Thursday", attachments: [] } };
    },
  };
  const session = texting();
  const result = await emailGate(FORWARD, { store, session, target: { workspaceId: "ws_1" } });
  assert.equal(result?.held, true);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, HELD_TEXT);
  assert.deepEqual(events.find((e) => e.read === "asked"), { read: "asked", address: "me@example.com", messageId: "Msg_1" });
  assert.equal(events.find((e) => e.check === "answered")?.readBefore, true, "the forward read starts before the room check answers");
  for (const key of ["checker", "check", "read", "pending"]) assert.ok(isSettled(result.stages?.[key]), `stages.${key} is a whole, non-negative number`);
  assert.deepEqual(Object.keys(result.stages).sort(), ["check", "checker", "pending", "read"]);
});

test("a room refusal on a forward keeps its text, and a read that rejects is caught, never unhandled", async () => {
  const store = createMemoryStore();
  store.actor = { userId: "user_1" };
  store.email = {
    check: async () => ({ ok: false, refused: "daily_limit" }),
    read: async () => {
      throw new Error("mailbox went away");
    },
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await emailGate(FORWARD, { store, session: texting(), target: { workspaceId: "ws_1" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(result.content[0].text, REFUSED.daily_limit);
    assert.equal(result.isError, true);
    assert.ok(isSettled(result.stages?.check));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a forward whose email Gmail no longer has is refused with the same text as before", async () => {
  const store = createMemoryStore();
  store.actor = { userId: "user_1" };
  store.email = {
    check: async () => ({ ok: true, from: "me@example.com" }),
    read: async () => ({ ok: false, refused: "not_found" }),
  };
  const result = await emailGate(FORWARD, { store, session: texting(), target: { workspaceId: "ws_1" } });
  assert.equal(result.content[0].text, REFUSED.forward_not_found);
  assert.equal(result.isError, true);
  assert.equal(result.held, undefined);
  assert.ok(isSettled(result.stages?.read));
});

test("a held calendar change that would tell a guest carries stages.check and stages.pending", async () => {
  const store = createMemoryStore();
  store.actor = { userId: "user_1" };
  store.calendar = { check: async () => ({ ok: true, guests: ["Blessing Aodu"] }) };
  const session = { actorUserId: "user_1", actorClientId: "claude_client", workspaceId: "ws_1", scope: "private", scopes: [], egress: {} };
  const move = { action: "move", title: "Sayo / Seyi", start: "2026-10-22T19:00:00-04:00", new_start: "2026-10-22T21:00:00-04:00", new_end: "2026-10-22T22:00:00-04:00" };
  const result = await calendarGate(move, { store, session, target: { workspaceId: "ws_1" } });
  assert.equal(result?.held, true);
  assert.ok(isSettled(result.stages?.check));
  assert.ok(isSettled(result.stages?.pending));
  assert.deepEqual(Object.keys(result.stages).sort(), ["check", "pending"]);
});
