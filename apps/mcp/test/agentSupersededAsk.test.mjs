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
 * Dev2 2026-10-22: a side text like "one sec" must not drop the ask). On main
 * nothing dropped it when the model did not draft again, so the "yes" sent the
 * email to ada, the one the person had just said not to send.
 *
 * Fixed by `claimCheck.js` rule 6, judged on the person's own words
 * (`correctsTheAsk`): a correction with nothing held gets one more round to
 * make the call with the change, and a turn that still holds nothing drops
 * exactly the asks it corrected (`textedAsk` `stale`), saying so.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `stale` always false: "a correction the model does not act on" fails;
 *  - `dropStale` dropping every armed ask instead of the corrected ids: "only
 *    the corrected ask is dropped" fails;
 *  - `CORRECTION` matching any text: "a side text never touches the ask" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPending, listPending } from "../src/tools/approvals.js";
import { settleTextedText } from "../src/agent/textedSettle.js";
import { askLine, textedAsk, thumbsUpIsYes } from "../src/agent/textedApprovals.js";
import { SUPERSEDE_NOTICE, claimCheck, correctsTheAsk } from "../src/agent/claimCheck.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const ACTOR = { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts", client: "Tex" };
const SESSION = { actorUserId: ACTOR.userId };

function pendingEmailTo(store, who, actor = ACTOR) {
  return createPending(store, {
    name: "send_email",
    args: { to: `${who}@example.test`, subject: "Friday", body: "See you Friday." },
    actor,
    tier: "private",
    scopes: [],
    widening: { summary: `email ${who}`, audience: "outside" },
    detail: `To: ${who}@example.test\nSubject: Friday\n\nSee you Friday.`,
    workspaceId: actor.workspaceId,
    texting: true,
    armed: false,
  });
}

/** An email drafted and put to the person (`textedAsk` arms it). */
async function askedEmailTo(store, who, session = SESSION, actor = ACTOR) {
  const record = await pendingEmailTo(store, who, actor);
  const { verbatim } = await textedAsk(store, session, [record], "Drafted it.");
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

const armed = async (store, userId = ACTOR.userId) =>
  (await listPending(store, { userId, texting: true })).map(({ record }) => record.args.to).sort();

/**
 * One texted turn after the person's text, as `route.js` runs it: the check on
 * each round's answer, then `textedAsk` with what the turn held.
 */
async function turn(store, question, answers, { holdsOn = null } = {}) {
  const settled = await settle(store, question);
  const setAside = settled?.setAside ?? [];
  const claims = claimCheck({ question, waiting: setAside.length > 0, corrects: correctsTheAsk(question, setAside) });
  const call = claims.wrap(async () => ({ held: true }));
  const notices = [];
  let answer;
  for (const said of answers) {
    answer = said;
    if (said === holdsOn) await call("write", {});
    const notice = await claims.check(said);
    notices.push(notice);
    if (notice === null) break;
  }
  const stale = claims.stale() ? setAside.map((entry) => entry.id) : null;
  const { ask } = await textedAsk(store, SESSION, [], answer, { stale });
  return { settled, notices, ask, stale };
}

test("a correction the model does not act on leaves nothing a yes can send", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  const ada = await askedEmailTo(store, "ada");

  const { settled, notices, ask } = await turn(store, "actually send it to bo instead", [
    "Got it, I'll send it to bo.",
    "Sure, bo it is.",
  ]);
  assert.equal(settled?.answer, undefined, "the correction is answered by the model, not settled");
  assert.equal(notices[0], SUPERSEDE_NOTICE, "a correction gets one more round to make the call with the change");
  assert.match(ask, /haven't sent the earlier one \(email ada\)/, "the person is told the old one is dropped");
  assert.deepEqual(await armed(store), [], "the email to ada is not left waiting for the next yes");

  const liked = await thumbsUpIsYes(store, SESSION, { tapback: "Liked", words: askLine([ada]) });
  assert.equal(liked, false, "a 👍 on the old ask after the drop sends nothing");
});

test("a correction answered with a question drops the old ask and keeps the question", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  const { notices, ask, stale } = await turn(store, "yes but send it to Sam", ["Which Sam, the one at Acme?"]);
  assert.notEqual(notices[0], SUPERSEDE_NOTICE, "a question waits on them, not on another round");
  assert.notEqual(stale, null);
  assert.match(ask, /haven't sent the earlier one/);
  assert.deepEqual(await armed(store), [], "and the email to ada is not left waiting");
});

test("a correction redrafted on the second round leaves only the new ask", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  await askedEmailTo(store, "ada");
  const second = "Drafted it to bo.";
  const { notices, stale } = await turn(store, "actually send it to bo instead", ["Got it.", second], { holdsOn: second });
  assert.equal(notices[0], SUPERSEDE_NOTICE);
  assert.equal(stale, null, "a turn that held the change drops nothing itself");
  // The redraft is the new ask, which drops the old one (`armForText`).
  await askedEmailTo(store, "bo");
  assert.deepEqual(await armed(store), ["bo@example.test"]);
});

test("a side text never touches the ask, whatever the model answers", async () => {
  for (const [question, answer] of [
    ["one sec", "No rush, I'll send it when you're ready."],
    ["add milk to my list", "Updated your list. The email to ada is still waiting."],
    ["not now", "Okay, it'll wait."],
    ["thanks", "Changed nothing, it's still waiting."],
  ]) {
    const store = createMemoryStore();
    store.actor = { ...ACTOR };
    await askedEmailTo(store, "ada");
    const { notices, stale } = await turn(store, question, [answer]);
    assert.notEqual(notices[0], SUPERSEDE_NOTICE, question);
    assert.equal(stale, null, question);
    assert.deepEqual(await armed(store), ["ada@example.test"], `Dev2, 2026-10-22: "${question}" keeps the ask`);
  }
});

test("which texts correct a waiting ask", () => {
  const waiting = [{ id: "p1", tool: "send_email", summary: "email ada", args: { to: "ada@example.test" } }];
  for (const text of ["actually send it to bo", "send it to bo instead", "make it Friday", "cc jo too", "no, wrong person", "bo@example.test please", "yes but send it to Sam"]) {
    assert.equal(correctsTheAsk(text, waiting), true, text);
  }
  for (const text of ["one sec", "thanks", "not now", "add milk to my list", "what time is it in London?", "ada@example.test is right"]) {
    assert.equal(correctsTheAsk(text, waiting), false, text);
  }
  assert.equal(correctsTheAsk("actually send it to bo", []), false, "nothing waiting, nothing to correct");
});

test("only the corrected ask is dropped, and another person's stands", async () => {
  const store = createMemoryStore();
  store.actor = { ...ACTOR };
  // Two asks of this person's on one ask line, and one of someone else's in the same chat.
  const ada = await pendingEmailTo(store, "ada");
  const cy = await pendingEmailTo(store, "cy");
  await textedAsk(store, SESSION, [ada, cy], "Drafted both.");
  const other = { ...ACTOR, userId: "user_b" };
  await askedEmailTo(store, "dee", { actorUserId: other.userId }, other);

  await textedAsk(store, SESSION, [], "Changed it.", { stale: [ada.id] });
  assert.deepEqual(await armed(store), ["cy@example.test"], "the ask not corrected still waits");
  assert.deepEqual(await armed(store, other.userId), ["dee@example.test"], "another person's ask stands");
});

test("an ask that cannot be dropped is said to be still waiting, never said gone", async () => {
  const base = createMemoryStore();
  base.actor = { ...ACTOR };
  const ada = await askedEmailTo(base, "ada");
  // A store whose deletes and conditional rewrites both fail.
  const stuck = Object.create(base);
  stuck.delete = async () => {
    throw new Error("delete failed");
  };
  stuck.put = async (key, value, options) => (options?.onlyIf ? null : base.put(key, value, options));
  const { ask } = await textedAsk(stuck, SESSION, [], "Changed it.", { stale: [ada.id] });
  assert.match(ask, /couldn't withdraw the earlier one/, ask);
  assert.doesNotMatch(ask, /nothing goes out/);
});
