import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "record-before-answer",
  incident:
    "2026-11-17: a turn answered what a note said without searching or fetching. The prompt already said to read the record first. The front door's check did not hold it. A check-in that mentions the chat is not that ask.",
  cause:
    "The front door's code check looked at an untried web and at figures. An ask to read a note, a page, mail or the calendar, with no read, went out.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      const unread = await chat.text("what does the note say about the trip", [
        { text: "The trip note says Lisbon in October." },
        { toolCalls: [{ name: "search", args: { query: "trip" } }] },
        { text: "The note says October 14 to 18." },
      ]);
      assert.match(unread.shown, /have not read any of it this turn/, "a note ask with no read is sent back");
      assert.match(unread.answer, /October 14 to 18/, "the rewrite answers after the read");
      const checkIn = await chat.text("(Time for this chat's check-in: look on your own at what is new. If nothing needs the chat, answer exactly SKIP.)", "SKIP");
      assert.equal(checkIn.answer, "SKIP", "a check-in that mentions the chat is not sent back for a read");
    } finally {
      chat.restore();
    }
  },
};
