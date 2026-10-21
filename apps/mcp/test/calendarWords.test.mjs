/**
 * A calendar change is shown with its times in words (Dev2, 2026-10-21, shown
 * "From 2026-10-21T19:00:00-04:00 To 2026-10-21T20:00:00-04:00"), read off the
 * time as given: the offset the change carries is the clock it is said in,
 * and nothing about a time zone is guessed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarCopy, spanWords } from "../src/tools/calendarWrite.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");

test("the change from the owner's chat reads as a day and a time", () => {
  assert.equal(
    calendarCopy({ action: "create", title: "Emmanuela/Sayo", start: "2026-10-21T19:00:00-04:00", end: "2026-10-21T20:00:00-04:00" }, NOW),
    "Add to your Google Calendar:\nEmmanuela/Sayo\nWednesday, October 21, 7 to 8 pm",
  );
});

test("spans read the way people say them", () => {
  assert.equal(spanWords("2026-10-21T11:30:00-04:00", "2026-10-21T13:00:00-04:00", NOW), "Wednesday, October 21, 11:30 am to 1 pm");
  assert.equal(spanWords("2026-10-21T00:00:00-04:00", "2026-10-21T00:30:00-04:00", NOW), "Wednesday, October 21, 12 to 12:30 am");
  assert.equal(spanWords("2026-10-21T23:00:00-04:00", "2026-10-22T01:00:00-04:00", NOW), "Wednesday, October 21, 11 pm to Thursday, October 22, 1 am");
  assert.equal(spanWords("2026-10-21T23:00:00Z", "2026-10-22T00:00:00Z", NOW), "Wednesday, October 21, 11 pm UTC to Thursday, October 22, 12 am UTC");
  assert.equal(spanWords("2026-10-21", "2026-10-22", NOW), "Wednesday, October 21, all day");
  assert.equal(spanWords("2026-10-21", "2026-10-24", NOW), "Wednesday, October 21 to Friday, October 23, all day");
  assert.equal(spanWords("2027-01-02", "2027-01-03", NOW), "Saturday, January 2, 2027, all day");
});

test("a move and a cancel name the event's time in words too, and no raw timestamp is left", () => {
  const move = calendarCopy({ action: "move", title: "Dentist", start: "2026-10-21T15:00:00-04:00", new_start: "2026-10-23T09:00:00-04:00", new_end: "2026-10-23T10:00:00-04:00" }, NOW);
  assert.equal(move, "Move on your Google Calendar:\nDentist, now Wednesday, October 21, 3 pm\nTo Friday, October 23, 9 to 10 am");
  const cancel = calendarCopy({ action: "cancel", title: "Dentist", start: "2026-10-21T15:00:00-04:00" }, NOW);
  assert.equal(cancel, "Cancel on your Google Calendar:\nDentist, Wednesday, October 21, 3 pm");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(move + cancel));
});
