/**
 * A SLEEP LINE IS THEIR DATA, READ FOR SENSE, AND A CHECK-IN ANSWER IS
 * LOGGED (Tex's self-review, 2026-10-28 and 2026-10-29; `timeLog.js`).
 *
 * The shapes are the reviews' (@context-lc areas/tex-reviews/themes/
 * sleep-log-wrong.md and time-audit-drops-plans.md); every time, total and
 * plan here is made up.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `LONGEST_NIGHT` raised to 48 hours → "a night longer than one night…"
 *     fails.
 *   `route.js` dropping `sleepLineNote(question)` from the turn's question →
 *     "the model is told a sleep line is theirs…" fails.
 *   `steeredLine` ignoring `notes` → "a sleep line texted mid-turn…" fails.
 *   The "theirs" check dropped from `replyChecks` → "a figure they sent, taken
 *     back as Tex's…" fails at its `claimCheck` assertion.
 *   `answersACheckIn` looking at the last text only → "the plan two texts
 *     after the routine's question" fails.
 *   `KEEPS` emptied → "a turn that saved the plan is let go" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { recentTextsSection } from "../src/agent/routine.js";
import { steeredLine } from "../src/agent/steer.js";
import {
  CHECK_IN_ANSWER_NOTICE,
  IMPOSSIBLE_NIGHT_NOTICE,
  THEIR_FIGURE_NOTICE,
  answersACheckIn,
  disownsTheirFigure,
  dropsCheckInAnswer,
  impossibleNight,
  readSleepLine,
  sleepLineNote,
} from "../src/agent/timeLog.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const CLEAN = "I slept from Mar 3, 2026 at 11:50 PM to Mar 4, 2026 at 7:20 AM, for a total of: 7 hours, 5 minutes.";
const TWO_NIGHTS = "Total sleep time is 12 hours 40 minutes, spanning from March 2, 2026 at 1:10 AM to March 3, 2026 at 6:50 AM.";
const TOTAL_ONLY = "You have slept for a total of: 7 hours, 5 minutes.";
const BLANK = "I slept from  to , for a total of: .";
const ROUTINE_LINE = "(Not a text from them. Your routine tex/routines/every-3-hours/time-audit-checkin.md ran on its schedule and you texted them what follows.)";
const PLAN = "im writing till 10. after 10 i want to edit the videos then sleep at 11:30";

test("a clean sleep line is one night, and its note says it is theirs and to log it", () => {
  assert.deepEqual(readSleepLine(CLEAN), { blank: false, from: "Mar 3, 2026 at 11:50 PM", to: "Mar 4, 2026 at 7:20 AM", total: 425, problems: [] });
  const note = sleepLineNote(CLEAN);
  assert.match(note, /their data, never a text you sent/);
  assert.match(note, /total 7 hours 5 minutes/);
  assert.match(note, /compare it with the last night in their log/);
  assert.match(note, /say what you logged in one line/);
  assert.match(sleepLineNote(TOTAL_ONLY), /even when it says "you"/, "the automation's second-person line");
});

test("a night longer than one night, or a total its times can't hold, doesn't add up", () => {
  assert.deepEqual(readSleepLine(TWO_NIGHTS).problems, ["from asleep to up is 29 hours 40 minutes, more than one night"]);
  assert.match(sleepLineNote(TWO_NIGHTS), /Don't log it/);
  const long = readSleepLine("I slept from Mar 2, 2026 at 11:00 PM to Mar 4, 2026 at 4:12 AM, for a total of: 29 hours, 12 minutes.");
  assert.equal(long.problems.length, 2);
  assert.deepEqual(readSleepLine("I slept from Mar 3, 2026 at 1:10 AM to Mar 3, 2026 at 6:50 AM, for a total of: 13 hours, 30 minutes.").problems, [
    "its total, 13 hours 30 minutes, is longer than the time between asleep and up",
  ]);
  assert.deepEqual(readSleepLine("I slept from Mar 3, 2026 at 6:50 AM to Mar 3, 2026 at 1:10 AM, for a total of: 5 hours.").problems, ["it wakes up before it falls asleep"]);
  assert.deepEqual(readSleepLine("I slept from Mar 2, 2026 at 11:40 PM to Mar 3, 2026 at 7:05 AM, for a total of: 7 hours, 10 minutes.").problems, [], "across midnight");
});

test("a blank line has nothing to log, and a text that isn't a sleep line has no note", () => {
  assert.equal(readSleepLine(BLANK).blank, true);
  assert.match(sleepLineNote(BLANK), /came through blank/);
  assert.equal(sleepLineNote("X: 41m\nMessages: 40m\nTotal phone pickups: Not available"), "");
  assert.equal(sleepLineNote("can you text me at 4:55"), "");
});

test("the model is told a sleep line is theirs, and whether it adds up", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Logged: asleep 12:10 to 7:15 am, 7 hours 5 minutes." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: TWO_NIGHTS, conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const sent = JSON.stringify(world.model.requests[0].messages);
    assert.ok(sent.includes("never a text you sent"), "the note reached the model");
    assert.ok(sent.includes("more than one night"));
  } finally {
    world.restore();
  }
});

test("a sleep line texted mid-turn carries its note to the model, and not into the conversation", () => {
  assert.match(steeredLine([CLEAN], { notes: true }), /their data/);
  assert.doesNotMatch(steeredLine([CLEAN]), /their data/);
  assert.equal(steeredLine(["ok"], { notes: true }), "(They texted this while you were working on it; take it into account:) ok");
});

test("a figure they sent, taken back as Tex's, is caught; one Tex did send is its to take back", () => {
  const history = [
    { role: "user", text: "try email reports instead" },
    { role: "assistant", text: "The one for Mar 2 to 3 says asleep 1:10 AM, up 6:50 AM, 13.5 hours." },
  ];
  const first = 'The audit log already has your times. My earlier "12 hours 40 minutes" was wrong too, and I shouldn\'t have sent it.';
  assert.equal(disownsTheirFigure(first, { question: TWO_NIGHTS, history }), true);
  const second = "Ignore the 7 hours 5 minutes at the end of my last text. Nothing I read gives that number, and I shouldn't have sent it.";
  assert.equal(disownsTheirFigure(second, { question: TOTAL_ONLY, history }), true);
  assert.equal(disownsTheirFigure("I shouldn't have sent the 13.5 hours, the watch got it wrong.", { question: "no the email is wrong", history }), false, "Tex did send it");
  assert.equal(disownsTheirFigure("That's 7 hours 5 minutes, logged.", { question: TOTAL_ONLY, history }), false, "nothing taken back");
  const check = claimCheck({ question: TOTAL_ONLY, history });
  assert.equal(check.check(second), THEIR_FIGURE_NOTICE);
  assert.equal(check.check(second), null, "once a turn");
});

test("a night quoted with a total its own times can't hold is caught; one rejected or logged right is not", () => {
  assert.equal(impossibleNight("The one for Mar 2 to 3 says asleep 1:10 AM, up 6:50 AM, 13.5 hours: core 8 hr 26 min, deep 2 hr 20 min."), true);
  assert.equal(impossibleNight("Logged: asleep 1:10 to 8:30, 31 hours."), true, "past 16 hours");
  assert.equal(impossibleNight("Its window runs 1:10 am on the 2nd to 6:50 am on the 3rd, which is 29 hours, not one night."), false);
  assert.equal(impossibleNight("The watch says asleep 1:10 AM, up 6:50 AM, 13.5 hours, which doesn't add up."), false);
  assert.equal(impossibleNight("Logged: asleep 12:10 to 7:15 am, 7 hours 5 minutes."), false);
  assert.equal(impossibleNight("Logged: asleep 10:40 to 7:05, 8 hours 10 minutes."), false, "no am/pm: either reading");
  assert.equal(impossibleNight("Your 9:30 call moved to 10:15, 2 hours from now."), false, "not about sleep");
  const check = claimCheck({ question: "try email reports instead" });
  assert.equal(check.check("The one for Mar 2 to 3 says asleep 1:10 AM, up 6:50 AM, 13.5 hours."), IMPOSSIBLE_NIGHT_NOTICE);
});

test("a plan given to the check-in and answered 'Will do.' with nothing saved gets one more round", () => {
  // As in the review: the plan came two texts after the routine's question.
  const history = [
    { role: "user", text: ROUTINE_LINE },
    { role: "assistant", text: "Since 6, what did the last 3 hours go to?" },
    { role: "user", text: "Filed the invoices and planned next week" },
    { role: "assistant", text: "Found the receipt in your inbox." },
  ];
  assert.equal(answersACheckIn(history), true, "the plan two texts after the routine's question");
  assert.equal(dropsCheckInAnswer("Will do.", { question: PLAN, history }), true);
  // And "working till 5, don't bother me".
  assert.equal(dropsCheckInAnswer("Will do.", { question: "working till 5, don't bother me", history: history.slice(0, 2) }), true);
  const check = claimCheck({ question: PLAN, history });
  assert.equal(check.check("Will do."), CHECK_IN_ANSWER_NOTICE);
  assert.match(CHECK_IN_ANSWER_NOTICE, /say in one line what you logged/);
});

test("a turn that saved the plan, an answer that says more, and a text that isn't a check-in answer are let go", () => {
  const history = [
    { role: "user", text: ROUTINE_LINE },
    { role: "assistant", text: "Since 6, what did the last 3 hours go to?" },
  ];
  assert.equal(dropsCheckInAnswer("Will do.", { question: PLAN, history, steps: [{ name: "write_note", ok: true }] }), false, "a turn that saved the plan is let go");
  assert.equal(dropsCheckInAnswer("Will do.", { question: PLAN, history, steps: [{ name: "write_note", ok: false }] }), true, "a failed save kept nothing");
  assert.equal(dropsCheckInAnswer("Logged: writing till 10, videos, sleep at 11:30.", { question: PLAN, history }), false);
  assert.equal(dropsCheckInAnswer("Will do.", { question: "can you move it to 3pm?", history }), false, "a question");
  assert.equal(dropsCheckInAnswer("Will do.", { question: "thanks", history }), false, "no plan");
  assert.equal(dropsCheckInAnswer("Will do.", { question: PLAN, history: [{ role: "user", text: "remind me at 9" }, { role: "assistant", text: "Will do." }] }), false, "no check-in");
  const long = [...history, ...Array.from({ length: 3 }, (_, i) => [{ role: "user", text: `text ${i}` }, { role: "assistant", text: `answer ${i}` }]).flat()];
  assert.equal(answersACheckIn(long), false, "a check-in long past");
});

test("a routine run stays quiet while they asked not to be bothered, and doesn't ask again", () => {
  const section = recentTextsSection(
    [
      { role: "user", text: ROUTINE_LINE },
      { role: "assistant", text: "What did 12 to 3 go to?" },
      { role: "user", text: "working till 5, don't bother me" },
    ],
    "tex/routines/every-3-hours/time-audit-checkin.md",
  );
  assert.match(section, /asked not to be texted until a time still to come/);
  assert.match(section, /Never ask again what they already told you above/);
});
