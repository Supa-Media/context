import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "calendar-day-in-id",
  incident:
    "2026-11-22, a pull request preview with a stand-in Google: asked what was on their calendar tomorrow, Tex fetched \"calendar:2026-11-23\", was told there were no notes under that folder, " +
    "tried search and send in shapes they don't take, each shown to it and in the steps as \"no such action\", and said it couldn't see their calendar.",
  cause:
    "The day written into the calendar id was read as a folder path, and a call the gateway refused for its shape was labelled no such action, with the reason it was given left out of the steps.",
  path: "1:1 calendar read",
  async run() {
    const chat = await oneToOne();
    try {
      const asked = [];
      chat.world.controlPlane.flags.calendarDays = (body) => {
        asked.push(body.date);
        return { ok: true, days: [{ address: "rowan@example.invalid", date: body.date, text: `# Calendar · ${body.date}\n\n## 3:00 pm · Golf with Bo\n` }], unanswered: [], reconnect: [] };
      };
      const answered = await chat.text("what's on my calendar on the 23rd?", [
        { toolCalls: [{ name: "fetch", args: { id: "calendar:2026-11-23" } }] },
        { toolCalls: [{ name: "search", args: { query: "2026-11-23", args: { calendar: true } } }] },
        { text: "Golf with Bo at 3." },
      ]);
      assert.ok(asked.includes("2026-11-23"), "the day in the id is the day read from Google");
      assert.match(answered.shown, /Golf with Bo/, "and what Google said is what the model is shown");
      assert.match(answered.shown, /search takes args: prefix, from, to/, "a call refused for its shape is told the args it takes");
      assert.equal(answered.answer, "Golf with Bo at 3.");
    } finally {
      chat.restore();
    }
  },
};
