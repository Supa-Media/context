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
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SYNCED_PLACES_LINE, systemPrompt } from "../src/agent/prompt.js";

test("a texted turn is told its calendar and email are in its notes, production setup or not", () => {
  for (const notes of [null, { prompt: "You are Tex." }]) {
    const prompt = systemPrompt(null, { texting: true, notes });
    assert.ok(prompt.includes(SYNCED_PLACES_LINE));
  }
  assert.match(SYNCED_PLACES_LINE, /0-inbox\/calendar\//);
  assert.match(SYNCED_PLACES_LINE, /never say you can't see their calendar/);
});

test("another client's turn is not", () => {
  assert.ok(!systemPrompt(null, { texting: false }).includes(SYNCED_PLACES_LINE));
});
