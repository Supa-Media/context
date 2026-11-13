import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "after-deploy",
  incident: "2026-11-12: texts held in the Worker's memory were written to the chat late after a deploy (3.3 hours), so the History and the next turn missed them (#3224).",
  cause: "Something the next turn needs lived only in memory a deploy wipes.",
  path: "1:1 text across a deploy",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("my sister lands at 6:40 tonight", "Got it: 6:40 tonight.");
      chat.deploy();
      chat.wait(20 * 60_000);
      const after = await chat.text("when does she land?", "6:40 tonight.");
      assert.match(after.shown, /my sister lands at 6:40 tonight/, "a cold turn after a deploy still sees the earlier text");
      assert.match(after.shown, /Got it: 6:40 tonight\./, "and what Tex said to it");
    } finally {
      chat.restore();
    }
  },
};
