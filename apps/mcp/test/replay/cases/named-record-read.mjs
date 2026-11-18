import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

const LINK = "context://@ada/projects/slip.md";

export default {
  id: "named-record-read",
  incident:
    "2026-11-17: the front door answered what a note said after searching something else, or without opening the link they sent.",
  cause:
    "Any search counted as reading the record. A named note is that note, opened before the answer or the draft is sent back.",
  path: "1:1 text that names a note",
  async run() {
    const chat = await oneToOne();
    try {
      const turn = await chat.text(LINK, [
        { text: "The dock is free all summer." },
        { toolCalls: [{ name: "fetch", args: { id: "projects/slip.md" } }] },
        { text: "The slip note has no dates. I'll ask the harbor which weekend." },
      ]);
      const openedFirst = /Already read context:\/\//.test(turn.shown);
      if (openedFirst) {
        assert.match(turn.shown, /projects\/slip\.md/, "the note is in the prompt before the answer");
      } else {
        assert.match(turn.shown, /have not read any of it this turn/, "a named note with no read of it is sent back");
        assert.match(turn.answer, /slip note/, "the answer comes after the note is fetched");
      }
    } finally {
      chat.restore();
    }
  },
};
