/**
 * A CORRECTION NEVER LEAVES THE ASK IT CORRECTS WAITING FOR A YES.
 *
 * The case, as a person texts it:
 *
 *   Tex:    Here's the email I'd send: To: ada@… … Give it a 👍 and I'll send it.
 *   Them:   actually send it to bo instead
 *   Tex:    Got it, I'll send it to bo.          (the model did not redraft)
 *   Them:   yes
 *
 * The correction goes to the model with the ask still armed (`textedSettle.js`,
 * Dev2 2026-10-22: a side text like "one sec" must not drop the ask). The
 * model is told to make the call again "only if this text changes what it
 * should be" (`setAsideLine`). When it does, `armForText` drops the old ask.
 * When it does not, nothing does: Tex's answer asks no question, so
 * `textedAsk` leaves the ask armed, and the "yes" that follows releases the
 * email to ada, the one the person just said not to send.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPending, listPending } from "../src/tools/approvals.js";
import { settleTextedText } from "../src/agent/textedSettle.js";
import { textedAsk } from "../src/agent/textedApprovals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const ACTOR = { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts", client: "Tex" };
const SESSION = { actorUserId: ACTOR.userId };

async function askedEmailTo(store, who) {
  const record = await createPending(store, {
    name: "send_email",
    args: { to: `${who}@example.test`, subject: "Friday", body: "See you Friday." },
    actor: ACTOR,
    tier: "private",
    scopes: [],
    widening: { summary: `email ${who}`, audience: "outside" },
    detail: `To: ${who}@example.test\nSubject: Friday\n\nSee you Friday.`,
    workspaceId: ACTOR.workspaceId,
    texting: true,
    armed: false,
  });
  // The turn that drafted it put it to the person (`textedAsk` arms it).
  const { verbatim } = await textedAsk(store, SESSION, [record], "Drafted it.");
  assert.equal(verbatim.length, 1, "the ask was shown");
  return record;
}

const settle = (store, question) =>
  settleTextedText(store, SESSION, {
    dispatch: async () => ({ content: [{ type: "text", text: "" }] }),
    question,
    hasAttachments: false,
    now: Date.now(),
    timeZone: "UTC",
    defer: async () => {},
    conversation: null,
    told: [],
  });

const armed = async (store) => (await listPending(store, { userId: ACTOR.userId, texting: true })).map(({ record }) => record.args.to);

test("a correction the model does not act on leaves nothing a yes can send", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");

  // The correction is not a yes or a no, so it goes on to the model.
  const before = await settle(store, "actually send it to bo instead");
  assert.equal(before?.answer, undefined, "the correction is answered by the model, not settled");

  // The model answers without drafting again: no new ask, no question.
  await textedAsk(store, SESSION, [], "Got it, I'll send it to bo.");

  assert.deepEqual(await armed(store), [], "the email to ada is not left waiting for the next yes");
});

test("a side text that changes nothing still leaves the ask waiting", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  await settle(store, "one sec");
  await textedAsk(store, SESSION, [], "Sure, take your time.");
  assert.deepEqual(await armed(store), ["ada@example.test"], "Dev2, 2026-10-22: \"one sec\" does not drop the email");
});
