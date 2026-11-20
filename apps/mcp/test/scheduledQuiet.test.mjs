/**
 * A scheduled group turn's skip is a decision, never a text (`src/agent/scheduledQuiet.js`).
 *
 * 2026-11-17 23:00 UTC, a WhatsApp group: its check-in found no new mail and posted its reasoning with the quiet
 * word at the end. The whole path, through `/agent`, is `test/replay/cases/scheduled-skip-never-texted.mjs`.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-17):
 *  - `sendTheReply.js` without `scheduledSkip`: the replay case fails ("no words are handed to the Worker");
 *  - `SCHEDULED_CAUSES` without "check_in": "a check-in's and a routine's skip" fails here.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { TURN_CAUSES, taggedLine } from "../../../packages/tex/gateway/agent/groupTurnCause.js";
import { SAY_NOTHING } from "../../../packages/tex/gateway/agent/sayNothing.js";
import { SCHEDULED_CAUSES, isScheduledGroupTurn, scheduledSkip } from "../../../packages/tex/gateway/agent/scheduledQuiet.js";

const require = createRequire(import.meta.url);
const { chatLookQuestion, chatRoutineQuestion } = require("../../../packages/shared/src/groupRunQuestions.cjs");

// Invented words in the shape of the leak.
const LEAK = "Nothing new in the shared folder since 5:52 PM, and nobody here is waiting on an answer. Nothing needs the group now. SKIP";

test("a check-in's and a routine's skip is decided quiet, however it was worded", () => {
  for (const cause of ["check_in", "routine"]) {
    for (const answer of ["SKIP", "skip", "SKIP.", LEAK, "No new mail.\n\nSKIP", "SKIP. Rent isn't due this week.", "SKIP - nothing new", ""]) {
      assert.equal(scheduledSkip({ cause }, answer), true, `${cause}: ${JSON.stringify(answer)}`);
    }
  }
});

test("a scheduled turn with something to say is not quiet, the word in a sentence included", () => {
  for (const answer of ["The plumber moved Thursday's visit to Friday at 9.", "Bo, can you be home, or should we skip this week?", "Skip the meeting today: the room is closed.", "Nothing needs the group now."]) {
    assert.equal(scheduledSkip({ cause: "check_in" }, answer), false, answer);
  }
});

test("only a turn that ran on the chat's schedule is read this way", () => {
  for (const cause of TURN_CAUSES.filter((name) => !SCHEDULED_CAUSES.includes(name))) {
    assert.equal(isScheduledGroupTurn({ cause }), false, cause);
    assert.equal(scheduledSkip({ cause }, LEAK), false, `${cause}: a person's answer is theirs`);
  }
  for (const group of [null, undefined, {}, { cause: "nope" }]) assert.equal(scheduledSkip(group, LEAK), false);
  assert.ok(SCHEDULED_CAUSES.every((cause) => TURN_CAUSES.includes(cause)), "every scheduled cause is one the Worker names");
});

test("a scheduled group turn is asked for the say_nothing call, never for a word to type", () => {
  const asked = [chatLookQuestion(undefined, null), chatLookQuestion(1_790_000_000_000, "Sep 21, 2:13 PM UTC"), chatRoutineQuestion("tex/routines/rent.md"), chatRoutineQuestion("tex/groups/orbit-lamp-river/routines/rent.md", "Sep 21, 2:13 PM UTC"), taggedLine({ cause: "check_in" }), taggedLine({ cause: "routine" })];
  for (const words of asked) assert.doesNotMatch(words, /SKIP/, words.slice(0, 60));
  for (const words of asked.slice(0, 4)) assert.ok(words.includes(SAY_NOTHING), "silence is the call, in the words every prompt names it by");
});
