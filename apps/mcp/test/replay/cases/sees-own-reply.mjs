import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "sees-own-reply",
  incident: "2026-11-02 to 11-05: a speed change made 1:1 turns read a copy of the chat sealed before Tex answered, so Tex saw the person's texts and none of its own answers (#2724, fixed #3042).",
  cause: "A turn read a cached copy of the chat instead of the chat's one record.",
  path: "1:1 text",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("can you find a quiet cafe near the library?", "Fern & Paper on 4th is quiet till noon.");
      const second = await chat.text("what was the name again?", "Fern & Paper.");
      assert.match(second.shown, /can you find a quiet cafe/, "the second turn is shown the first text");
      assert.match(second.shown, /Fern & Paper on 4th is quiet till noon\./, "and Tex's own answer to it");
    } finally {
      chat.restore();
    }
  },
};
