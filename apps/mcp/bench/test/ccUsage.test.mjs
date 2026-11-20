/**
 * A Claude Code eval run's spend (`bench/evals/ccUsage.mjs`): measured tokens from the socket's usage lines, the
 * weekly limit's share from two usage reads, and no percentage, with the reason, when a read is refused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ccFigures, readWeekly, sumUsage, weeklyOf } from "../evals/ccUsage.mjs";
import { resultUsage } from "../socketAnswerer.mjs";

test("every answered call's tokens are summed, per model too; a broken line is skipped", () => {
  const lines = [
    JSON.stringify({ model: "haiku", input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }),
    "not json",
    JSON.stringify({ model: "sonnet", input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }),
    JSON.stringify({ model: "haiku", input: 5, output: -3 }),
  ].join("\n");
  const sum = sumUsage(lines);
  assert.equal(sum.calls, 3);
  assert.equal(sum.tokens, 100 + 20 + 1000 + 50 + 10 + 1 + 5);
  assert.deepEqual(sum.byModel.haiku, { calls: 2, input: 105, output: 20, cacheRead: 1000, cacheWrite: 50 });
  assert.equal(sumUsage("").tokens, 0);
});

test("the CLI's own result gives the call's tokens", () => {
  const stdout = JSON.stringify({ type: "result", result: "hi", usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 7 } });
  assert.deepEqual(resultUsage(stdout, "haiku"), { model: "haiku", input: 12, output: 3, cacheRead: 400, cacheWrite: 7 });
  assert.equal(resultUsage(JSON.stringify({ type: "result", result: "hi" })), null);
  assert.equal(resultUsage("garbage"), null);
});

test("the weekly share is the difference of the two reads, scaled to the whole benchmark", () => {
  const usage = sumUsage(JSON.stringify({ model: "haiku", input: 1000, output: 0 }));
  const cc = ccFigures(usage, { pct: 12 }, { pct: 15.5 }, { n: 50, total: 500 });
  assert.equal(cc.weeklyPct, 3.5);
  assert.equal(cc.fullRunWeeklyPct, 35);
  assert.equal(cc.fullRunTokens, 10_000);
  assert.equal(cc.weeklyWhy, null);
  // A limit that reset between the reads never reads as negative.
  assert.equal(ccFigures(usage, { pct: 90 }, { pct: 2 }, { n: 50, total: 500 }).weeklyPct, 0);
});

test("a refused read shows no percentage and says why, never 0", async () => {
  const refused = await readWeekly("sk-ant-oat-x", async () => new Response("no", { status: 403 }));
  assert.deepEqual(refused, { pct: null, why: "the usage read answered 403" });
  const cc = ccFigures(sumUsage(""), refused, { pct: 4 }, { n: 50, total: 500 });
  assert.equal(cc.weeklyPct, null);
  assert.equal(cc.fullRunWeeklyPct, null);
  assert.equal(cc.weeklyWhy, "the usage read answered 403");
  assert.deepEqual(await readWeekly("", async () => assert.fail("no read without a token")), { pct: null, why: "no Claude Code token" });
  const seen = [];
  const read = await readWeekly("tok", async (url, init) => (seen.push([url, init.headers.authorization]), Response.json({ seven_day: { utilization: 41 } })), () => 7);
  assert.deepEqual(read, { pct: 41, at: 7 });
  assert.equal(seen[0][1], "Bearer tok");
  assert.equal(weeklyOf({ five_hour: { utilization: 3 } }), null);
});
