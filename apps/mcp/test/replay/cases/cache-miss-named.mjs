import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "cache-miss-named",
  incident: "2026-11-14: a 1:1 text's first round rewrote about 63,000 of its 97,000 prompt tokens to the cache even minutes after the text before it, and the token counts could not say which piece of the prompt had changed.",
  cause: "Nothing logged which piece of the cached prefix (tools, system blocks, history messages) a round was sent, so a miss could not be traced to its cause.",
  path: "1:1 texts in a stretch",
  async run() {
    const lines = [];
    const realLog = console.log;
    console.log = (line, ...rest) => {
      if (typeof line === "string" && line.includes('"event":"model_call"')) lines.push(JSON.parse(line));
      else realLog(line, ...rest);
    };
    const chat = await oneToOne();
    try {
      await chat.text("the plumber comes thursday at 9", "Noted: Thursday at 9.");
      const first = lines.filter((line) => line.round === 1).at(-1);
      chat.wait(4 * 60_000);
      await chat.text("what time thursday?", "9.");
      const second = lines.filter((line) => line.round === 1).at(-1);
      assert.ok(first?.prefix && second?.prefix && first !== second, "each text's first round logs its cached prefix as fingerprints");
      assert.equal(second.prefix.tools, first.prefix.tools, "the same tools");
      assert.deepEqual(second.prefix.toolPrints, first.prefix.toolPrints, "each tool fingerprinted, the same");
      assert.ok(second.prefix.firstChunks.length > 0, "the first history message is fingerprinted in chunks, so a changed transcript names where");
      assert.deepEqual(second.prefix.systemParts, first.prefix.systemParts, "the same system blocks");
      assert.deepEqual(second.prefix.history.slice(0, first.prefix.history.length), first.prefix.history, "the second text's history starts with the first's, piece by piece");
      assert.ok(!JSON.stringify(lines).includes("plumber"), "fingerprints only, never a word");
    } finally {
      console.log = realLog;
      chat.restore();
    }
  },
};
