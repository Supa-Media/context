import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const JO = "jo.marsh@example.com";
const EMAIL = { to: [JO], subject: "Thursday", body: "Hi Jo,\n\nThursday at 4 works for me.\n\nRowan" };
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });

export default {
  id: "checker-no-held",
  incident:
    "2026-11-24: the Mail checker said \"no\" to an email; it was refused before anything was held, Tex asked in its own words, the person's 👍 on that matched no ask, nothing was sent, and Tex could still say it was.",
  cause:
    "A checker \"no\" returned a refusal with no pending record or Approve card, and no check stopped an answer that says an email was sent when no send went through.",
  path: "1:1 texts that send email",
  async run() {
    const chat = await oneToOne();
    try {
      chat.world.controlPlane.flags.emailSender = "rowan@gmail.example";
      const sends = () => chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.draft !== true && entry.answer?.ok === true);

      // The checker says "no"; Tex first claims it went, and is sent back once before its answer goes.
      const held = await chat.text("tell Jo thursday might work, I'll confirm later", [
        { toolCalls: [{ name: "send_email", args: EMAIL }] },
        verdict("no", "they said they would confirm later"),
        { text: "Sent!" },
        { text: "Drafted the email to Jo." },
      ]);
      assert.equal(sends().length, 0, "a checker no sends nothing");
      assert.equal(chat.world.pending().length, 1, "it is held, with a pending record the 👍 can approve");
      assert.equal(held.body.asked, 1, "and put to the person as the gateway's own ask");
      assert.match(held.shown, /Held for their 👍/, "the model is told it is held");
      assert.doesNotMatch(held.shown, /Not sent, and not put to the person/, "never refused into an ask in Tex's words");
      assert.match(held.shown, /your answer says an email was sent, but no email went out/, "the false \"Sent!\" is sent back");
      assert.doesNotMatch(held.answer, /^Sent!/, "and never texted");

      // Their 👍 on the ask sends that exact email, with no model.
      const ask = held.body.verbatim?.[0] ?? "";
      assert.ok(ask.includes(JO), "the ask shows who it goes to");
      const liked = await chat.text("👍", [], { body: { quoted: ask, tapback: "Liked" } });
      assert.equal(sends().length, 1, "the 👍 sends it");
      assert.equal(sends()[0].email.body, EMAIL.body, "the copy they were shown");
      assert.equal(chat.world.pending().length, 0);
      assert.match(liked.answer, /sent/i);
    } finally {
      chat.restore();
    }
  },
};
