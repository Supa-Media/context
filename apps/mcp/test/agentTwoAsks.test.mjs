/**
 * ONE ASK LINE IS ARMED AT A TIME, NOW THAT TWO TURNS CAN RUN AT ONCE.
 *
 * `settleByText` releases every armed record on one bare yes, and says why:
 * "Every record left armed was asked in the thread's latest ask, and the ask
 * line named all of them, so one yes answers all of them." That held while
 * one turn ran at a time: any text that went to the model disarmed what came
 * before it (`textedSettle.js`), so the latest ask was the only armed one.
 *
 * A background job's turn (`agent/background.js`) does not go through
 * `settleTextedText` — it is not the person's text — but it does reach
 * `textedAsk`. So a job that asks for a yes used to arm its ask *beside* the
 * chat's, and one "yes" released both: two emails sent where the person
 * answered one ask.
 *
 * `armForText` now disarms what this ask does not name, which is the rule the
 * person's own next text already applied. An earlier ask is still theirs to
 * answer in the Context app; it just stops being a thing a bare yes reaches.
 *
 * Sabotage: drop the disarm in `armForText` → "a later ask leaves no earlier
 * one armed" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { armForText, createPending, listPending } from "../src/tools/approvals.js";
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

const armedIds = async (store) =>
  (await listPending(store, { userId: ACTOR.userId, texting: true })).map(({ record }) => record.id).sort();

test("a later ask leaves no earlier one armed, so one yes answers one ask line", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };

  // The chat's own turn asks about one email.
  const chat = await texted(store, "email ada");
  await armForText(store, { userId: ACTOR.userId, ids: [chat.id] });
  assert.deepEqual(await armedIds(store), [chat.id], "the chat's ask is armed");

  // A background job's turn asks about another. It never runs settleTextedText.
  const job = await texted(store, "email bo");
  await armForText(store, { userId: ACTOR.userId, ids: [job.id] });
  assert.deepEqual(await armedIds(store), [job.id], "only the latest ask line is armed");

  // Both are still waiting for the app; only the bare-yes route narrowed.
  const waiting = (await listPending(store, { userId: ACTOR.userId })).map(({ record }) => record.id).sort();
  assert.deepEqual(waiting, [chat.id, job.id].sort(), "neither ask was dropped");
});

test("one ask line naming two records arms both of them", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  const first = await texted(store, "email ada");
  const second = await texted(store, "email bo");
  await armForText(store, { userId: ACTOR.userId, ids: [first.id, second.id] });
  assert.deepEqual(await armedIds(store), [first.id, second.id].sort(), "an ask that named both leaves both armed");
});
