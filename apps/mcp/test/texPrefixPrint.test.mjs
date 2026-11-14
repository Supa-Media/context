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
  assert.equal(a.toolPrints.length, 1);
  assert.equal(a.firstChunks.length, 1);
  const lines = { ...body(true), messages: [{ role: "user", content: Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") }] };
  const c1 = prefixPrint(lines, 1).firstChunks;
  assert.equal(c1.length, 3, "45 lines are three chunks of 20");
  const changed = { ...lines, messages: [{ role: "user", content: Array.from({ length: 45 }, (_, i) => (i === 30 ? "edited" : `line ${i}`)).join("\n") }] };
  const c2 = prefixPrint(changed, 1).firstChunks;
  assert.deepEqual([c1[0] === c2[0], c1[1] === c2[1], c1[2] === c2[2]], [true, false, true], "the changed chunk is named");
  const l1 = prefixPrint(lines, 1).firstLines;
  const l2 = prefixPrint(changed, 1).firstLines;
  assert.equal(l1.length, 45);
  assert.deepEqual(l1.map((print, i) => print === l2[i]).flatMap((same, i) => (same ? [] : [i])), [30], "the changed line is named, by its place");
  assert.match(l1[0], /^o[0-9a-f]{5}$/, "a line is its kind and a short fingerprint");
  const top = { ...lines, messages: [{ role: "user", content: `[Sat] new line\n${lines.messages[0].content}` }] };
  const l3 = prefixPrint(top, 1).firstLines;
  assert.equal(l3[0][0], "t", "a stamped line says so");
  assert.deepEqual(l3.slice(1), l1, "a line added at the top leaves the rest lined up");
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
  assert.deepEqual(second.prefix.toolPrints, first.prefix.toolPrints);
  assert.deepEqual(second.prefix.systemParts, first.prefix.systemParts);
  assert.ok(second.prefix.modules.some((module) => module.startsWith("context/")) || second.prefix.modules.length > 0, "the prompt modules ride along, by id and fingerprint");
  assert.deepEqual(second.prefix.modules.filter((m) => m.startsWith("stable")), first.prefix.modules.filter((m) => m.startsWith("stable")));
  assert.ok(second.prefix.history.length > first.prefix.history.length);
  assert.deepEqual(second.prefix.history.slice(0, first.prefix.history.length), first.prefix.history);
  assert.ok(!JSON.stringify(lines).includes("Elm St"), "fingerprints only, never a word");
});
