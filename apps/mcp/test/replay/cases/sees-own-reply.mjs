import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { WEEK_PREFACE } from "../../../src/agent/weekHistory.js";

const DAY = 24 * 60 * 60_000;

export default {
  id: "sees-own-reply",
  incident:
    "2026-11-02 to 11-05: a speed change made 1:1 turns read a copy of the chat sealed before Tex answered, so Tex saw the person's texts and none of its own answers (#2724, fixed #3042). " +
    "2026-11-16 (Tex Devs): Tex couldn't say what was said over the weekend; a chat was shown only its last 24 hours word for word (Dev2: the last 7 days word for word, the same in every chat).",
  cause:
    "A turn read a cached copy of the chat instead of the chat's one record. The history view kept 24 hours verbatim (threadedTurn.js windowStart); anything older was a thread title or a day summary.",
  path: "1:1 text",
  async run() {
    // Three days ago: the gateway runs on a clock three days back for the first texts, the chat's own clock with it.
    const chat = await oneToOne();
    chat.later(-3 * DAY);
    const realNow = Date.now;
    Date.now = () => realNow() - 3 * DAY;
    try {
      await chat.text("the plumber comes thursday at 9, gate code 4471", "Noted: plumber Thursday 9, gate 4471.");
    } finally {
      Date.now = realNow;
    }
    try {
      chat.later(3 * DAY);
      await chat.text("can you find a quiet cafe near the library?", "Fern & Paper on 4th is quiet till noon.");
      const second = await chat.text("what was the name again?", "Fern & Paper.");
      assert.match(second.shown, /can you find a quiet cafe/, "the second turn is shown the first text");
      assert.match(second.shown, /Fern & Paper on 4th is quiet till noon\./, "and Tex's own answer to it");
      assert.ok(second.shown.includes(WEEK_PREFACE.slice(1, 40)), "the turn is shown the chat's last 7 days");
      assert.match(second.shown, /the plumber comes thursday at 9, gate code 4471/, "a text from three days ago, word for word");
    } finally {
      chat.restore();
    }
  },
};
