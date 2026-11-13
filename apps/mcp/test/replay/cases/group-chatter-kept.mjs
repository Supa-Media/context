import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "group-chatter-kept",
  incident: "2026-11-12: quiet group texts reached the chat's record only at the next turn, so a later tag could miss what was said in between (#3224).",
  cause: "Chatter Tex didn't answer was not kept with the chat.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const said = [
        { from: "bo", text: "saturday works for the picnic" },
        { from: "cy", text: "I'll bring the blanket and lemonade" },
      ];
      const first = await chat.tag("ada", "Tex what did we decide?", "Saturday, Cy brings the blanket and lemonade.", said);
      assert.match(first.shown, /@bo: saturday works for the picnic/, "the chatter before a tag reaches the turn");
      const second = await chat.tag("ada", "Tex who's bringing drinks?", "Cy, lemonade.");
      assert.match(second.shown, /@cy: I'll bring the blanket and lemonade/, "and is still there at the next tag, with nothing said in between");
      assert.match(second.shown, /Saturday, Cy brings the blanket and lemonade\./, "with Tex's own answer");
    } finally {
      chat.restore();
    }
  },
};
