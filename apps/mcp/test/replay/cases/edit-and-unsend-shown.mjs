import assert from "node:assert/strict";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../src/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "edit-and-unsend-shown",
  incident: "2026-11-16: a person edited a text on Photon's line (iMessage Edit) and unsent another (Undo Send); the bridge heard both, the texting Worker counted them and dropped them, so Tex kept answering the words they had replaced or taken back.",
  cause: "No step took an edit or an unsend: they never reached the chat's record, and no turn saw them.",
  path: "1:1 text",
  // Sabotage (2026-11-16): drop "edited" and "unsent" from log.js FIELDS and the flush is refused; drop the mark in
  // logRender.js `words` and the turn is shown the new words as a plain text, with nothing saying what they replaced.
  async run() {
    const chat = await oneToOne();
    try {
      const first = await chat.text("can you book dinner for 4 at 6?", "Booked for 4 at 6pm.");
      // The edit step's turn (`packages/tex/worker/editStep.ts`): the new words, marked as the edit of the first text.
      const edited = await chat.text("can you book dinner for 6 at 6?", "Changed it to 6 people.", { fields: { edited: true, replyTo: first.id, quoted: "can you book dinner for 4 at 6?" } });
      assert.match(edited.shown, /\(edited an earlier text to\) can you book dinner for 6 at 6\?/, "the turn is told the text is an edit");
      assert.match(edited.shown, /the edit of their [^"]+ message, which said: \\"can you book dinner for 4 at 6\?\\"/, "and what it replaced");
      // An unsend, kept with no turn, then their next text.
      const later = await chat.text("also a table outside", "Asked for outside.");
      await chat.keep({ text: "", unsent: true, replyTo: later.id, quoted: "also a table outside" });
      chat.deploy();
      const next = await chat.text("what time is it booked for?", "6pm.");
      assert.match(next.shown, /\(unsent an earlier text\)/, "a later turn sees the text was taken back");
      assert.match(next.shown, /they took back their [^"]+ message, which said: \\"also a table outside\\"/);
      assert.doesNotMatch(next.shown, /\(unsent an earlier text\)\s+\(not answered\)/, "a text taken back is never a to-do");
      const kept = (await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries;
      assert.ok(kept.some((entry) => entry.edited === true && entry.replyTo === first.id), "the record keeps the edit beside the text it changed");
      assert.ok(kept.some((entry) => entry.unsent === true && entry.replyTo === later.id), "and the unsend beside the text taken back");
    } finally {
      chat.restore();
    }
  },
};
