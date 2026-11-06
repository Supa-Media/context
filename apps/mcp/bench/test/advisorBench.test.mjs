/**
 * The advisor-first comparison (`bench/advisorBench.mjs`): the three setups are
 * the live one with only their models and flags changed, each one the product
 * accepts, and the result note's lines count what the comparison reads.
 *
 * ## Sabotage record
 *
 *   `withChanges` leaving the old `think:` line beside the new one
 *     → "each setup is the live one with its models and flags changed" fails (a repeated key refuses the file)
 *   `adviceOf` counting every ask as declined
 *     → "the stats split Opus, read the cache per model, and count asks and declines" fails
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ADVISOR_SETUPS, adviceOf, advisorLines, advisorStats, withChanges, writeAdvisorSetups } from "../advisorBench.mjs";
import { parseSetup } from "../../src/agent/production.js";

const LIVE = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n  think: anthropic/claude-opus-5-5\n  think_rounds: 1\n  effort: medium\nfront_door: on\n---\n\nYou are Tex.\n";

test("each setup is the live one with its models and flags changed, and the product accepts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-bench-"));
  await mkdir(join(dir, "setups", "texting-assistant"), { recursive: true });
  await writeFile(join(dir, "setups", "texting-assistant", "production.md"), LIVE);
  const written = await writeAdvisorSetups(dir);
  assert.deepEqual(written, Object.keys(ADVISOR_SETUPS));
  const a = await parseSetup(await readFile(join(dir, "setups", "texting-assistant", "advisor-a-router.md"), "utf8"));
  const c = await parseSetup(await readFile(join(dir, "setups", "texting-assistant", "advisor-c-rung.md"), "utf8"));
  assert.equal(a.router.think, "anthropic/claude-opus-5-5");
  assert.equal(a.advisorFirst, false);
  assert.equal(a.advisor, "anthropic/claude-opus-5-5", "an advisor is added when the live setup names none");
  assert.equal(a.efforts["anthropic/claude-haiku-5-5"], "medium", "the rest of the live setup is kept");
  assert.equal(c.advisorFirst, true);
  assert.equal(c.effortRung, "high");
  assert.match(withChanges(LIVE, ADVISOR_SETUPS["advisor-b-first"]), /\n\nYou are Tex\.\n$/, "the prompt is unchanged");
});

test("the stats split Opus, read the cache per model, and count asks and declines", () => {
  const runs = [
    {
      setup: "b",
      turnMs: [1000, 3000],
      usageByModel: {
        "anthropic/claude-haiku-5-5": { input: 100, output: 10, cacheRead: 300, cacheWrite: 0 },
        "anthropic/claude-opus-5-5": { input: 50, output: 20, cacheRead: 50, cacheWrite: 0 },
      },
      advice: adviceOf([[{ kind: "tool", tool: "ask_advisor", ok: true }, { kind: "tool", tool: "ask_advisor", ok: true, declined: true }], [{ kind: "model", model: "anthropic/claude-haiku-5-5", rung: "high" }]]),
    },
  ];
  const s = advisorStats(runs);
  assert.equal(s.texts, 2);
  assert.equal(s.p50, 1000);
  assert.equal(s.p95, 3000);
  assert.ok(s.opusPerText > 0 && s.restPerText > 0);
  assert.equal(s.cache["anthropic/claude-haiku-5-5"], 0.75);
  assert.equal(s.cache["anthropic/claude-opus-5-5"], 0.5);
  assert.deepEqual([s.askedTexts, s.asks, s.declined, s.rungs], [1, 2, 1, 1]);
  assert.equal(advisorLines("core", [{ name: "b" }], runs).length, 0, "only on the advisor test");
  assert.match(advisorLines("advisor", [{ name: "b" }], runs)[0], /^Advisor first: b, 2 texts: time to a text p50 1\.0 s, p95 3\.0 s;.*2 asks, 1 declined \(50%\); effort rung on 1 texts\.$/);
});
