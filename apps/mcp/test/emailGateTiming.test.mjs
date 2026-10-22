/**
 * The Mail checker reads while the control plane checks the limits
 * (2026-10-22: one after the other they ran past a turn's limit for a call, so
 * an email was neither held nor shown, three times over, and the person was
 * told it "timed out" each time).
 *
 * Sabotage: await the checker after the limits again → this fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emailGate } from "../src/tools/emailGate.js";

// One after the other, the limits would wait on the checker forever: the test times out.
test("the Mail checker starts before the limits answer, so a slow pair is not twice as slow", { timeout: 5_000 }, async () => {
  const events = [];
  let releaseCheck;
  const checkAnswered = new Promise((resolve) => (releaseCheck = resolve));
  const store = {
    actor: { userId: "user_1" },
    get: async () => null,
    put: async () => ({ etag: "e1" }),
    list: async () => ({ objects: [], truncated: false }),
    delete: async () => {},
    email: {
      check: async () => {
        events.push("check asked");
        await checkAnswered;
        events.push("check answered");
        return { ok: true, from: "me@example.com" };
      },
    },
  };
  const session = {
    actorUserId: "user_1",
    actorClientId: "context_texts",
    workspaceId: "ws_1",
    scope: "private",
    scopes: [],
    egress: { texting: true, ledger: { asked: [] } },
    mailChecker: async () => {
      events.push("checker asked");
      releaseCheck();
      return { verdict: "no", reason: "a test" };
    },
  };
  const result = await emailGate({ to: "jo@example.com", subject: "Hi", body: "Hello Jo" }, { store, session, target: { workspaceId: "ws_1" } });
  assert.equal(result?.isError, true);
  assert.ok(events.indexOf("checker asked") < events.indexOf("check answered"));
});
