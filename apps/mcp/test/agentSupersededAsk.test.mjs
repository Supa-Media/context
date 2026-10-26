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
 *
 * Fixed by `claimCheck.js` rule 6: an answer that talks as if the waiting ask
 * changed, with nothing held again, gets one more round to make the call with
 * the change; if it still says it changed and holds nothing, `textedAsk` drops
 * the old ask and says so. Dev2's "one sec" rule still holds.
 *
 * Sabotage (temporary local edits, reverted):
 *  - rule 6 removed from `firstNotice`: "a correction gets one more round" fails;
 *  - `dropStale` not disarming: "a correction the model does not act on" fails;
 *  - `stale` keyed on `talksOfTheWaiting` instead of `saysItChanged`: "an
 *    aside answered with I'll send it" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPending, listPending } from "../src/tools/approvals.js";
import { settleTextedText } from "../src/agent/textedSettle.js";
import { textedAsk } from "../src/agent/textedApprovals.js";
import { SUPERSEDE_NOTICE, claimCheck } from "../src/agent/claimCheck.js";
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

/** One texted turn after the person's text: the check, each round's answer, and what the turn held. */
async function turn(store, question, answers, { holds = null } = {}) {
  const settled = await settle(store, question);
  const claims = claimCheck({ question, waiting: (settled?.setAside ?? []).length > 0 });
  const call = claims.wrap(async () => (holds === null ? { content: [] } : { held: true }));
  const notices = [];
  let answer;
  for (const said of answers) {
    answer = said;
    if (holds !== null && said === holds.after) await call("write", {});
    const notice = await claims.check(said);
    notices.push(notice);
    if (notice === null) break;
  }
  return { settled, claims, answer, notices };
}

test("a correction the model does not act on leaves nothing a yes can send", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");

  const { settled, claims, answer, notices } = await turn(store, "actually send it to bo instead", [
    "Got it, I'll send it to bo instead.",
    "Done, I've changed it to bo instead.",
  ]);
  assert.equal(settled?.answer, undefined, "the correction is answered by the model, not settled");
  assert.equal(notices[0], SUPERSEDE_NOTICE, "a correction gets one more round to make the call with the change");
  assert.equal(claims.stale(answer), true, "still said changed, still nothing held");

  const { ask } = await textedAsk(store, SESSION, [], answer, { stale: claims.stale(answer) });
  assert.match(ask, /haven't sent the earlier one \(email ada\)/, "the person is told the old one is dropped");
  assert.deepEqual(await armed(store), [], "the email to ada is not left waiting for the next yes");
});

test("a correction redrafted on the second round leaves only the new ask", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  const second = "Drafted it to bo.";
  const { claims, answer, notices } = await turn(store, "actually send it to bo instead", ["Got it, I'll send it to bo instead.", second], {
    holds: { after: second },
  });
  assert.equal(notices[0], SUPERSEDE_NOTICE);
  assert.equal(claims.stale(answer), false, "a turn that held the change is not stale");
  // The redraft is the new ask, which drops the old one (`armForText`).
  await askedEmailTo(store, "bo");
  assert.deepEqual(await armed(store), ["bo@example.test"]);
});

test("an aside answered with \"I'll send it\" never loses the ask", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  const { claims, answer } = await turn(store, "one sec", ["No rush, I'll send it once you give it a 👍.", "No rush, I'll send it when you're ready."]);
  assert.equal(claims.stale(answer), false);
  await textedAsk(store, SESSION, [], answer, { stale: claims.stale(answer) });
  assert.deepEqual(await armed(store), ["ada@example.test"], "Dev2, 2026-10-22: an aside keeps the ask");
});

test("dropping one person's corrected ask leaves another person's alone", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  const other = { ...ACTOR, userId: "user_b" };
  const theirs = await createPending(store, {
    name: "send_email",
    args: { to: "cy@example.test" },
    actor: other,
    tier: "private",
    scopes: [],
    widening: { summary: "email cy", audience: "outside" },
    detail: "To: cy@example.test",
    workspaceId: ACTOR.workspaceId,
    texting: true,
    armed: false,
  });
  await textedAsk(store, { actorUserId: other.userId }, [theirs], "Drafted it.");
  await textedAsk(store, SESSION, [], "Changed it to bo instead.", { stale: true });
  assert.deepEqual(await armed(store), [], "user_a's ask is dropped");
  const left = (await listPending(store, { userId: other.userId, texting: true })).map(({ record }) => record.args.to);
  assert.deepEqual(left, ["cy@example.test"], "another person's ask in the same chat stands");
});
test("a side text that changes nothing still leaves the ask waiting", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  await settle(store, "one sec");
  await textedAsk(store, SESSION, [], "Sure, take your time.");
  assert.deepEqual(await armed(store), ["ada@example.test"], "Dev2, 2026-10-22: \"one sec\" does not drop the email");
});
