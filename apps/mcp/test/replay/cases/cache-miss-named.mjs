import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { earlierRoom } from "../../../../../packages/tex/gateway/agent/ledgerHistory.js";

export default {
  id: "cache-miss-named",
  incident: "2026-11-14: a 1:1 text's first round rewrote about 63,000 of its 97,000 prompt tokens to the cache even minutes after the text before it, and the token counts could not say which piece of the prompt had changed.",
  cause: "Nothing logged which piece of the cached prefix (tools, system blocks, history messages) a round was sent, so a miss could not be traced to its cause.",
  path: "1:1 texts in a stretch",
  async run() {
    const lines = [];
    const missed = [];
    const realLog = console.log;
    console.log = (line, ...rest) => {
      if (typeof line === "string" && line.includes('"event":"model_call"')) lines.push(JSON.parse(line));
      else if (typeof line === "string" && line.includes('"event":"tex_turn_day_missed"')) missed.push(line);
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
      assert.ok(second.prefix.firstLines.length >= second.prefix.firstChunks.length, "and line by line, so an added or dropped line is named by its place");
      assert.deepEqual(second.prefix.systemParts, first.prefix.systemParts, "the same system blocks");
      assert.ok(!second.prefix.modules.some((module) => module.startsWith("context/thread:")), "a thread note is only ever named part by part (`context/thread/<part>`), so a changed system block says which part (2026-11-14 20:29Z: a third text rewrote 54,000 tokens when the thread note changed)");
      assert.deepEqual(second.prefix.history.slice(0, first.prefix.history.length), first.prefix.history, "the second text's history starts with the first's, piece by piece");
      assert.equal(earlierRoom(30_100), earlierRoom(31_900), "the earlier days' room moves in steps, so a text or two more today never drops the oldest day (2026-11-14 21:11Z-21:24Z: 496, 522, 496, 522 lines)");
      assert.ok(!second.prefix.modules.some((module) => module.startsWith("context/calendar")), "the calendar copy is said in their turn, never the cached system prompt (2026-11-14 21:26Z: a refreshed copy rewrote 79,000 tokens)");
      assert.equal(missed.length, 0, "a text still in the Worker's outbox keeps the ledger's day, so no turn falls back to a different chat (2026-11-15 00:40Z-00:45Z: 523, 476, 523 lines)");
      assert.equal(first.ttl, "1h", "each call logs the cache life its prefix was sent with: the front door's `cacheTtl` in Tex's config, an hour (2026-11-18: the cost guard on the one-hour cache)");
      assert.equal(second.ttl, "1h");
      assert.ok(Number.isFinite(second.cacheRead) && Number.isFinite(second.cacheWrite) && Number.isFinite(second.cacheWrite1h), "with its cache reads, its writes and the hour's share of them");
      assert.ok(!JSON.stringify(lines).includes("plumber"), "fingerprints only, never a word");
    } finally {
      console.log = realLog;
      chat.restore();
    }
  },
};
