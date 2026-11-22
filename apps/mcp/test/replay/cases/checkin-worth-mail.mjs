import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

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

/** The Quiet check's answer (`graph/nodes/quietCheck.js`), as its model calls the verdict tool. */
const verdict = (speak, why) => ({ toolCalls: [{ name: "verdict", args: { speak, why } }] });

export default {
  id: "checkin-worth-mail",
  incident:
    "2026-11-17: a check-in that had found mail worth a text stayed quiet, because the instructions say most looks stay quiet. " +
    "2026-11-22: the word list that fixed it (any mail not a newsletter holds the first silence) held a right silence, and Tex offered to RSVP yes to an invite already accepted.",
  cause:
    "The first say_nothing was accepted, then judged by a word list. Now the Quiet check step judges it (checkin -> quietCheck): a speak verdict holds the first silence with what to text about; a quiet one lets it stand, whatever the mail is.",
  path: "a check-in with new mail",
  async run() {
    const chat = await oneToOne();
    try {
      const said = "Slip 12 is approved, and the email never says which dock or which weekend. Want me to open the permit?";
      const worth = await chat.checkIn([quiet, verdict(true, "the slip is approved and the dock and weekend are missing."), { text: said }], { mail: [PERMIT] });
      assert.equal(worth.answer, said, "a speak verdict holds the first silence, and the look says it");
      assert.match(worth.shown, /You are the Quiet check in Tex/, "the Quiet check judged the silence");
      assert.match(worth.shown, /Before this goes quiet: the slip is approved and the dock and weekend are missing\./, "the look is told what to text about");
      const answered = await chat.checkIn([quiet, verdict(false, "they already answered it."), { text: "should not be asked" }], { mail: [PERMIT] });
      assert.equal(answered.answer, "", "a quiet verdict lets the silence stand, even on mail that is not a newsletter");
      assert.doesNotMatch(answered.shown, /not a newsletter/, "the word list no longer holds it");
    } finally {
      chat.restore();
    }
  },
};
