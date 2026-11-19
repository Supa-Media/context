import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const VENDOR = "orders@vendor.example";
const SUBJECT = "Thursday delivery of the peonies";
const BODY = "Hi Marisol,\n\nThursday works for the peony delivery. Please bring it to the back door before 8.\n\nThanks,\nBellwether Blooms";
const DRAFT = { to: [VENDOR], subject: SUBJECT, body: BODY };

export default {
  id: "redo-not-already-done",
  incident:
    "2026-11-19: a 1:1 front-door turn was asked again to save a reply as an email draft. It answered that it had already done that earlier and the draft was saved, with no tool this turn. The earlier draft had been deleted.",
  cause:
    "Earlier answers were trusted as the current state, and the front door's code check had no check for a claim that an action still stands. The console 1:1 ran no answer check at all.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      // Their Gmail can save drafts in this world (`emailDrafter`), as a connection that granted compose does.
      chat.world.controlPlane.flags.emailSender = "rowan@gmail.example";
      chat.world.controlPlane.flags.emailDrafter = "rowan@gmail.example";
      // Turn 1: a reply is drafted and saved as a draft, not sent.
      const first = await chat.text("draft a reply to the vendor about Thursday's peonies and save it as a draft, don't send", [
        { toolCalls: [{ name: "send", args: { action: "email_draft", args: DRAFT } }] },
        { text: "Saved the reply as a draft. Nothing was sent." },
      ]);
      assert.match(first.answer, /Saved the reply as a draft/, "turn 1 ends cleanly after the draft call");

      // Turn 2: the draft is gone, and the person asks for it again. The earlier answer is not a check.
      const again = await chat.text("the draft's gone from my drafts, can you save that vendor reply as a draft again? don't send", [
        { text: "I already did this earlier. The reply is saved as a draft in your account. Nothing was sent." },
        { toolCalls: [{ name: "send", args: { action: "email_draft", args: DRAFT } }] },
        { text: "Saved it again as a new draft; nothing was sent." },
      ]);
      assert.match(again.shown, /nothing in this turn did it or looked at it/, "the claim with no call this turn is sent back");
      assert.doesNotMatch(again.answer, /already did/i, "the answer does not repeat the earlier claim");
      assert.match(again.answer, /Saved it again/, "the answer reports from this turn's call");
      assert.ok(
        again.body.steps?.some((step) => JSON.stringify(step).includes("email_draft") || JSON.stringify(step).includes("save_email_draft")),
        "the draft call is a step of this turn",
      );

      // A status question is looked up, not answered from memory: a search this turn, then the answer.
      chat.world.controlPlane.flags.mailboxes = [{ address: "rowan@gmail.example", folder: "0-inbox/email" }];
      chat.world.controlPlane.flags.mailResults = () => [];
      const status = await chat.text("is that vendor draft still there?", [
        { toolCalls: [{ name: "search", args: { query: "in:drafts vendor", args: { email: true, account: "rowan@gmail.example" } } }] },
        { text: "Yes, the vendor reply is still in your drafts." },
      ]);
      assert.doesNotMatch(status.shown, /nothing in this turn did it or looked at it/, "a status answer after a search this turn is not sent back");
    } finally {
      chat.restore();
    }
  },
};
