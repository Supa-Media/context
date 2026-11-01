/**
 * Why a check-in failed, as a fixed code (2026-11-01): a check-in failed as "model_unavailable" after 43 s
 * and nothing said whether the model timed out, was rate limited or the turn ran out of rounds.
 * `heartbeat.js` sends `reason` beside the old `error`; out of rounds is `rounds_exhausted` there, and a
 * provider failure is one of these codes, never the provider's words.
 * Sabotage: return `error.reason` from providerFailure and "never the provider's words" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { providerFailure } from "../src/agent/heartbeat.js";
import { ProviderError } from "../src/agent/providers.js";

test("a provider failure is a fixed code, never the provider's words", () => {
  assert.equal(providerFailure(new ProviderError("rate limited", 429)), "status_429");
  assert.equal(providerFailure(new ProviderError("overloaded", 529)), "status_529");
  assert.equal(providerFailure(new ProviderError("unavailable", 503)), "status_503");
  assert.equal(providerFailure(new ProviderError("round timed out after 60s", null)), "timeout");
  assert.equal(providerFailure(new ProviderError("aborted", null)), "timeout");
  assert.equal(providerFailure(new ProviderError("Ada's key sk_live_1 rejected", 401)), "other");
});

test("the 502 carries rounds_exhausted when the turn ran out of rounds", () => {
  const source = readFileSync(new URL("../src/agent/heartbeat.js", import.meta.url), "utf8");
  assert.match(source, /reason: turn\?\.exhausted \? "rounds_exhausted" : failure/);
});
