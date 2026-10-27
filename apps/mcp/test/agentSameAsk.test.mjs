/**
 * A CHANGE THEY PUSHED BACK ON IS NEVER SHOWN TO THEM AGAIN.
 *
 * The case, from a reviewed chat (2026-10-27, @context-lc
 * areas/tex-reviews/themes/repeats-after-correction.md):
 *
 *   Tex:  Austin (6:30–6:45 pm) and Sarah (6:30–7 pm) overlap tonight.
 *   Them: maybe make sarah's meeting 15 min
 *   Tex:  Here's the change I'd make: Sarah / Seyi … 6:30 to 6:45 pm …
 *   Them: but they're both still at 6:30
 *   Tex:  Sarah's is still 6:30 to 7 because the change is waiting on your 👍.
 *   Them: are you dumb … you have to move one of them to start at a different time
 *   Tex:  Sorry, I should have moved one of them.
 *         Here's the change I'd make: (the same block, word for word)
 *
 * Fixed by `src/agent/sameAsk.js`: a held call whose shown copy is one Tex
 * already texted them, with no yes since, is withdrawn and the model is told
 * to make the change their words ask for. A bare opening apology comes off
 * the answer (`pushback.js`).
 *
 * Sabotage (temporary local edits, reverted):
 *  - `withSameAsk` returning `call` unchanged: "the same change after a
 *    pushback is not shown again" fails;
 *  - `shownAndNotTaken` ignoring a yes in their texts: "a yes that reached the
 *    model may show the same change again" fails;
 *  - `APOLOGY` left out of `withoutFlattery`: "a bare opening apology comes
 *    off" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SAME_ASK, shownAndNotTaken } from "../src/agent/sameAsk.js";
import { withoutFlattery } from "../src/agent/pushback.js";
import { ask, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const SHORTER = { action: "move", title: "Sarah / Seyi", start: "2026-10-27T18:30:00-04:00", new_start: "2026-10-27T18:30:00-04:00", new_end: "2026-10-27T18:45:00-04:00" };
// The model's second try differs in an argument the person never reads.
const SHORTER_AGAIN = { ...SHORTER, all_events: true };
const LATER = { ...SHORTER, new_start: "2026-10-27T18:45:00-04:00", new_end: "2026-10-27T19:00:00-04:00" };

const sent = (asked) => [asked.body?.answer ?? "", ...(asked.body?.verbatim ?? [])].join("\n");

test("the same change after a pushback is not shown again, and the corrected one is", async () => {
  const world = await createEgressWorld();
  const { model, env, pending, bucket, controlPlane } = world;
  try {
    controlPlane.flags.calendarAddress = "seyi@gmail.example";
    controlPlane.flags.calendarGuests = ["sarah@example.test"];

    model.install([{ toolCalls: [{ name: "calendar_event", args: SHORTER }] }, { text: "Sarah / Seyi today: 6:30 to 6:45 pm instead of 6:30 to 7." }]);
    const first = await ask(env, TOKEN_TEXTS, "maybe make sarah's meeting 15 min");
    assert.match(sent(first), /Give it a 👍/, "the first change is put to them");
    const block = (first.body?.verbatim ?? []).find((text) => text.includes("Give it a 👍"));
    assert.ok(block, "the ask went out on its own");

    model.install([{ text: "Sarah's is still 6:30 to 7 because the change is waiting on your 👍." }]);
    await ask(env, TOKEN_TEXTS, "but they're both still at 6:30");

    // The model tries the same change again, the way it did on 2026-10-27, then the right one.
    model.install([
      { toolCalls: [{ name: "calendar_event", args: SHORTER_AGAIN }] },
      { toolCalls: [{ name: "calendar_event", args: LATER }] },
      { text: "Sorry, I should have moved one of them. Moving Sarah's to 6:45 to 7, Austin stays at 6:30." },
    ]);
    const third = await ask(env, TOKEN_TEXTS, "are you dumb, i need to meet with both of them, you have to move one of them to start at a different time");
    assert.ok(model.requests.some((req) => JSON.stringify(req.messages ?? []).includes(SAME_ASK.slice(0, 60))), "the model is told the repeat was not shown");
    const said = sent(third);
    assert.doesNotMatch(said, /6:30 to 6:45 pm\n/, "the change they pushed back on is not shown again");
    assert.match(said, /6:45 to 7/, "the corrected change is put to them");
    assert.doesNotMatch(said, /^Sorry/m, "no reflexive apology opens it");
    const waiting = pending().map((key) => JSON.parse(bucket.get(key).body)).filter((record) => record.texting === true);
    assert.equal(waiting.length, 1, "one change waits for their 👍");
    assert.equal(waiting[0].args.new_start, LATER.new_start, "and it is the corrected one");
  } finally {
    world.restore();
  }
});

test("a yes that reached the model may show the same change again", () => {
  const detail = "Change on your Google Calendar:\nSarah / Seyi, Tuesday, October 27, 6:30 pm\nNew time: 6:30 to 6:45 pm";
  const history = [
    { role: "user", text: "maybe make sarah's meeting 15 min" },
    { role: "assistant", text: `Here's the change I'd make:\n\n${detail}\n\nGive it a 👍 and I'll make the change.` },
  ];
  assert.equal(shownAndNotTaken(detail, history, "but they're both still at 6:30"), true);
  assert.equal(shownAndNotTaken(detail, history, "yes"), false, "a yes asks for exactly that");
  assert.equal(shownAndNotTaken(detail, [...history, { role: "user", text: "ok do it" }], "move it back"), false, "a yes since then");
  assert.equal(shownAndNotTaken("Change: 7 pm", history, "no"), false, "too short to tell apart");
  assert.equal(shownAndNotTaken(detail, [{ role: "user", text: "hi" }], "no"), false, "never shown");
});

test("a bare opening apology comes off, sympathy stays", () => {
  assert.equal(withoutFlattery("Sorry, I should have moved one of them."), "I should have moved one of them.");
  assert.equal(withoutFlattery("Sorry. Austin stays 6:30 to 6:45."), "Austin stays 6:30 to 6:45.");
  assert.equal(withoutFlattery("My bad, moving it now."), "Moving it now.");
  assert.equal(withoutFlattery("Sorry to hear that, feel better."), "Sorry to hear that, feel better.");
  assert.equal(withoutFlattery("Sorry."), "Sorry.", "nothing left, nothing taken");
});
