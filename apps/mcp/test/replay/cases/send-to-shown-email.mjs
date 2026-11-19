import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const DANA = "dana@clinic.example";
/** The copy Tex shows Rowan and Rowan reads: opens "Hi Dana, could we", ends "Best, Rowan" on one line. */
const BODY = "Hi Dana, could we move our Tuesday check-in to Thursday at 10?\nIt keeps the same room and the same length.\n\nBest, Rowan";
/** Tex rewords the copy after the "send": same opening, same closing, other words. */
const REWORDED = "Hi Dana, could we move our Tuesday check-in to Thursday at 10 instead?\nIt keeps the same room and length.\n\nBest, Rowan";
const EMAIL = { to: [DANA], subject: "Tuesday check-in", body: BODY };
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });

export default {
  id: "send-to-shown-email",
  incident:
    "2026-11-19 (Training, a trial hire's chat): Tex showed the whole email and asked \"Send?\"; the person said \"send\", Tex reworded it, and the Mail checker refused a copy they had never seen.",
  cause:
    "A text ending in \"Send?\" was not read as an offer, so the person's yes agreed to nothing; and nothing handed Tex back the copy the person approved.",
  path: "1:1 texts that send email",
  async run() {
    const chat = await oneToOne();
    try {
      // Gmail can send for this person in this world (`emailSender`), and the Mail checker is a model call of the turn.
      chat.world.controlPlane.flags.emailSender = "rowan@gmail.example";

      // Earlier: an email is asked for, and Tex names who it goes to.
      await chat.text("can you email Dana about moving our Tuesday check-in?", `Send to ${DANA} on her thread?`);
      // A change, and Tex shows the whole email, then asks "Send?".
      const shown = await chat.text("make it Thursday at 10 and say it keeps the room", `${BODY}\nSend?`);
      assert.equal(shown.answer, `${BODY}\nSend?`, "the copy is shown whole, ending in Send?");

      // The person says "send". Tex first sends a reworded copy, then the exact copy it showed.
      const sent = await chat.text("send", [
        { toolCalls: [{ name: "send_email", args: { ...EMAIL, body: REWORDED } }] },
        { toolCalls: [{ name: "send_email", args: EMAIL }] },
        verdict("yes", "they said send"),
        { text: "Sent it to Dana." },
      ]);
      assert.match(sent.shown, /they said yes to the copy you showed them/, "the rewrite is handed back as the copy they said yes to");
      assert.ok(sent.shown.includes(JSON.stringify(BODY).slice(1, -1)), "the handback carries the shown copy");

      const sends = chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.draft !== true && entry.answer?.ok === true);
      assert.equal(sends.length, 1, "exactly one real send");
      assert.deepEqual(sends[0].email.to, [DANA], "to the person Tex named");
      assert.equal(sends[0].email.body, BODY, "its body is the copy they were shown, word for word");
      assert.equal(chat.world.pending().length, 0, "nothing held for a second 👍");
    } finally {
      chat.restore();
    }
  },
};
