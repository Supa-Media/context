import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as replay from "../container/replay.mjs";

test("the replay window is the agent's: the bridge drops what the agent would not take", () => {
  // apps/agent/src/replayWindow.ts states MAX_REPLAY_MS as a product of integers; read it without evaluating code.
  const agent = readFileSync(new URL("../../../apps/agent/src/replayWindow.ts", import.meta.url), "utf8");
  const match = agent.match(/export const MAX_REPLAY_MS = ([0-9 *]+);/);
  assert.ok(match, "MAX_REPLAY_MS is declared in the agent as integer factors");
  const agentValue = match[1].split("*").map((factor) => Number(factor.trim())).reduce((a, b) => a * b, 1);
  assert.equal(replay.MAX_REPLAY_MS, agentValue);
});

test("the replay limits are the documented values", () => {
  assert.equal(replay.MAX_REPLAY_MS, 12 * 60 * 60 * 1000);
  assert.equal(replay.GAP_TIMEOUT_MS, 10 * 60_000);
  assert.equal(replay.FRONTIER_STUCK_ALERT_MS, 15 * 60_000);
  assert.equal(replay.BIG_REPLAY_EVENTS, 50);
  assert.equal(replay.BIG_REPLAY_LAG_MS, 60 * 60_000);
});
