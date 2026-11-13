import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "routine-sees-chat",
  incident: "2026-11-12: a check-in answered a text from the night before, because a turn that answers no named text read a thinner, separately built view of the chat than a reply did (one door, 2026-11-13).",
  cause: "A turn with no named text (routine, check-in, job report) read a different view of the chat than a reply.",
  path: "1:1 routine",
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("my piano lesson moved to Friday at 5", "Got it, Friday at 5.");
      // A morning of small talk after it: the routine's own short list of last texts (eight lines) no longer reaches it.
      for (const [words, reply] of [["what's 18% of 64?", "11.52."], ["thanks", "Anytime."], ["is it raining?", "Light rain till noon."], ["ok umbrella then", "Good call."], ["what's a synonym for brisk", "Crisp."]]) {
        await chat.text(words, reply);
      }
      chat.wait(60 * 60_000);
      const brief = await chat.routine("routines/daily/brief.md", "Piano Friday at 5.");
      assert.match(brief.shown, /my piano lesson moved to Friday at 5/, "the routine is shown the chat a reply would be, the morning's first text included");
      assert.match(brief.shown, /Got it, Friday at 5\./, "and Tex's own reply to it");
      assert.match(brief.shown, /Crisp\./, "through the newest");
    } finally {
      chat.restore();
    }
  },
};
