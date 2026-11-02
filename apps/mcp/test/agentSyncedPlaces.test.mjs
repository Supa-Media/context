/**
 * A texted turn is told where the person's synced calendar and email live
 * (`SYNCED_PLACES_LINE`, `src/agent/prompt.js`). On 2026-10-18 Tex answered
 * "what's on the cal for this week" with "I can't read your Google Calendar",
 * while every day of it sat in 0-inbox/calendar/, and filled the gap with two
 * dates from someone else's test notes.
 *
 * ## Sabotage record
 *
 *  1. The line dropped from the texting prompt (2026-10-20).
 *     → "a texted turn is told its calendar and email are in its notes, production setup or not" fails.
 *  2. The 2026-10-18 line put back, naming 0-inbox/calendar/YYYY/MM/ (2026-10-21).
 *     → "the line names no calendar folder for the model to list" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SYNCED_PLACES_LINE, systemPrompt } from "../src/agent/prompt.js";

test("a texted turn is told its calendar and email are read from Google, production setup or not", () => {
  for (const notes of [null, { prompt: "You are Tex." }]) {
    const prompt = systemPrompt(null, { texting: true, notes });
    assert.ok(prompt.includes(SYNCED_PLACES_LINE));
  }
  assert.match(SYNCED_PLACES_LINE, /fetch id "calendar:"/);
  assert.match(SYNCED_PLACES_LINE, /Never say you can't see or read their calendar/);
  assert.match(SYNCED_PLACES_LINE, /never say a day is empty without that fetch/);
  // Dev2, 2026-10-29: asked for a time to meet someone, Tex said "free all afternoon", then that it
  // couldn't tell whether a time worked for them, and offered no slot at all.
  assert.match(SYNCED_PLACES_LINE, /name two or three specific open times/);
  assert.match(SYNCED_PLACES_LINE, /never end on not seeing the other person's/);
  // Nothing is copied any more (owner, 2026-10-21), so no copy is promised.
  assert.match(SYNCED_PLACES_LINE, /none of it is copied into their notes/);
  assert.doesNotMatch(SYNCED_PLACES_LINE, /0-inbox/);
});

/*
  2026-10-21: told the first account lands in 0-inbox/calendar/YYYY/MM/, Tex
  listed that folder for a Friday, found nothing (every connection since
  2026-09-18 files under its account) and said nothing was planned. No folder
  is named now; `calendar:` finds the day wherever it is.
*/
test("the line names no calendar folder for the model to list", () => {
  assert.doesNotMatch(SYNCED_PLACES_LINE, /calendar\/YYYY/);
  assert.doesNotMatch(SYNCED_PLACES_LINE, /list_notes/);
});

test("another client's turn is not", () => {
  assert.ok(!systemPrompt(null, { texting: false }).includes(SYNCED_PLACES_LINE));
});
