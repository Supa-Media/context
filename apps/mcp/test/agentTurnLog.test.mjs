/**
 * THE TURN LOG'S ROW (`src/agent/turnLog.js`): where a turn came from and what
 * each model it ran on spent, so the control plane can price it per model and
 * the Tex dashboard can slice by chat kind (asked for by the owner,
 * 2026-10-24). Names and numbers only: the row never carries text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { meterParts } from "../src/agent/modelPlan.js";
import { MAX_WAIT_MS, turnKind, turnReport, waitBefore } from "../src/agent/turnLog.js";

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

test("a text's wait before its turn is measured from when the Worker took it in, and only a believable time counts", () => {
  const received = 1_800_000_000_000;
  assert.equal(waitBefore(received - 240_000, received), 240_000);
  assert.equal(waitBefore(received, received), 0);
  // A Worker clock a little ahead of ours is no wait, not a negative one.
  assert.equal(waitBefore(received + 2_000, received), 0);
  // Anything else is no measurement at all: missing, a string, far ahead, or a replayed day-old text.
  assert.equal(waitBefore(undefined, received), undefined);
  assert.equal(waitBefore(String(received - 1_000), received), undefined);
  assert.equal(waitBefore(Number.NaN, received), undefined);
  assert.equal(waitBefore(received + 120_000, received), undefined);
  assert.equal(waitBefore(received - MAX_WAIT_MS - 1, received), undefined);
});

test("the row carries the wait only when there is one", () => {
  const base = { provider: "builtin", outcome: "answered", model: "m", timing: null, usage: null, parts: null, kind: "group", ms: 3_000 };
  assert.equal(turnReport({ ...base, waitMs: 12_000 }).waitMs, 12_000);
  assert.equal("waitMs" in turnReport(base), false);
});
