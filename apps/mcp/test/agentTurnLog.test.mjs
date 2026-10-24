/**
 * THE TURN LOG'S ROW (`src/agent/turnLog.js`): where a turn came from and what
 * each model it ran on spent, so the control plane can price it per model and
 * the Tex dashboard can slice by chat kind (asked for by the owner,
 * 2026-10-24). Names and numbers only: the row never carries text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { meterParts } from "../src/agent/modelPlan.js";
import { turnKind, turnReport } from "../src/agent/turnLog.js";

test("a turn's kind follows what started it, a routine before a job before a group", () => {
  assert.equal(turnKind({ runner: true, job: { id: "j" }, group: { id: "g" }, texting: true }), "routine");
  assert.equal(turnKind({ runner: false, job: { id: "j" }, group: { id: "g" }, texting: true }), "job");
  assert.equal(turnKind({ runner: false, job: null, group: { id: "g" }, texting: false }), "group");
  assert.equal(turnKind({ runner: false, job: null, group: null, texting: true }), "one");
  assert.equal(turnKind({ runner: false, job: null, group: null, texting: false }), "app");
});

test("a planned turn reports each model's own counts, cache included, for the control plane to price", () => {
  const turn = {
    model: "anthropic/claude-haiku-5-5",
    usage: { input: 900, output: 120, cacheRead: 8_000, cacheWrite: 400, decision: 30 },
    usageByModel: {
      "anthropic/claude-opus-5-5": { input: 600, output: 80, cacheRead: 5_000, cacheWrite: 400 },
      "anthropic/claude-haiku-5-5": { input: 300, output: 40, cacheRead: 3_000, cacheWrite: 0 },
    },
  };
  const report = turnReport({ provider: "builtin", outcome: "answered", model: turn.model, timing: { rounds: 3, trace: [] }, usage: turn.usage, parts: meterParts(turn), kind: "one", ms: 4_000 });
  assert.equal(report.kind, "one");
  assert.deepEqual(report.usage, [
    { model: "anthropic/claude-opus-5-5", input: 600, output: 80, cacheRead: 5_000, cacheWrite: 400 },
    { model: "anthropic/claude-haiku-5-5", input: 300, output: 40, cacheRead: 3_000, cacheWrite: 0 },
  ]);
  // The router's decision tokens and `whole` are the meter's business, not the row's.
  assert.ok(report.usage.every((part) => !("decision" in part) && !("whole" in part)));
});

test("a failed turn has no parts and goes without a usage list", () => {
  const report = turnReport({ provider: "builtin", outcome: "failed", model: "anthropic/claude-haiku-5-5", timing: null, usage: null, parts: null, kind: "group", ms: 1_000 });
  assert.equal("usage" in report, false);
  assert.equal(report.inputTokens, 0);
  assert.equal(report.kind, "group");
});

test("nothing on the row is text a person or a model wrote", () => {
  const report = turnReport({
    provider: "builtin",
    outcome: "answered",
    model: "m",
    timing: { trace: [{ kind: "router", tier: "think", model: "m", pick: "the words the router wrote", ms: 3 }] },
    usage: { input: 1, output: 1 },
    parts: [{ model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, note: "should not travel" }],
    kind: "one",
    ms: 5,
  });
  assert.equal(JSON.stringify(report).includes("the words the router wrote"), false);
  assert.equal(JSON.stringify(report).includes("should not travel"), false);
});
