/**
 * RESEARCH THAT STOPS SHORT OF THE ANSWER (self-review, 2026-10-26).
 *
 * A background job asked for three $10-a-head dinner options for 30 people
 * texted "finished" with only the mains priced and "Next step is pricing the
 * sides". After "catering in NYC only", Tex listed caterers to check and
 * ended "I can write these up in the chat's notes if you want". Each line
 * here is from that chat, beside the finished texts that must go as they are.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-26).
 *
 *  1. `stopsShort` without `SHORT`. → "the dinner job's short answer is read
 *     as stopping short" fails.
 *  2. `stopsShort` without `OFFERS_MORE`. → "the catering answer's offers
 *     to keep looking are read as stopping short" fails.
 *  3. `claimCheck.check` never giving `finishNotice`. → "an answer that
 *     stops short gets one more round, once" fails.
 *  4. `unfinishedJob` ignoring `MAX_JOB_ATTEMPTS`. → "a job's last part is
 *     never unfinished" fails.
 *  5. `claimCheck`'s `unfinished` without `!held`. → "a job's answer
 *     holding an ask for their yes always goes out" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_JOB_ATTEMPTS, jobOf, jobPrompt } from "../src/agent/background.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { mayAsk } from "../src/agent/handbackJudge.js";
import { ASK_FIRST_NOTICE, finishNotice, picksBeforeAsking, stopsShort, unfinishedJob } from "../src/agent/stopsShort.js";

const DINNER_JOB =
  "I wrote up three options in the chat's notes. The three mains come to about $1 to $2 per person, but the sides, dessert and drinks are not priced yet, so the full $10 isn't confirmed.\n\n" +
  "Rotate the chicken and pork, and put the vegetarian pasta every third Wednesday. Next step is pricing the sides, rice, bread, dessert and drinks.";

const CATERING =
  "Options to check:\n- Zerocater runs weekly office lunch programs.\n- Budget caterers in outer boroughs. I haven't priced them for 30.\n\n" +
  "I'd try to get a quote from each for 30 people, Wednesdays, and see what's left under $10 after drinks and dessert. I can write these up in the chat's notes if you want.";

test("the dinner job's short answer is read as stopping short", () => {
  for (const said of [
    "Next step is pricing the sides, rice, bread, dessert and drinks.",
    "The sides, dessert and drinks are not priced yet.",
    "Baked penne: about $0.25 per person for the pasta, with no price yet for the beans or sauce.",
    "So the full $10 isn't confirmed.",
    "I still need to price the drinks.",
    "The venue hasn't been checked yet.",
  ]) {
    assert.ok(stopsShort(said), said);
  }
  assert.ok(stopsShort(DINNER_JOB));
});

test("the catering answer's offers to keep looking are read as stopping short", () => {
  for (const said of [
    "I can write these up in the chat's notes if you want.",
    "I'd try to get a quote from each for 30 people.",
    "I haven't priced them for 30.",
    "Want me to look up their menus?",
    "Let me know if you'd like me to dig into prices.",
    // Dev2's 1:1, 2026-10-26: four restaurants nearby, hours held for a pick.
    "I can look up hours for one you pick.",
    "I can check hours for whichever you choose.",
    "Want me to check hours?",
  ]) {
    assert.ok(stopsShort(said), said);
  }
  assert.ok(stopsShort(CATERING));
});

test("a finished answer, a fair ask or a step only someone else can take is not stopping short", () => {
  for (const said of [
    "Three caterers come in at $8.50, $9.50 and $10 a person, sides and drinks included. Want me to email Taqueria Rosa for a Wednesday quote?",
    "Your plan renews Nov 3 for $11.99.",
    "I'd pick the chicken tray bake: it's the cheapest at $7.80 a head all in.",
    "Do you want to cook, or have it catered?",
    "The table is booked for 7 pm; the restaurant emails a confirmation within the hour.",
    "Added smoke alarm battery to your to-do list.",
    "Your order is placed; next step is the courier picking it up at 6.",
    "Bella Cucina is open till 10 tonight and Pho 88 till 9. I can book a table at the one you pick.",
  ]) {
    assert.equal(stopsShort(said), false, said);
  }
});

test("an answer that stops short gets one more round, once", () => {
  const chat = claimCheck({ question: "catering options in nyc only" });
  const notice = chat.check(CATERING);
  assert.ok(typeof notice === "string" && /stops short of what they asked/.test(notice), "the first short answer is sent back");
  assert.match(notice, /never needs their yes/, "looking up prices is said to need no yes");
  assert.match(notice, /start a background job/, "a chat turn may hand it to a job");
  assert.equal(chat.check(CATERING), null, "only once a turn");

  const job = claimCheck({ question: "three dinner options", job: { attempt: 1 } });
  assert.match(job.check(DINNER_JOB), /This is a background job/, "a job is told to finish it");
});

test("a job's last part is never unfinished", () => {
  assert.equal(unfinishedJob({ attempt: 1 }, DINNER_JOB), true);
  assert.equal(unfinishedJob({ attempt: MAX_JOB_ATTEMPTS - 1 }, DINNER_JOB), true);
  assert.equal(unfinishedJob({ attempt: MAX_JOB_ATTEMPTS }, DINNER_JOB), false, "the last part texts what it has");
  assert.equal(unfinishedJob(null, DINNER_JOB), false, "a chat turn is never a job");
  assert.equal(unfinishedJob({ attempt: 1 }, "Three caterers at $8.50, $9.50 and $10 a person, all in."), false);
  assert.equal(claimCheck({ question: "x", job: { attempt: 1 } }).unfinished(DINNER_JOB), true);
  assert.equal(claimCheck({ question: "x" }).unfinished(DINNER_JOB), false);
});

test("a job's answer holding an ask for their yes always goes out", async () => {
  const watch = claimCheck({ question: "x", job: { attempt: 1 } });
  await watch.wrap(async () => ({ held: true, content: [{ type: "text", text: "Held for their yes." }] }))("send_email", {});
  assert.equal(watch.unfinished(DINNER_JOB), false);
});

test("a job that stopped short is told so in its next part", () => {
  const job = jobOf({ id: "job-dinner-0001", title: "Dinner options", attempt: 2, draft: DINNER_JOB, unfinished: true });
  assert.equal(job.unfinished, true);
  assert.match(jobPrompt(job), /stopped short of what they asked[^]*Do that missing part now/);
  const changed = jobOf({ id: "job-dinner-0001", title: "Dinner options", attempt: 2, draft: DINNER_JOB });
  assert.match(jobPrompt(changed), /they texted more before it went out/, "a draft a text replaced keeps its own wording");
  assert.match(jobPrompt(changed), /sides and drinks included/, "every job is told finished means every figure");
});

test("an offer to keep looking is judged, with or without a question mark", () => {
  assert.ok(mayAsk("I can write these up in the chat's notes if you want."));
  assert.ok(mayAsk("Next step is pricing the sides."));
  assert.ok(finishNotice({ job: false }).length > 0);
  // Dev2's 1:1, 2026-10-26: "The page doesn't list hours ... I can look up hours for one you pick" got the
  // notice and went out anyway through "isn't published anywhere": a list page is not where hours live.
  assert.match(finishNotice({ job: false }), /A list page without the figure is not where it lives: open each place's own page/);
  assert.match(finishNotice({ job: false }), /opening hours/);
});

test("asked for options with the brief open, the first reply is the one question, and options come with their links", async () => {
  const { RESEARCH_LINE } = await import("../src/agent/prompt.js");
  // gh-94 and gh-95, 2026-10-26: "I'd cook it", from her notes, before asking.
  assert.match(RESEARCH_LINE, /whole first reply is that one question: no options, no pick/);
  // The owner's bar the same day: each caterer named with its menu link.
  assert.match(RESEARCH_LINE, /each place with its page link/);
  // Hand-back bench case 10 (gh-104): opened all three places' pages, then texted only its pick.
  assert.match(RESEARCH_LINE, /give each one found with the fact that decides it .*then your pick/);
  // gh-107: asked "which Riverside?" twice before any search.
  assert.match(RESEARCH_LINE, /A town they name is enough to search on: never ask which state first/);
  // gh-100: told her to confirm the prices, and asked which Riverside when the directory said.
  assert.match(RESEARCH_LINE, /don't ask what those pages settle .* or tell them to confirm the figures/);
});

// Sabotage record (2026-10-26): `picksBeforeAsking` always false → this test fails.
test("a pick made before the one question that changes the search goes back once, in a chat turn only", () => {
  const cooked =
    "I'd cook it. $10 a head is tight for catering 30 people every week. Three from your weeknight list: Lentil soup, chicken thighs, pasta. " +
    "If you'd rather have it catered, tell me which town and I'll find three places.";
  const asked = "help me find 3 options for a dinner every wednesday, about $10 a person, around 30 people";
  assert.ok(picksBeforeAsking(cooked, asked));
  assert.ok(picksBeforeAsking("That's if you're cooking it yourselves. If you'd rather order in, tell me the town and I'll find places.", asked));
  assert.ok(picksBeforeAsking("I'd cook it yourselves. $300 a week easily covers big trays. If you'd rather have it catered, which town is it in?", asked));
  // gh-98: the aside with no question mark and no "tell me".
  assert.ok(picksBeforeAsking("I'd cook it: three trays from your list. Catering's the other option if you'd rather not cook.", asked));
  // gh-100: "the other option" with no "if you'd rather".
  assert.ok(picksBeforeAsking("I'd cook it yourselves. Catering is the other option, if nobody wants to cook every week. Which way do you want to go?", asked));
  // gh-107: "Or I can look for caterers instead. Which one?", and grocery-costed cooking nobody asked for.
  assert.ok(picksBeforeAsking("I'd cook it: $10 a head stretches a long way. Or I can look for caterers instead. Which one?", asked));
  assert.ok(picksBeforeAsking("I couldn't find published grocery prices, so these are estimates. Chicken tray bake (my pick): about $3 a person. Which store do you shop at?", asked));
  assert.equal(picksBeforeAsking("Here are three recipes under $10 a head.", "find 3 recipes I can cook for 30 people"), false, "cooking they asked for");
  for (const fine of ["Do you want to cook, or have it catered?", "Lucky Wok is $8.50 a person all in. Want me to ask about a standing Wednesday order?"]) {
    assert.equal(picksBeforeAsking(fine, asked), false, fine);
  }
  // Not asked for options, so an "if you'd rather" is just a reply.
  assert.equal(picksBeforeAsking(cooked, "what should I make for dinner tonight?"), false);
  const chat = claimCheck({ question: "3 dinner options for 30" });
  assert.equal(chat.check(cooked), ASK_FIRST_NOTICE);
  assert.equal(chat.check(cooked), null, "only once a turn");
  assert.equal(claimCheck({ question: "x", job: { attempt: 1 } }).check(cooked), null, "a job never stops to ask");
});
