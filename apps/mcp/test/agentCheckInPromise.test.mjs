/**
 * A CHECK-IN TEX PROMISES FOR A SET TIME IS SET IN THE SAME TURN, OR NOT
 * PROMISED (Tex self-review, 2026-10-26 and 2026-10-27; `otherRoutes.js`).
 *
 * "I'll check with you tonight" and "I'll check the log at 4:30 and text
 * you" were each sent with only read_note and write_note in the turn, so
 * nothing ever came back. The first never said "text you"; the second did,
 * but "4:30" was not a word to the promise pattern.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-27).
 *
 *  1. `PROMISE` words back to letters only (no ":") → "the review's own
 *     lines are caught" fails on "ask the desk at 4:30 and text you".
 *  2. `checksInAt` dropped from `promisesLater` → "the review's own lines
 *     are caught" fails on "I'll check with you tonight".
 *  3. `laterNotice` always answering `LATER_NOTICE` → "a set time is kept
 *     with a one-off reminder" and "once a turn, and never after a routine
 *     was written" fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { CHECK_IN_NOTICE, LATER_NOTICE, promisesCheckInAt, promisesLater } from "../src/agent/otherRoutes.js";

const LOG = "Logged job work from 12:17 as Upkeep. I’ll check the log at 4:30 and text you when it’s done.";
const TONIGHT = "Noted: invoice is waiting on Jonathan and Nnenna’s approval for the video. I’ll check with you tonight.";

test("the review's own lines are caught", () => {
  for (const said of [LOG, TONIGHT]) {
    assert.ok(promisesLater(said), said);
    assert.ok(promisesCheckInAt(said), said);
  }
  assert.ok(promisesLater("I’ll ask the desk at 4:30 and text you."), "a clock time inside the words before \"text you\"");
});

test("a set time is kept with a one-off reminder", () => {
  const notice = claimCheck({ question: "I’m going to start doing actual work for my job up til around 4-5pm" }).check(LOG);
  assert.equal(notice, CHECK_IN_NOTICE);
  assert.ok(notice.includes("tex/routines/once/") && notice.includes("`at:`"));
  assert.ok(notice.includes("take the promise out"), "or not made");
  // An untimed later still gets the hourly routine.
  assert.equal(claimCheck({ question: "q" }).check("Once it answers, I'll text you what I find."), LATER_NOTICE);
});

test("once a turn, and never after a routine was written", async () => {
  const claims = claimCheck({ question: "will confirm tonight" });
  assert.equal(claims.check(TONIGHT), CHECK_IN_NOTICE);
  assert.equal(claims.check(TONIGHT), null, "once a turn");

  const kept = claimCheck({ question: "will confirm tonight" });
  const write = kept.wrap(async () => ({ content: [{ type: "text", text: "Saved." }] }));
  await write("write_note", { path: "tex/routines/once/geo-blair-approval.md", content: "---\nat: 2026-10-26 8:00 pm\n---\nAsk whether Jonathan and Nnenna approved." });
  assert.equal(kept.check(TONIGHT), null);
});

test("a time that is not a promise to come back is let through", () => {
  for (const said of [
    "Your meeting is at 4:30 tonight.",
    "I checked tomorrow’s calendar: you are free at 3.",
    "I’ll check in tonight once you say yes.",
    "I’ll draft it now. It’s at 4:30.",
    "I’ll check tomorrow’s weather: sunny.",
    "I'll add it to your calendar at 3 pm tomorrow.",
  ]) {
    assert.ok(!promisesCheckInAt(said), said);
  }
  for (const said of ["I’ll remind you at 9 am tomorrow.", "I’ll follow up after lunch.", "Done. I'll text you at 4:30 p.m. with the totals."]) {
    assert.ok(promisesCheckInAt(said), said);
  }
});
