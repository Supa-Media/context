/**
 * Work Tex looked up and texted as a wall of findings goes back to be a page
 * (owner, 2026-11-10: pages are "the default for all work output done through
 * Tex that would be shown to the user"; `workPage.js`). A quick answer stays a text.
 *
 * Sabotage record (2026-11-10): the "work" check dropped from `replyChecks`,
 * list lines no longer counted, and the web-lookup condition dropped each
 * failed the test named for it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { replyChecks } from "../src/agent/replyChecks.js";
import { WORK_PAGE_NOTICE, workForAPage } from "../src/agent/workPage.js";

const SEARCHED = [{ name: "search_web", ok: true }, { name: "open_page", ok: true }];
const FINDINGS = [
  "Here's what I found for a 30 person dinner near Union Square:",
  "- Gramercy Tavern: private room for 30, $145 a head, needs 2 weeks notice",
  "- Union Square Cafe: back room seats 32, $120 a head, open Sunday",
  "- Craft: private dining for 40, $135 a head plus a $3,000 minimum",
  "- Barn Joo: semi private, $65 a head, fills up on weekends",
  "- Rosemary's: room for 28, $95 a head, family style",
  "Union Square Cafe is the best fit for price and size, and it's open the day you want.",
].join("\n");

test("findings from the web, texted as a list, are sent back to be a page", () => {
  assert.equal(workForAPage(FINDINGS, { question: "find us a place for dinner for 30 near union square", steps: SEARCHED }), true);
  const check = replyChecks({ question: "find us a place for dinner for 30 near union square" });
  assert.equal(check(FINDINGS, SEARCHED), WORK_PAGE_NOTICE);
  // Once: the rewrite goes on to the other checks.
  assert.notEqual(check(FINDINGS, SEARCHED), WORK_PAGE_NOTICE);
});

test("the same lookup through the send tool counts too", () => {
  assert.equal(workForAPage(FINDINGS, { steps: [{ name: "send", action: "search_web", ok: true }] }), true);
});

test("a quick answer stays a text", () => {
  assert.equal(workForAPage("Union Square Cafe, $120 a head, room for 32. Want me to ask for Sunday?", { steps: SEARCHED }), false);
});

test("an answer from their own notes, or with a page already made, stays as it is", () => {
  assert.equal(workForAPage(FINDINGS, { steps: [{ name: "search", ok: true }] }), false);
  assert.equal(workForAPage(FINDINGS, { steps: [...SEARCHED, { name: "write", ok: true, page: true }] }), false);
  assert.equal(workForAPage(FINDINGS, { steps: [{ name: "search_web", ok: false }] }), false);
});

test("they asked for it as a text, or it's words to copy", () => {
  assert.equal(workForAPage(FINDINGS, { question: "just text me the options", steps: SEARCHED }), false);
  assert.equal(workForAPage(FINDINGS, { question: "quick, where can 30 of us eat?", steps: SEARCHED }), false);
  assert.equal(workForAPage(`Subject: Dinner for 30\n\n${FINDINGS}`, { steps: SEARCHED }), false);
});

test("a long answer with no list is a page too", () => {
  const essay = Array.from({ length: 12 }, (_, i) => `Finding ${i + 1} is that the venue market near the park is tight this month.`).join(" ");
  assert.equal(workForAPage(essay, { steps: SEARCHED }), true);
});
