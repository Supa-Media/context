import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const DAY = 24 * 60 * 60_000;

export default {
  id: "finds-old-line",
  incident:
    "2026-11-12 durable-memory audit, taken up 2026-11-25: asked when something was said weeks ago, Tex could read only the last 7 days word for word, " +
    "each older day's summary and one day by its date, so it guessed a day or said it couldn't find it (Dev2 chose a word search over the chat's own history).",
  cause: "No tool looked through the chat's ledger by what was said; every read of it was by recency or by a date.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    chat.later(-30 * DAY);
    const realNow = Date.now;
    Date.now = () => realNow() - 30 * DAY;
    try {
      await chat.text("my cousin's wedding is in Lisbon on the 14th", "Noted: Lisbon wedding on the 14th.");
    } finally {
      Date.now = realNow;
    }
    try {
      chat.later(30 * DAY);
      const asked = await chat.text("when did I tell you about the wedding?", [
        { toolCalls: [{ name: "search", args: { query: "wedding", args: { history: true, oldest: true } } }] },
        { text: "About 30 days ago: Lisbon, on the 14th." },
      ]);
      assert.match(asked.shown, /@?\w*:? ?my cousin's wedding is in Lisbon on the 14th/, "the search finds the text from 30 days back");
      assert.match(asked.shown, /oldest first/, "oldest first, for when it was first said");
      assert.match(asked.shown, /fetch \{\\"id\\": \\"day:\d{4}-\d{2}-\d{2}\\"\}/, "with the fetch that opens that day");
      assert.equal(asked.answer, "About 30 days ago: Lisbon, on the 14th.");
    } finally {
      chat.restore();
    }
  },
};
