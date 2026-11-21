import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const DANA = "dana@clinic.example";
const BODY = "Hi Dana, could we move our Tuesday check-in to Thursday at 10?\n\nBest, Rowan";
const EMAIL = { to: [DANA], subject: "Tuesday check-in", body: BODY };
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });

export default {
  id: "send-draft-settles",
  incident:
    "2026-11-20 (Dev2): the in-app approval card for an email is answered by replying \"send the draft\"; the word \"draft\" was not in the texted yes's word list, so the reply went to the model instead of sending it.",
  cause:
    "A texted yes settles an ask only when every word of the reply is a known yes or send word, and \"draft\" was not one, so a reply naming the held draft fell through to the model.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      // Gmail can send for this person in this world (`emailSender`).
      chat.world.controlPlane.flags.emailSender = "rowan@gmail.example";

      // Earlier: an email is asked for, and Tex names who it goes to.
      await chat.text("can you email Dana about moving our Tuesday check-in?", `Send to ${DANA} on her thread?`);
      // Tex holds the email for the person's yes and puts it to them whole.
      const asked = await chat.text("make it Thursday at 10", [
        { toolCalls: [{ name: "send_email", args: EMAIL }] },
        verdict("yes", "the copy is the change they asked for"),
        { text: "Drafted it for Dana." },
      ]);
      assert.match(asked.answer, /Here's the email I'd send/, "the email is put to the person whole");
      assert.ok(asked.answer.includes(BODY), "the ask carries the copy a yes will send");
      assert.equal(chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.draft !== true && entry.answer?.ok === true).length, 0, "nothing is sent before the yes");

      // The person replies "send the draft" to the card. The gateway settles it: no model call, and the done line is the answer.
      const sent = await chat.text("send the draft", []);
      assert.equal(sent.shown, "", "no model was shown the reply: the yes settled before any model ran");
      assert.match(sent.answer, /^Done, I sent /, "the answer is the done line for the send");

      const sends = chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.draft !== true && entry.answer?.ok === true);
      assert.equal(sends.length, 1, "exactly one real send");
      assert.deepEqual(sends[0].email.to, [DANA], "to the person Tex named");
      assert.equal(sends[0].email.body, BODY, "its body is the copy they were shown, word for word");
      assert.equal(chat.world.pending().length, 0, "nothing held after the yes");
    } finally {
      chat.restore();
    }
  },
};
