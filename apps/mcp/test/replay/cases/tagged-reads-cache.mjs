import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";

export default {
  id: "tagged-reads-cache",
  incident: "2026-11-12: in a busy group, a text that tagged @Tex by name after one the judge passed on (or the other way round) read nothing from the prompt cache, tools included, and wrote 70,000 to 100,000 tokens again.",
  cause: "A literal @Tex tag was offered a different tool list (no say_nothing), and the tools come first in the cached prompt.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const judged = await chat.tag("ada", "Tex what time is soundcheck?", "Five.");
      const tagged = await chat.tag("bo", "@Tex and the opener?", "Blue Skies.", [], { tagged: true });
      assert.deepEqual(tagged.requests[0].tools, judged.requests[0].tools, "the same tools, byte for byte, so the tagged text reads the cache the judged one wrote");
      assert.equal(tagged.answer, "Blue Skies.", "and it still answers");
    } finally {
      chat.restore();
    }
  },
};
