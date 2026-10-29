/**
 * REPLAYS OF THE WAYS TEX LOST TRACK OF A CONVERSATION (2026-10-29).
 *
 * The texts below are written for these tests and follow the shape of the
 * failures. A browser stopped on a passkey page, and Tex kept asking for an
 * approval the person said never came. A pre-send check took "Google" for a
 * calendar, and Tex answered that check's note as if the person had written
 * it. An hourly check nobody asked for was set while the sign-in was still
 * blocked. And after the person turned down a method, Tex dropped the goal
 * along with it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   "google" put back in `CALENDAR_WORDS` → "a passkey answer never draws the
 *     calendar notice" fails.
 *   `recheckNote` returning `notice + RECHECK_REPLACES` (the old shape) → "a
 *     notice says it is Context's, not theirs" fails.
 *   The "prompt" check dropped from `replyChecks` → "a prompt they said never
 *     came is not asked for again" fails.
 *   The "goal" check dropped from `replyChecks` → "turning down a way keeps
 *     the goal" fails.
 *   The `builtFormLink` line removed from `browse.js` → "a form editor
 *     address built from the published link is refused" fails.
 *   The passkey line removed from `readingText` → "a passkey page tells the
 *     model to pick another way" fails.
 *   `|| pair === repliedTo` removed from `threadView` → "a reply typed under
 *     a check-in is shown the check-in it answers" fails.
 *   `heartbeat.js` keeping a continued check-in with `thread: null` → "a look
 *     sent under an earlier text is kept in that text's thread"
 *     (`agentHeartbeat.test.mjs`) fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { browserSession } from "../src/agent/browse.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { LATER_NOTICE } from "../src/agent/otherRoutes.js";
import { BUILT_FORM_LINK_ERROR, PASSKEY_LINE, builtFormLink, passkeyLine } from "../src/agent/pageWalls.js";
import { RECHECK_FROM, recheckNote } from "../src/agent/recheck.js";
import { TRY_CLAIM_NOTICE, claimsCalendarTry, replyChecks } from "../src/agent/replyChecks.js";
import { GOAL_NOTICE, NO_PROMPT_NOTICE, dropsTheGoal, repeatsUnarrivedPrompt } from "../src/agent/stuckAsks.js";
import { runTurn } from "../src/agent/turn.js";

const NO_PROMPT = "no prompt showed up on my phone";
const DID_YOU_REQUEST = "still no prompt here, did you actually send one?";
const NO_NOTIFICATION = "hello?? im nit getting any notification on anything";

const APPROVE_AGAIN = [
  "The sign-in is still waiting on your passkey. Open the prompt on your phone for sam@example.com and approve it.",
  "Approve the passkey prompt for sam@example.com on whichever device has it, then text me \"done\".",
  "It goes to whichever device holds the passkey, so check your phone, tablet or laptop.",
];

test("a passkey answer never draws the calendar notice; a real calendar claim still does", () => {
  for (const draft of [
    "I tried again and Google still refused the sign-in. It wants a passkey approval for sam@example.com.",
    "I tried the sign-in again and Google rejected it without the passkey.",
  ]) {
    assert.equal(claimsCalendarTry(draft, [{ name: "browse", ok: true }]), false, draft);
  }
  assert.equal(claimsCalendarTry("I tried again and Google Calendar refused it.", []), true);
  assert.equal(claimsCalendarTry("I tried adding the event again and it failed.", []), true);
  const check = replyChecks({ question: NO_PROMPT });
  assert.notEqual(check("I tried again and Google still refused the sign-in.", [{ name: "browse", ok: true }]), TRY_CLAIM_NOTICE);
});

test("a prompt they said never came is not asked for again", () => {
  for (const question of [NO_PROMPT, DID_YOU_REQUEST, NO_NOTIFICATION, "never got the code", "nothing came through"]) {
    for (const draft of APPROVE_AGAIN) assert.equal(repeatsUnarrivedPrompt(question, draft), true, `${question} / ${draft}`);
  }
  // Their text says nothing about a prompt: asking them to approve one is a first ask.
  assert.equal(repeatsUnarrivedPrompt("how many people filled in the signup form?", APPROVE_AGAIN[0]), false);
  // Changing approach is the answer wanted.
  assert.equal(repeatsUnarrivedPrompt(NO_PROMPT, "I switched to \"Try another way\" and Google texted a code to your phone. Send it to me."), false);
  const check = replyChecks({ question: NO_PROMPT });
  assert.equal(check(APPROVE_AGAIN[0]), NO_PROMPT_NOTICE);
  assert.equal(check(APPROVE_AGAIN[0]), null, "once a turn");
  assert.match(NO_PROMPT_NOTICE, /never ask them to approve one/);
});

test("turning down a way keeps the goal", () => {
  const question = "im not doing a manual step every night just to send you this, too much work";
  const draft = "Fair enough.\n\nI've left the laptop out of your tracking log and noted that laptop time isn't tracked.";
  assert.equal(dropsTheGoal(question, draft), true);
  assert.equal(replyChecks({ question })(draft), GOAL_NOTICE);
  // A way that runs by itself keeps the goal.
  assert.equal(dropsTheGoal(question, "Fair. Your laptop can email its usage report each night by itself; I'll log it when it lands."), false);
  // Dropping what they themselves let go of is not this.
  assert.equal(dropsTheGoal("skip the conference", "Okay, I'll drop the conference unless you bring it up."), false);
  assert.match(GOAL_NOTICE, /never one they already turned down/);
});

test("a notice says it is Context's, not theirs, and that the draft never went", async () => {
  assert.ok(recheckNote(TRY_CLAIM_NOTICE).startsWith(RECHECK_FROM));
  assert.match(RECHECK_FROM, /not a text from them/);
  assert.match(RECHECK_FROM, /have not seen your draft/);
  const MAIN = "@cf/acme/main-model";
  const calls = [];
  const replies = ["I tried again and Google Calendar refused it.", "Done."];
  const ai = {
    async run(model, input) {
      calls.push(input.messages);
      return { choices: [{ message: { content: replies.shift(), tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
  const claims = claimCheck({ question: "add tabi's birthday to my calendar" });
  await runTurn({
    question: "add tabi's birthday to my calendar",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(async () => ({ content: [] })),
  });
  const notice = calls[1].at(-1);
  assert.equal(notice.role, "user");
  assert.ok(String(notice.content).startsWith(RECHECK_FROM), "the gateway's note is marked before the person could be taken to have written it");
});

test("a promise to text later offers to set nothing when it's blocked on them or unasked (the hourly form check)", () => {
  assert.match(LATER_NOTICE, /didn't ask to be told later/);
  assert.match(LATER_NOTICE, /set nothing/);
});

test("a form editor address built from the published link is refused", async () => {
  const published = "https://docs.google.com/forms/d/e/1FAIpQLSf0aKe1d/viewform";
  for (const built of [
    "https://docs.google.com/forms/d/1FAIpQLSf0aKe1d/edit",
    "https://docs.google.com/forms/d/1FAIpQLSf0aKe1d/edit#responses",
    "https://docs.google.com/forms/d/e/1FAIpQLSf0aKe1d/edit",
    "https://docs.google.com/forms/u/0/d/1FAIpQLSf0aKe1d/responses",
  ]) {
    assert.equal(builtFormLink(built), true, built);
  }
  assert.equal(builtFormLink(published), false, "the published link itself opens");
  assert.equal(builtFormLink("https://docs.google.com/forms/d/1aBcEditId_x9/edit"), false, "a real editor id");
  const browser = browserSession(
    { browse: async () => { throw new Error("never opened"); } },
    { allowed: { has: () => true, add() {}, webIsOpen: () => true, trust() {}, openWeb() {} }, addresses: published, takePages: () => true },
  );
  const result = await browser.call({ steps: [{ do: "goto", url: "https://docs.google.com/forms/d/1FAIpQLSf0aKe1d/edit" }] });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, BUILT_FORM_LINK_ERROR);
});

test("a passkey page tells the model to pick another way", async () => {
  assert.equal(passkeyLine("Complete sign-in using your passkey\nTry another way"), PASSKEY_LINE);
  assert.equal(passkeyLine("Enter your password"), "");
  const url = "https://accounts.google.com/v3/signin/challenge/pk";
  const browser = browserSession(
    {
      browse: async (session, steps) => ({
        session: "bb-session-0002",
        page: { url, title: "Sign in", text: "Use your passkey to confirm it's really you\nComplete sign-in using your passkey\nTry another way", elements: [] },
        ran: steps.map((step) => ({ do: step.do, ok: true })),
      }),
    },
    { allowed: { has: () => true, add() {}, webIsOpen: () => true, trust() {}, openWeb() {} }, addresses: url, takePages: () => true },
  );
  const result = await browser.call({ steps: [{ do: "goto", url }] });
  assert.ok(result.content[0].text.includes(PASSKEY_LINE), result.content[0].text);
});

test("a recurring check described with a date never draws a calendar notice", async () => {
  for (const draft of [
    "I've set a check each hour through Oct 30. Once the form opens, it texts you the total sign-ups.",
    "The hourly check is set through Nov 4 and texts you once the responses open.",
    "I tried again and Google still won't take the sign-in.",
  ]) {
    const check = claimCheck({ question: "how many people filled in the signup form?" });
    const wrapped = check.wrap(async () => ({ content: [{ type: "text", text: "ok" }] }));
    await wrapped("browse", {});
    for (let round = 0; round < 8; round += 1) {
      const notice = await check.check(draft);
      if (notice === null) break;
      assert.doesNotMatch(String(notice), /calendar/i, `${draft} → ${notice}`);
    }
  }
});

/** A kept conversation: an earlier text, something else, then a check-in sent as a reply under the earlier one. */
const CHECK_IN_HISTORY = (checkInThread) => [
  { role: "user", text: "Plan my evening", id: "a1" },
  { role: "assistant", text: "Wind down is on your calendar at 10:30 tonight." },
  { role: "user", text: "what's the weather tomorrow", id: "b2" },
  { role: "assistant", text: "Sunny, 64." },
  { role: "user", text: "(Not a text from them. This was your own check-in.)", id: "c3", ...(checkInThread ? { thread: checkInThread } : {}) },
  { role: "assistant", text: "You're still on the edit. Want me to move Wind down to 11:15?" },
];

test("a reply typed under a check-in is shown the check-in it answers", async () => {
  const { threadOf, threadView } = await import("../src/agent/threadView.js");
  // The check-in continued "Wind down is on your calendar…": it is kept in that text's thread.
  assert.equal(threadOf(CHECK_IN_HISTORY(null), "Wind down is on your calendar at 10:30 tonight."), "a1");
  const kept = threadView(CHECK_IN_HISTORY("a1"), { start: "Wind down is on your calendar at 10:30 tonight.", replied: true }, 12);
  assert.ok(kept.shown.some((turn) => /move Wind down to 11:15/.test(turn.text)), "a check-in kept in the thread is shown");
  // Kept before this fix, with no thread: the message they replied to is still shown.
  const old = threadView(
    CHECK_IN_HISTORY(null),
    { start: "Wind down is on your calendar at 10:30 tonight.", words: "You're still on the edit. Want me to move Wind down to 11:15?", replied: true },
    12,
  );
  assert.ok(old.shown.some((turn) => /move Wind down to 11:15/.test(turn.text)), "the replied-to message is shown");
  assert.ok(!old.shown.some((turn) => turn.text === "Sunny, 64."), "the rest of the chat stays out");
});
