/**
 * THE TURN LOG'S ROW (`src/agent/turnLog.js`): where a turn came from and what
 * each model it ran on spent, so the control plane can price it per model and
 * the Tex dashboard can slice by chat kind (asked for by the owner,
 * 2026-10-24). Names and numbers only: the row never carries text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { meterParts } from "../src/agent/modelPlan.js";
import { actionOf, MAX_WAIT_MS, turnKind, turnReport, waitBefore, wireTraceEntry } from "../src/agent/turnLog.js";

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

test("a tool's action is kept only when it is shaped like a name from the tool's own list", () => {
  const entry = (action) => wireTraceEntry({ kind: "tool", tool: "write", ok: true, ms: 5, action });
  assert.equal(entry("save").action, "save");
  assert.equal(entry("move_note").action, "move_note");
  // A value a person typed, with spaces and capitals, never reaches the log.
  assert.equal("action" in entry("Save My Note"), false);
  assert.equal("action" in entry("a".repeat(60)), false);
  assert.equal("action" in entry(42), false);
  assert.equal("action" in entry(undefined), false);
  assert.equal("action" in entry(["save"]), false);
  // A tool that names no action keeps no action key at all.
  assert.equal("action" in wireTraceEntry({ kind: "tool", tool: "search", ok: true, ms: 1 }), false);
});

test("an action is never kept on a trace entry that is not a tool call", () => {
  assert.equal("action" in wireTraceEntry({ kind: "model", ok: true, ms: 1, action: "save" }), false);
});

test("actionOf prefers the action the model wrote, then the one that ran, and drops anything that is not a name", () => {
  assert.equal(actionOf({ args: { action: "save" } }, { args: { action: "search" } }), "save");
  assert.equal(actionOf({ args: {} }, { args: { action: "search" } }), "search");
  // A written value that is not a name is dropped, not swapped for the one that ran.
  assert.equal(actionOf({ args: { action: "Save My Note" } }, { args: { action: "search" } }), undefined);
  assert.equal(actionOf({ args: { action: 7 } }, { args: {} }), undefined);
  assert.equal(actionOf({ args: { action: "x".repeat(41) } }, { args: {} }), undefined);
  assert.equal(actionOf({ args: { action: "x".repeat(40) } }, { args: {} }), "x".repeat(40));
  assert.equal(actionOf(undefined, { args: { action: "send" } }), "send");
  assert.equal(actionOf(undefined, undefined), undefined);
});

test("a call made as one of the six keeps that name beside the tool that ran; nothing else does", async () => {
  const { sixOf, wireTraceEntry } = await import("../src/agent/turnLog.js");
  assert.equal(sixOf({ name: "write" }, { name: "write_note" }), "write");
  assert.equal(sixOf({ name: "search_web" }, { name: "search_web" }), undefined);
  assert.equal(sixOf({ name: "orient" }, { name: "orient" }), undefined);
  assert.equal(wireTraceEntry({ kind: "tool", tool: "write_note", six: "write", action: "save", ok: true, ms: 1 }).six, "write");
  assert.equal("six" in wireTraceEntry({ kind: "tool", tool: "x", six: "nope", ok: true, ms: 1 }), false);
});
