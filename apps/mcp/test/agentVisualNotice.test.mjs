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
 *   the second-signal filter replaced by `return true` → "a to-do list stays
 *     words" fails.
 *   `check` returning `firstNotice(answer)` alone → "a list sent back for
 *     another reason carries the card too" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OWED_PICTURE_NOTICE, VISUAL_NOTICE, VISUAL_TOO, owesAPicture, wantsACard } from "../src/agent/visuals/notice.js";
import { noticeFor } from "../src/agent/handbackJudge.js";
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
  // Hand-back bench case 10 (gh-104): after failed draws Tex texted "the card won't draw" and one line in
  // place of the list; a card that won't draw leaves the whole list in words.
  assert.match(VISUAL_NOTICE, /If the drawing fails again, send the whole list in words/);
});

test("a texted list goes back once with the card notice, and the next answer goes out", async () => {
  const claims = claimCheck({ question: "What does my week look like", visuals: () => true });
  assert.equal(await claims.check(WEEK), VISUAL_NOTICE);
  assert.notEqual(await claims.check(WEEK), VISUAL_NOTICE, "asked once only");
  // A turn that cannot draw is never asked to.
  const blind = claimCheck({ question: "What does my week look like", visuals: () => false });
  assert.notEqual(await blind.check(WEEK), VISUAL_NOTICE);
});

test("a to-do list stays words; a list with days, prices or places, or one they asked to see, is a card", () => {
  const todo = "Book the van\nCancel the internet\nPack the kitchen by Friday";
  assert.equal(wantsACard(todo, { question: "what's left before the move" }), false);
  assert.equal(wantsACard("Call the bank\nSend Ana the deck\nRenew the passport\nBuy a gift", { question: "what's on my list" }), false);
  // Words like "money", "friend" and "satisfied" are not days.
  assert.equal(wantsACard("Move money to savings\nAsk a friend about it\nGet the satisfied customer quote", { question: "what's left" }), false);
  const caterers = "Lugo's, $18 a head, 4.8 stars\nBlend, $22 a head, 4.6 stars\nIndia Passage, $15 a head, 4.4 stars";
  assert.equal(wantsACard(caterers, { question: "which caterer" }), true);
  assert.equal(wantsACard("Book the van\nCancel the internet\nPack the kitchen", { question: "show me what's left before the move" }), true);
});

// Dev2's lunch turn of 2026-10-26: the list of places went back for its
// missing prices, the card never got its round, and the answer came home as
// one place in words, ending "nothing to undo" (the H8 notice's own words).
const LUNCH = [
  "A few lunch spots near you:",
  "",
  "Hibino LIC, bento about $12",
  "Sapps, 3 rolls for $15 Mon to Thu",
  "Dai Hachi Sushi, bento about $15",
  "Ramen Spot, bowls $18 to $20",
  "",
  "Want me to look up Yumpling's prices too?",
].join("\n");

test("a list sent back for another reason carries the card too, once", async () => {
  // A stop-short answer: its own notice wins the round, and the card rides along.
  const short = claimCheck({ question: "Can you show me some lunch options around me average prices as well", visuals: () => true });
  const first = await short.check(`${LUNCH}\n\nNext step is pricing the rest.`);
  assert.notEqual(first, VISUAL_NOTICE);
  assert.ok(first.endsWith(VISUAL_TOO), "the card rides along with the other notice");
  const again = await short.check(`${LUNCH}\n\nNext step is pricing the rest.`);
  assert.ok(again === null || !again.includes(VISUAL_TOO), "asked once only");
  // A turn that cannot draw is never asked to.
  const blind = claimCheck({ question: "Can you show me some lunch options", visuals: () => false });
  const plain = await blind.check(`${LUNCH}\n\nNext step is pricing the rest.`);
  assert.ok(plain === null || !plain.includes(VISUAL_TOO));
});

test("the hand-back notice keeps the whole answer and never makes a lookup about undoing", () => {
  assert.match(noticeFor("H8"), /never add a line about undoing it/);
  assert.match(noticeFor("H12"), /whole answer again/);
});

test("a list of projects is a board", () => {
  assert.equal(wantsACard("Context private beta\nTex\nGoogle OAuth verification\nPortal onboarding", { question: "what are the projects in supa rn" }), true);
});

test("a graphic asked for, or promised in the words, with nothing drawn goes back to be drawn", async () => {
  const ask = "Tex can you make a graphic for this instead of this wall of text, i'm not reading all this";
  const claims = claimCheck({ question: ask, visuals: () => true });
  assert.equal(await claims.check("Here's the one-page version. It's not started, and it has three open questions."), OWED_PICTURE_NOTICE);
  assert.equal(owesAPicture("Here’s the graphic.", { question: "what's left" }), true, "the words promise one");
  assert.equal(owesAPicture("Here's the one-pager.", { question: ask, steps: [{ name: "draw_visual", ok: true }] }), false, "drawn: it goes with the answer");
  assert.equal(owesAPicture("The deposit came in Tuesday.", { question: "did the deposit come in" }), false);
  const blind = claimCheck({ question: ask, visuals: () => false });
  assert.notEqual(await blind.check("Here's the one-pager."), OWED_PICTURE_NOTICE);
});
