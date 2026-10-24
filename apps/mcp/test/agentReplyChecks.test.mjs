/**
 * A TEXTED ANSWER IS NEVER EMPTY, NEVER IN A STRAY SCRIPT, NEVER BLAMES NOTES
 * THAT DID NOT FAIL, AND ANSWERS THE TEXT IN FRONT OF IT (the owner's review
 * of a chat, 2026-10-24; `replyChecks.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `claimCheck`'s `check` not calling `replyChecks` → "an empty answer gets
 *     one more round" fails (the empty answer goes straight to the fallback).
 *   `route.js` sending `turn.answer` as it is → "an answer still empty is
 *     never sent as nothing" fails.
 *   `TIMED_PROMISE` dropped from `promisesLater` → "a promise of work by a
 *     time" fails.
 *   The "picture" check dropped from `replyChecks` → "an answer that asks them
 *     something past a picture" fails.
 *   `route.js` choosing the setup's fallback without `pictureFallback` → "a
 *     picture turn whose model fails…" in `agentProduction.test.mjs` fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { LATER_NOTICE, promisesLater } from "../src/agent/otherRoutes.js";
import {
  ASK_NOTICE,
  EMPTY_FALLBACK,
  EMPTY_NOTICE,
  NOTES_NOTICE,
  SCRIPT_NOTICE,
  blamesNotes,
  pointsAtWaitingAsk,
  replyChecks,
  strayScript,
} from "../src/agent/replyChecks.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

test("an empty answer, a stray script, notes blamed and the waiting ask pointed at are each caught once", () => {
  const check = replyChecks({ question: "What in the actual heck", waiting: true });
  assert.equal(check("   "), EMPTY_NOTICE);
  assert.equal(check(""), null, "once a turn");
  assert.equal(check("The bulk of that is医保 and necessities."), SCRIPT_NOTICE);
  assert.equal(check("Your notes have been down all afternoon, so I can't open it.", [{ name: "browse", ok: false }]), NOTES_NOTICE);
  assert.equal(check("The Kansi forward is already waiting above. Give it your 👍 there."), ASK_NOTICE);
  assert.equal(check("Yes, Kansi's on the thread."), null);
});

test("each check holds back where it should", () => {
  assert.equal(strayScript("東京 is 9 hours ahead.", "what time is it in 東京"), false, "their own script");
  assert.equal(strayScript("Café crème, à 8h.", "where to"), false, "accents are not another script");
  assert.equal(blamesNotes("Your notes aren't saving right now.", [{ name: "write_note", ok: false }]), false, "a write really failed");
  assert.equal(blamesNotes("Rocket Money blocked the sign-in.", []), false);
  assert.equal(blamesNotes("The notes say the boiler is broken, so call Sam.", []), false, "a note's words about something else");
  assert.equal(blamesNotes("Context is down right now.", []), true);
  assert.equal(pointsAtWaitingAsk("It's still waiting for your 👍 above.", false), false, "nothing waits");
  assert.equal(pointsAtWaitingAsk("Yes, she's on it, so don't 👍 the forward.", true), false);
});

test("the review's own lines are caught", () => {
  assert.equal(blamesNotes("On top of that, your notes aren't saving right now, so the project note didn't save either.", [{ name: "fill_login", ok: true }]), true);
  assert.equal(blamesNotes("I've started the project. Your notes are having trouble saving right now.", []), true);
  assert.equal(pointsAtWaitingAsk("The email is already waiting for your 👍 above, so you don't need to do anything else.", true), true);
});

test("a promise of work by a time is a promise to keep", () => {
  assert.equal(
    promisesLater(
      "I’ll send the organized breakdown and a financial picture tailored to the $10k investment question (business vs private, liquidity, runway, and suggested splits) within the next 10–15 minutes.",
    ),
    true,
  );
  assert.equal(promisesLater("I'll be done in a few minutes."), true);
  assert.equal(promisesLater("I'll have it in 5 minutes once you say yes."), false, "their later");
  assert.equal(promisesLater("The meeting is in 10 minutes."), false, "not a promise");
  const check = claimCheck({ question: "breakdown?" });
  assert.equal(check.check("I'll text the breakdown within 15 minutes."), LATER_NOTICE);
});

test("an empty answer gets one more round, and the second answer is the one sent", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "" }, { text: "Still on it. Nothing's done yet." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "are you working on this?", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, "Still on it. Nothing's done yet.");
    const notice = JSON.stringify(world.model.requests.at(-1).messages);
    assert.ok(notice.includes("your answer is empty"));
  } finally {
    world.restore();
  }
});

test("an answer still empty is never sent as nothing", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "" }, { text: "" }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "Im not sending this again", conversation: "texts" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.answer, EMPTY_FALLBACK);
  } finally {
    world.restore();
  }
});

test("an answer that asks them something past a picture they sent looks at it again, once", async () => {
  const { PICTURE_NOTICE, asksPastPicture } = await import("../src/agent/replyChecks.js");
  const check = replyChecks({ question: "can you add these to my cal", pictures: true });
  assert.equal(check("Is there a time you want me to block for the fitting?"), PICTURE_NOTICE);
  assert.equal(check("Is there a time you want me to block for the fitting?"), null, "once a turn");
  assert.equal(asksPastPicture("Added the fitting, Sunday 3 pm.", true), false);
  assert.equal(asksPastPicture("What time?", false), false, "no picture");
});
