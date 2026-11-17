/**
 * A failed arm must not leave a rearm put in flight.
 *
 * `textedAsk` (`agent/textedApprovals.js`) withdraws the asks when
 * `armForText` throws. `Promise.all` rejects on the first failed put while
 * the others are still running, so one that lands after that delete arms a
 * call the person was told had been dropped. A later bare yes releases it.
 *
 * Sabotage: go back to `Promise.all` in `armForText` → the arm rejects
 * before the slow put finishes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EVERY_CHAT, armForText, createPending, listPending, withdrawPending } from "../src/tools/approvals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const ACTOR = { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts", client: "Tex" };

function texted(store, summary) {
  return createPending(store, {
    name: "send_email",
    args: { to: `${summary}@example.test` },
    actor: ACTOR,
    tier: "private",
    scopes: [],
    widening: { summary, audience: "outside" },
    detail: `To: ${summary}@example.test`,
    workspaceId: ACTOR.workspaceId,
    texting: true,
    armed: false,
  });
}

test("armForText waits for every rearm put before it rejects, so withdraw leaves nothing armed", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  const fail = await texted(store, "email ada");
  const slow = await texted(store, "email bo");
  const pending = await listPending(store, { userId: ACTOR.userId });
  const keyOf = (id) => pending.find(({ record }) => record.id === id)?.key;
  assert.equal(typeof keyOf(fail.id), "string");
  assert.equal(typeof keyOf(slow.id), "string");

  const events = [];
  let releaseSlow;
  const gate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const originalPut = store.put.bind(store);
  store.put = async (key, value, options) => {
    if (key === keyOf(fail.id)) {
      events.push("fail-put");
      throw new Error("storage put failed");
    }
    if (key === keyOf(slow.id)) {
      events.push("slow-started");
      await gate;
      events.push("slow-done");
    }
    return originalPut(key, value, options);
  };

  let failure = null;
  const arming = armForText(store, { userId: ACTOR.userId, ids: [fail.id, slow.id] }).then(
    () => {
      events.push("arm-fulfilled");
    },
    (error) => {
      failure = error;
      events.push("arm-rejected");
    },
  );

  const early = await Promise.race([
    arming.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
  assert.equal(early, "pending", `armForText settled while a rearm put was still in flight: ${events.join(" ")}`);

  releaseSlow();
  await arming;
  const slowDone = events.indexOf("slow-done");
  const armRejected = events.indexOf("arm-rejected");
  assert.ok(slowDone !== -1 && slowDone < armRejected, `the slow put must finish before the arm rejects: ${events.join(" ")}`);
  assert.equal(failure?.message, "an ask could not be armed");

  await withdrawPending(store, { userId: ACTOR.userId, ids: [fail.id, slow.id] });
  const left = await listPending(store, { userId: ACTOR.userId, texting: true, chat: EVERY_CHAT });
  assert.deepEqual(
    left.map(({ record }) => record.id),
    [],
    "withdraw after the failed arm leaves nothing a bare yes can release",
  );
});
