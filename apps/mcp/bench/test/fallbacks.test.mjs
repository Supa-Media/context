/**
 * Fallbacks in a Lab run's results (`bench/fallbacks.mjs`, 2026-11-18).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-18):
 *  1. `fallbacksIn` reading only strings -> "a fallback is counted as a string or as a call" fails;
 *  2. `fallbackVerdict` returning valid with a count -> "one fallback makes the run invalid" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fallbackVerdict, fallbacksIn } from "../fallbacks.mjs";

test("a fallback is counted as a string or as a call, and nothing else is", () => {
  assert.equal(fallbacksIn(["search", "fallback: @cf/zai-org/glm-4.7-flash after 529", "retried after 529"]), 1);
  assert.equal(fallbacksIn([{ tool: "fallback: @cf/zai-org/glm-4.7-flash after 500", ok: true }, { tool: "router: main" }]), 1);
  assert.equal(fallbacksIn(["router: main", "a fallback: in words"]), 0);
  assert.equal(fallbacksIn(undefined), 0);
});

test("one fallback makes the run invalid, with the count and why", () => {
  assert.deepEqual(fallbackVerdict([{ fallbacks: 0 }, {}, { fallbacks: "x" }]), { fallbacks: 0, valid: true });
  const v = fallbackVerdict([{ fallbacks: 2 }, { right: true }, { fallbacks: 1 }]);
  assert.equal(v.fallbacks, 3);
  assert.equal(v.valid, false);
  assert.match(v.invalid, /3 Claude call\(s\) fell back/);
});
