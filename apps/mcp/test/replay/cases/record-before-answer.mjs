import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "record-before-answer",
  incident:
    "2026-11-17: a turn answered what a note and an email said without searching or fetching, and a turn that had already written the change still ended by offering something further. The prompts already forbade both. Nothing in the answer check held them.",
  cause:
    "The code checks looked at claims of a write and at offers that need a yes. An ask about a record with no read, and an extra offer after a finished write, were only words in the prompt.",
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
      const offered = await chat.text("add oat milk to the shopping list", [
        { toolCalls: [{ name: "write_note", args: { path: "todo.md", content: "- oat milk" } }] },
        { text: "Added. Want me to set up a weekly grocery order too?" },
        { text: "Added." },
      ]);
      assert.match(offered.shown, /Don't add an offer/, "a finished write that still offers more is sent back");
      assert.equal(offered.answer, "Added.");
    } finally {
      chat.restore();
    }
  },
};
