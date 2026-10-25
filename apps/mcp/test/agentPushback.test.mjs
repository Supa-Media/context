/**
 * TEX PUSHES BACK, ONCE, AND NEVER FLATTERS (the owner, 2026-10-25;
 * `pushback.js`, docs/decisions/texting-assistant/pushback.md).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `OPINION_LINE` dropped from `systemPrompt`'s texting lines → "every
 *     texted turn is told to have a point of view" fails.
 *   `route.js` sending `turn.answer` without `withoutFlattery` → "a texted
 *     answer's flattering opener never reaches them" fails.
 *   The `,` ending dropped from `FLATTERY` → "a flattering clause before a
 *     comma comes off" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OPINION_LINE, withoutFlattery } from "../src/agent/pushback.js";
import { REMEMBER_LINE, systemPrompt } from "../src/agent/prompt.js";
import { DREAM_INSTRUCTIONS } from "../src/agent/dream.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

test("every texted turn is told to have a point of view, a production setup's own words included", () => {
  assert.ok(systemPrompt(null, { texting: true }).includes(OPINION_LINE));
  assert.ok(systemPrompt(null, { texting: true, notes: { prompt: "You are a test assistant." } }).includes(OPINION_LINE));
  assert.ok(!systemPrompt(null).includes(OPINION_LINE), "an app's own turn keeps its short prompt");
  // The line names where the point of view comes from, and that it still does the job.
  assert.match(OPINION_LINE, /tex\/about-me\.md/);
  assert.match(OPINION_LINE, /mission/);
  assert.match(OPINION_LINE, /Still do it/);
  assert.match(OPINION_LINE, /Never flatter/);
});

test("goals are kept where every turn reads them", () => {
  assert.match(REMEMBER_LINE, /a goal they're working toward/);
  assert.match(DREAM_INSTRUCTIONS, /goals they're working toward/);
});

test("a flattering opening sentence comes off", () => {
  assert.equal(withoutFlattery("You're so right! I'll switch it to Rust."), "I'll switch it to Rust.");
  assert.equal(withoutFlattery("Oh, you’re absolutely right. Changed."), "Changed.");
  assert.equal(withoutFlattery("Great question! It's on the 14th."), "It's on the 14th.");
  assert.equal(withoutFlattery("What a great idea, Maya! Ordering now."), "Ordering now.");
  assert.equal(withoutFlattery("Absolutely!\n\nAdded."), "Added.");
  assert.equal(withoutFlattery("Love that idea. Booked for 7."), "Booked for 7.");
});

test("a flattering clause before a comma comes off", () => {
  assert.equal(withoutFlattery("You're so right, the API is cleaner."), "The API is cleaner.");
  assert.equal(withoutFlattery("Absolutely, I'll add it."), "I'll add it.");
});

test("an answer that isn't flattery is left as it was", () => {
  for (const answer of [
    "You're right, it's at 3:30.",
    "Absolutely not: the rewrite undoes the September decision.",
    "Great Falls is about 40 minutes away.",
    "Can do, though cookies cut against your 10k goal. Still want them?",
    "Absolutely!",
    "",
  ]) {
    assert.equal(withoutFlattery(answer), answer, answer);
  }
  assert.equal(withoutFlattery(null), null);
});

test("a texted answer's flattering opener never reaches them", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "You're so right! Rewriting it in Rust is a big job, though. What's it for?" }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "let's rewrite the app in rust", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Rewriting it in Rust is a big job, though. What's it for?");
  } finally {
    world.restore();
  }
});
