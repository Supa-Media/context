/**
 * A CHECK-IN LEARNS FROM THE TRAINING CHECK-INS (Dev set, 2026-11-17: every check-in that found a new email, a flight
 * delay, a form due before boarding, plans that clash with a flight, stayed quiet, while the Training set's check-ins
 * all text). A check-in answers in its own model call (`heartbeat.js`), never through the Front door's prompt modules,
 * so its model was shown none of the Training check-ins the Front door learns from. Its look is now shown them, from
 * its config context (`train:checkin`, `texTraining.cjs` VIA_READERS).
 *
 * Sabotage: blanking `examples` in the look's question (`heartbeat.js`) fails this; checked 2026-11-17.
 * The replay set is full (20 cases a step), so this runs the replay's own chat as a unit test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { oneToOne } from "./replay/chats.mjs";

test("a check-in's look is shown the Training check-ins, never the check-in code's own output", async () => {
  const chat = await oneToOne();
  try {
    await chat.text("my flight home is sunday at 1:15", "Got it, Sunday 1:15.");
    const delay = { address: "me@example.invalid", id: "n1", threadId: "n1", date: new Date().toISOString(), from: "Air Example", to: "me@example.invalid", subject: "AX 12 delayed 50 minutes", body: "New departure 2:05pm.", attachments: [], snippet: "New departure 2:05pm." };
    const look = await chat.checkIn("Your flight's running 50 minutes late, now 2:05.", { mail: [delay] });
    assert.match(look.shown, /AX 12 delayed 50 minutes/, "the look found the email");
    assert.match(look.shown, /Examples from Tex's Training Set/, "the look is shown Training examples");
    assert.match(look.shown, /Check-in, nobody texted/, "and they are check-ins: turns nobody texted");
    assert.doesNotMatch(look.shown, /<to>look<\/to>/, "never the check-in code's own output as an example");
  } finally {
    chat.restore();
  }
});
