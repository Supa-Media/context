/**
 * The answer a card should have carried (`src/agent/visuals/notice.js`):
 * Dev2's two texted answers of 2026-10-26, which went out as lists.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `wantsACard` returning false → "a week and a list of places go back for
 *     a card" fails.
 *   the `DRAWN` check removed → "a turn that drew already is let go" fails.
 *   claimCheck without the visuals notice → "a texted list goes back once"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { VISUAL_NOTICE, wantsACard } from "../src/agent/visuals/notice.js";
import { claimCheck } from "../src/agent/claimCheck.js";

const WEEK = [
  "Light week, mostly short evening calls. Sunday in Bethesda is the big one.",
  "",
  "Mon: Joemo 1:30, Austin 6:30, Charisma 8",
  "Tue: Dorian's birthday, AJ 4, Kansi 6, Sarah 6:30",
  "Wed: Fast, all day",
  "Thu: Sayo 6 (it's on your calendar twice)",
  "Fri: LK 2, then team bowling at Lucky Strike at 7",
  "Sat: Generals Prayer 6:30, family prayer 9, Supa Steering 9:30",
  "Sun: Bethesda party at The Charles, 3 to 5",
].join("\n");

const DINNER = [
  "These are the Eater picks closest to your place in Long Island City, with the addresses from the page:",
  "",
  "Red Sorghum, Sichuan and Hunan, 28-03 Jackson Ave, (929) 545-2023, bookable",
  "Nai Brother, Sichuan soup you customize, 27-17 42nd Rd, (516) 744-6828",
  "Yumpling, dumplings and beef noodle soup, 49-11 Vernon Blvd, (718) 713-1839",
  "Sami's Kabab House, Afghan, halal, 47-38 Vernon Blvd, +1 518-840-3886",
].join("\n");

test("a week and a list of places go back for a card", () => {
  assert.equal(wantsACard(WEEK, { question: "What does my week look like" }), true);
  assert.equal(wantsACard(DINNER, { question: "Can you show me some dinner options around me" }), true);
});

test("a short answer, a draft, words they asked for, or a turn that drew already is let go", () => {
  assert.equal(wantsACard("Tuesday the 13th, 3 pm.\n\nNot booked yet, though."), false);
  assert.equal(wantsACard("Will do."), false);
  assert.equal(wantsACard(WEEK, { question: "text only please, what's my week" }), false);
  assert.equal(wantsACard("Subject: Lunch\n\nHi Sam,\nAre you free Friday?\nThanks\nSeyi"), false);
  assert.equal(wantsACard(WEEK, { steps: [{ name: "draw_visual", ok: true }] }), false);
  // A drawing that failed is no card: the list still goes back once.
  assert.equal(wantsACard(WEEK, { steps: [{ name: "draw_visual", ok: false }] }), true);
});

test("a texted list goes back once with the card notice, and the next answer goes out", async () => {
  const claims = claimCheck({ question: "What does my week look like", visuals: () => true });
  assert.equal(await claims.check(WEEK), VISUAL_NOTICE);
  assert.notEqual(await claims.check(WEEK), VISUAL_NOTICE, "asked once only");
  // A turn that cannot draw is never asked to.
  const blind = claimCheck({ question: "What does my week look like", visuals: () => false });
  assert.notEqual(await blind.check(WEEK), VISUAL_NOTICE);
});
