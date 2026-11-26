import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const MAILBOX = "rowan@clinic.example";
const ALIAS = "frontdesk@clinic.example";
const REPLY = {
  from: ALIAS,
  to: ["mary.jane@example.com"],
  subject: "Re: Start of care",
  body: "Hi Mary Jane,\n\nWe received the authorization and will confirm the start date by Friday.\n\nFront desk",
  in_reply_to: `email:${MAILBOX}/18cafe`,
};
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });

export default {
  id: "send-as-alias",
  incident:
    "2026-11-26: a person whose work Gmail sends as the practice's front-desk group address (Gmail's \"Send mail as\") asked Tex to answer an email as that address; Tex could only send from the connected mailbox's own address.",
  cause:
    "Nothing read Gmail's send-as list: the control plane took only a connected mailbox's own address as from, the gateway refused a reply whose from differed from its email's mailbox, and the turn was never told the aliases existed.",
  path: "1:1 texts that send email",
  async run() {
    const chat = await oneToOne();
    try {
      chat.world.controlPlane.flags.emailSender = MAILBOX;
      chat.world.controlPlane.flags.emailSendAs = { [ALIAS]: MAILBOX };
      chat.world.controlPlane.dreams.mailHealth.mailboxes.set("ws_egress", [
        { address: MAILBOX, state: "ok", lastSyncedAt: Date.now(), tell: false, readOnly: false, sendsAs: [ALIAS] },
      ]);
      const sends = () => chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.answer?.ok === true);

      const held = await chat.text("reply to mary jane from the front desk address, say we got the authorization", [
        { toolCalls: [{ name: "send_email", args: REPLY }] },
        verdict("yes", "they asked for this reply"),
        { text: "Here it is for your 👍." },
      ]);
      const system = JSON.stringify(chat.world.model.requests[0]?.system ?? "");
      assert.match(system, /rowan@clinic\.example \[send as: frontdesk@clinic\.example\]/, "the turn is told the mailbox's alias, as data");
      assert.equal(chat.world.pending().length, 1, "the reply from the alias is held, never refused");
      const ask = held.body.verbatim?.[0] ?? "";
      assert.match(ask, /From: frontdesk@clinic\.example/, "the person is shown the alias it goes from");

      await chat.text("👍", [], { body: { quoted: ask, tapback: "Liked" } });
      assert.equal(sends().length, 1, "their 👍 sends it");
      assert.equal(sends()[0].email.from, ALIAS);
      assert.equal(sends()[0].email.mailbox, MAILBOX, "through the mailbox its email is in");
      assert.equal(sends()[0].email.replyTo, "18cafe");
    } finally {
      chat.restore();
    }
  },
};
