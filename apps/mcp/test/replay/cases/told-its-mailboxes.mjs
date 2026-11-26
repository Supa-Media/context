import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { gmailMessageToEvent } from "../../../src/communications/gmailSync.js";
import { fixtureMessage } from "../../gmailSync/fixtures.mjs";

const REPORT = "https://reports.example.com/view?id=42&format=pdf";

export default {
  id: "told-its-mailboxes",
  incident:
    "2026-11-14: one of a person's four Gmails failed every live search for an afternoon; Tex guessed which mailboxes it had from the results, wrote the address under the wrong name, and told the person its live search only reached another of their addresses. " +
    "2026-11-16: a vendor's email said only \"Click here to view the report in (pdf) format\", and Tex never saw the address behind it. " +
    "2026-11-26: a person whose work Gmail sends as the practice's front-desk group address (Gmail's \"Send mail as\") asked Tex to answer an email as that address; Tex could only send from the mailbox's own address.",
  cause:
    "Nothing told a turn which mailboxes the person has connected, or that one of them was not fine, so the model inferred both from one search's answer. An email's HTML became its words alone, every link's address dropped. " +
    "Nothing read Gmail's send-as list: the control plane took only a mailbox's own address as from, the gateway refused a reply whose from differed from its email's mailbox, and the turn was never told the aliases.",
  path: "1:1 texts that search mail",
  async run() {
    const chat = await oneToOne();
    try {
      chat.world.controlPlane.dreams.mailHealth.mailboxes.set("ws_egress", [
        { address: "rowan@work.example", state: "ok", lastSyncedAt: Date.now(), tell: false, readOnly: false, sendsAs: ["frontdesk@work.example"] },
        { address: "rowan.home@mail.example", state: "stale", lastSyncedAt: Date.now() - 30 * 60 * 60_000, tell: false, readOnly: false },
      ]);
      const first = await chat.text("did my cinema ticket come through?", "Let me look.");
      const requests = chat.world.model.requests;
      const body = requests.at(-1) ?? {};
      const system = JSON.stringify(body.system ?? "");
      const messages = JSON.stringify(body.messages ?? []);
      assert.match(system, /Their connected mailboxes: rowan@work\.example \[send as: frontdesk@work\.example\], rowan\.home@mail\.example/, "the turn is told every connected mailbox and its send-as addresses, as data, in the cached part");
      assert.match(system, /searches every one of them at once/, "and that one search asks them all");
      assert.ok(!system.includes("hasn't synced"), "a mailbox's state is never in the cached part");
      assert.match(messages, /rowan\.home@mail\.example hasn't synced for hours/, "the one not fine now is named per text");
      assert.ok(first.shown.includes("rowan@work.example"));

      // An email read live keeps its links' addresses: the body is what the control plane makes of Gmail's message (`gmailMessageToEvent`).
      const vendor = fixtureMessage({
        id: "m-report",
        from: "Reports <reports@vendor.example>",
        to: "rowan@work.example",
        subject: "Your weekly report",
        text: "Your weekly report is ready.\nClick here to view the report in (pdf) format",
        html: `<p>Your weekly report is ready.</p><p><a href="${REPORT.replace("&", "&amp;")}">Click here</a> to view the report in (pdf) format</p>`,
      });
      const event = gmailMessageToEvent(vendor, { mailboxSlug: "live" });
      chat.world.controlPlane.flags.mailMessage = { address: "rowan@work.example", id: "m-report", threadId: "m-report", date: "2026-11-16", from: "Reports <reports@vendor.example>", to: "rowan@work.example", subject: event.subject, body: event.body, attachments: [] };
      const read = await chat.text("open the weekly report email", [
        { toolCalls: [{ name: "fetch", args: { id: "email:rowan@work.example/m-report" } }] },
        { text: "It links the report." },
      ]);
      assert.match(read.shown, /Click here \[https:\/\/reports\.example\.com\/view\?id=42&format=pdf\] to view the report/, "the address behind the link is read with its words");

      // A reply as the mailbox's send-as address is held showing that From, and their 👍 sends it through the mailbox.
      chat.world.controlPlane.flags.emailSender = "rowan@work.example";
      chat.world.controlPlane.flags.emailSendAs = { "frontdesk@work.example": "rowan@work.example" };
      const sends = () => chat.world.controlPlane.emailCalls.filter((entry) => !entry.check && entry.answer?.ok === true);
      const reply = { from: "frontdesk@work.example", to: ["reports@vendor.example"], subject: "Re: Your weekly report", body: "Thanks, received.\n\nFront desk", in_reply_to: "email:rowan@work.example/m-report" };
      const held = await chat.text("reply to the report email from the front desk address, say thanks", [
        { toolCalls: [{ name: "send_email", args: reply }] },
        { text: JSON.stringify({ verdict: "yes", reason: "they asked for this reply" }) },
        { text: "Here it is for your 👍." },
      ]);
      assert.equal(chat.world.pending().length, 1, "the reply from the alias is held, never refused");
      const ask = held.body.verbatim?.[0] ?? "";
      assert.match(ask, /From: frontdesk@work\.example/, "the person is shown the alias it goes from");
      await chat.text("👍", [], { body: { quoted: ask, tapback: "Liked" } });
      assert.equal(sends().length, 1, "their 👍 sends it");
      assert.equal(sends()[0].email.from, "frontdesk@work.example");
      assert.equal(sends()[0].email.mailbox, "rowan@work.example", "through the mailbox its email is in");
      assert.equal(sends()[0].email.replyTo, "m-report");
    } finally {
      chat.restore();
    }
  },
};
