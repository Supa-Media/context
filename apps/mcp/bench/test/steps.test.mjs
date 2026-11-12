// Tests for bench/steps.mjs. All values are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { median, stepTimings, stepsMarkdown } from "../steps.mjs";

const ledger = (question, replyMs, turn) => ({
  question,
  chat: [{ kind: "reply", timing: { replyMs, steps: [{ name: "model", ms: replyMs - 100 }, { name: "threads", ms: 900 }] } }],
  turns: [turn],
});

test("steps: medians per step and per trace kind, filtered by question, send-backs counted", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  const ledgers = [
    ledger(9, 3000, [{ kind: "model", ms: 1500 }, { kind: "judge", ms: 1200, acted: true }, { kind: "model", ms: 900 }]),
    ledger(10, 5000, [{ kind: "model", ms: 2000 }, { kind: "tool", tool: "search_notes", ms: 300 }]),
    ledger(1, 99000, [{ kind: "model", ms: 99000 }]),
  ];
  const timings = stepTimings(ledgers, [9, 10]);
  assert.deepEqual(timings.reply, [3000, 5000]);
  assert.deepEqual(timings.trace.model, [2400, 2000]);
  assert.deepEqual(timings.trace.reviewer, [1200]);
  assert.deepEqual(timings.trace["tool search_notes"], [300]);
  assert.deepEqual(timings.sentBack, [1, 0]);
  const table = stepsMarkdown(timings);
  assert.match(table, /\| Reply, whole turn \| 2 \| 4\.00 s \| 5\.00 s \|/);
  assert.match(table, /\| Step: threads \| 2 \| 0\.90 s \| 0\.90 s \|/);
  assert.match(table, /Turns the reviewer sent back: 1 of 2\./);
});
