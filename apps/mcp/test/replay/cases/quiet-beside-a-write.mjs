import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "quiet-beside-a-write",
  incident: "2026-11-16: a reminder was set and no text went out. In its first round the model called the routine write and say_nothing together, before it had seen the write's answer, and the turn ended quiet.",
  cause: "turn.js ended the turn on say_nothing even when another call came in the same round, so the model never saw what that call did.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      const { answer } = await chat.text("remind me to book the train on friday", [
        {
          toolCalls: [
            { name: "write", args: { path: "tex/routines/once/book-the-train.md", content: "---\nat: 2026-11-20 9:00 am\n---\n\nRemind them to book the train.\n" } },
            { name: "say_nothing", args: { reason: "placeholder" } },
          ],
        },
        { text: "Will do." },
      ]);
      assert.equal(answer, "Will do.", "say_nothing beside another call waits for that call's answer, and the turn goes on to its text");
    } finally {
      chat.restore();
    }
  },
};
