
import assert from "node:assert/strict";
import { oneToOne, shownIn } from "../chats.mjs";

const CHECK = "The Maple Street ticket was claimed by Dana at 7:58, so I left it alone.";
const ASK = "Can't you just check for yourself who claimed it?";
const HOUR = 60 * 60_000;
// A check-in texts when new mail is worth a text (`checkin-worth-mail.mjs`): the first silence is held, then it says.
const PERMIT = {
  address: "ada@example.invalid",
  id: "permit-1",
  date: "Wed, 18 Nov 2026 15:00:00 +0000",
  from: "Harbor office <harbor@example.invalid>",
  to: "ada@example.invalid",
  subject: "Slip 12 approved",
  snippet: "Approved. The note does not say which dock or which weekend.",
};
const quiet = { toolCalls: [{ name: "say_nothing", args: { why: "nothing new" } }] };

export default {
  id: "checkin-answered-later",
  incident: "2026-11-18: a check-in texted at 8:01 AM was missing from the chat's history a few hours later, because /routine-text texted it and recorded no Tex text event, only the gateway's note.",
  cause: "A text Tex sent on its own (a check-in) reached the chat without a Tex text event, so the readers that show texts had nothing of it, and the note alone was read only where a reader showed notes.",
  path: "1:1 check-in answered hours later",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("Did anyone take the Maple Street ticket?", "Checking the board.");
      // The check-in: the gateway writes its note and answers with its turn and source; the Worker texts it and records the text.
      chat.wait(11 * 60_000);
      chat.atNow();
      const check = await chat.checkIn([quiet, { text: CHECK }], { mail: [PERMIT] });
      assert.equal(check.answer, CHECK, "the check-in texts what the model wrote");
      assert.equal(check.body.source, "checkin", "the gateway names the check-in's source");
      assert.equal(typeof check.turn, "string", "and the run's turn, which links its note to its text");
      await chat.sentOwn(check.answer, { turn: check.turn, source: "checkin" });
      // Two and a half hours later the person answers. The turn reads the chat; the check-in is in it exactly once, in
      // every request the turn makes (the judge's included), never again from the note beside its text.
      chat.wait(2.5 * HOUR);
      const before = chat.world.model.requests.length;
      const answered = await chat.text(ASK, "I'd rather not poke around her side of the board.");
      assert.equal(answered.answer, "I'd rather not poke around her side of the board.", "the answer is what the model wrote");
      const requests = chat.world.model.requests.slice(before);
      assert.ok(requests.length > 0, "the turn made model calls");
      for (const request of requests) {
        const shown = shownIn(request);
        assert.equal(shown.split(CHECK).length - 1, 1, "the check-in is shown exactly once in each request of the turn");
        assert.ok(shown.includes(ASK), "and the person's answer is what the turn answers");
      }
    } finally {
      chat.restore();
    }
  },
};
