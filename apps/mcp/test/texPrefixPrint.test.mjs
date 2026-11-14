/**
 * Each texted round logs its prefix as fingerprints (`src/agent/prefixPrint.js`; Dev2, 2026-11-14: "lets just look
 * into the cache misses"), so a production miss names the piece that changed: the tools, a system block, or the
 * first history message that differs. Through the real `/agent` route: two texts of one chat in a stretch log the
 * same tools and system, and the second's history fingerprints start with the first's; a cache mark alone never
 * changes a fingerprint, and a changed message does.
 *
 * Sabotage these and a test here fails:
 *  1. `prefixPrint.js` hashing the cache marks too → "a moved cache mark" and "two texts".
 *  2. `aiGateway.js` not returning `prefix` → "two texts" (no prefix logged).
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, textTex, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { MAX_HISTORY_PRINTS, prefixPrint } from "../src/agent/prefixPrint.js";

test("a moved cache mark never changes a fingerprint; a changed message does", () => {
  const body = (mark, words = "hi") => ({
    tools: [{ name: "a", input_schema: {} }],
    system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: words, ...(mark ? { cache_control: { type: "ephemeral" } } : {}) }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "new" }, { type: "text", text: "more" }] },
    ],
  });
  const a = prefixPrint(body(true), 2);
  const b = prefixPrint(body(false), 2);
  assert.deepEqual(a, b);
  assert.equal(a.history.length, 2);
  assert.equal(a.historyBlocks, 2);
  assert.equal(a.blocks, 2);
  assert.notEqual(prefixPrint(body(true, "other"), 2).history[0], a.history[0]);
  assert.equal(prefixPrint(body(true), null), null);
  const long = { ...body(true), messages: Array.from({ length: MAX_HISTORY_PRINTS + 5 }, (_, i) => ({ role: "user", content: [{ type: "text", text: String(i) }] })) };
  const cut = prefixPrint(long, MAX_HISTORY_PRINTS + 5);
  assert.equal(cut.history.length, MAX_HISTORY_PRINTS);
  assert.equal(cut.more, 5);
});

let world;
const realNow = Date.now;
let offset = 0;
const lines = [];
let realLog;
before(async () => {
  world = await createEgressWorld();
  Date.now = () => realNow() + offset;
  realLog = console.log;
  console.log = (line, ...rest) => {
    if (typeof line === "string" && line.includes('"event":"model_call"')) lines.push(JSON.parse(line));
    else realLog(line, ...rest);
  };
});
after(() => {
  console.log = realLog;
  Date.now = realNow;
  world.restore();
});

test("two texts in a stretch: same tools and system, and the second's history starts with the first's", async () => {
  offset = -20 * 60_000;
  world.bucket.set("1-projects/venue.md", { body: "# Venue\n\nThe hall on Elm St, doors at 6.\n", etag: "v1" });
  world.model.install([{ toolCalls: [{ name: "search_notes", args: { query: "venue" } }] }, { text: "The hall on Elm St." }]);
  await textTex(world.env, TOKEN_TEXTS, "where is the venue?");
  const first = lines.filter((line) => line.round === 1).at(-1);
  offset += 3 * 60_000;
  world.model.install([{ text: "Doors at 6." }]);
  await textTex(world.env, TOKEN_TEXTS, "and when do doors open?");
  const second = lines.filter((line) => line.round === 1).at(-1);
  assert.ok(first?.prefix && second?.prefix && first !== second, "each text's first round logs its prefix");
  assert.equal(typeof second.turn, "string");
  assert.equal(second.prefix.tools, first.prefix.tools);
  assert.deepEqual(second.prefix.system, first.prefix.system);
  assert.ok(second.prefix.modules.some((module) => module.startsWith("context/")) || second.prefix.modules.length > 0, "the prompt modules ride along, by id and fingerprint");
  assert.deepEqual(second.prefix.modules.filter((m) => m.startsWith("stable")), first.prefix.modules.filter((m) => m.startsWith("stable")));
  assert.ok(second.prefix.history.length > first.prefix.history.length);
  assert.deepEqual(second.prefix.history.slice(0, first.prefix.history.length), first.prefix.history);
  assert.ok(!JSON.stringify(lines).includes("Elm St"), "fingerprints only, never a word");
});
