// Tests for bench/metrics.mjs: the `[metrics: …]` tag on a case line, how it is read (`load.mjs`), how each metric's
// rate is counted from the verdicts (`metricRates`), and that the score section prints it (`score.mjs`). Also that
// `tests/fd-completion.md` reads, every case names metrics, and all six Area 1 metrics are covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { METRICS, metricLines, metricRates, splitMetrics } from "../metrics.mjs";
import { parseTest } from "../load.mjs";
import { scoreSection, scoreSetups } from "../score.mjs";
import { checkVerdicts } from "../checks.mjs";

const CASE = `---
job: texting-assistant
runs: 1
---

## 1. Push my haircut

- kind: task
- person starts: "push my haircut to 1"
- must call: calendar_event [metrics: task_completion_rate, cant_first_rate]
- must: say it moved the haircut to 1 pm [metrics: task_completion_rate, write_and_confirm_accuracy]
- must not: say it can't change her calendar [metrics: cant_first_rate]
- must not: tell her to move it herself [metrics: unnecessary_handback_rate]
- must not: ask before moving it

## 2. No tags

- kind: task
- must: say hi
`;

test("splitMetrics takes the tag off and returns its ids", () => {
  assert.deepEqual(splitMetrics("- must: say 1 pm [metrics: task_completion_rate, cant_first_rate]"), { line: "- must: say 1 pm", ids: ["task_completion_rate", "cant_first_rate"] });
  assert.deepEqual(splitMetrics("- must: say 1 pm [metric: cant_first_rate]"), { line: "- must: say 1 pm", ids: ["cant_first_rate"] });
  assert.deepEqual(splitMetrics("- must: say 1 pm"), { line: "- must: say 1 pm", ids: [] });
  // A bracket that is not the tag stays in the line.
  assert.deepEqual(splitMetrics("- must: say [the time]"), { line: "- must: say [the time]", ids: [] });
});

test("splitMetrics refuses an unknown id or an empty tag, so a typo fails when the test is read", () => {
  assert.throws(() => splitMetrics("- must: x [metrics: task_complete]"), /task_complete/);
  assert.throws(() => splitMetrics("- must: x [metrics: ]"), /names no metric/);
});

test("a tagged line is judged and checked without its tag, and keeps where its ids belong", () => {
  const [q, plain] = parseTest(CASE).questions;
  assert.deepEqual(q.must, ["say it moved the haircut to 1 pm"]);
  assert.deepEqual(q.mustNot, ["say it can't change her calendar", "tell her to move it herself", "ask before moving it"]);
  assert.deepEqual(q.checks.map((c) => c.line), ["call calendar_event"]);
  assert.ok(!q.body.includes("[metrics:"), "the played person reads the case without the tags");
  assert.deepEqual(q.metrics, [
    { kind: "must", line: "call calendar_event", ids: ["task_completion_rate", "cant_first_rate"] },
    { kind: "must", line: "say it moved the haircut to 1 pm", ids: ["task_completion_rate", "write_and_confirm_accuracy"] },
    { kind: "must not", line: "say it can't change her calendar", ids: ["cant_first_rate"] },
    { kind: "must not", line: "tell her to move it herself", ids: ["unnecessary_handback_rate"] },
  ]);
  assert.deepEqual(plain.metrics, []);
  // The record check still grades from the run's record.
  const [verdict] = checkVerdicts(q, { tools: ["calendar_event"] });
  assert.equal(verdict.pass, true);
});

test("only a must, must not or record line may name metrics", () => {
  assert.throws(() => parseTest("## 1. x\n\n- judge: short [metrics: turns_to_resolution_clean]\n"), /only a must, must not or record line/);
});

/** Verdicts for one run of CASE's question 1: `fails` names the lines that failed. */
function verdicts(fails = []) {
  const lines = [
    ["must", "call calendar_event"],
    ["must", "say it moved the haircut to 1 pm"],
    ["must not", "say it can't change her calendar"],
    ["must not", "tell her to move it herself"],
    ["must not", "ask before moving it"],
  ];
  return { verdicts: lines.map(([kind, line]) => ({ kind, line, pass: !fails.includes(line) })) };
}

test("metricRates: a higher metric counts runs whose tagged lines all passed, a lower one runs where any failed", () => {
  const questions = new Map(parseTest(CASE).questions.map((q) => [q.n, q]));
  const key = [
    { id: "a1", setup: "alpha", question: 1, run: 1 },
    { id: "a2", setup: "alpha", question: 1, run: 2 },
    { id: "a3", setup: "alpha", question: 1, run: 3 },
    { id: "a4", setup: "alpha", question: 1, run: 4 },
    { id: "a5", setup: "alpha", question: 2, run: 1 },
  ];
  const judged = new Map([
    ["a1", verdicts()],
    // Never called the calendar and said it can't: incomplete and cant_first.
    ["a2", verdicts(["call calendar_event", "say it can't change her calendar"])],
    // Moved it but told her nothing: the write happened, the confirm did not.
    ["a3", verdicts(["say it moved the haircut to 1 pm"])],
    // Unanswered: not a run.
    ["a4", { verdicts: [], skipped: "no answer" }],
    ["a5", { verdicts: [{ kind: "must", line: "say hi", pass: true }] }],
  ]);
  const rates = metricRates({ key, judged, questions }).alpha;
  assert.deepEqual(rates.task_completion_rate, { runs: 3, counted: 1, rate: (1 / 3) * 100 });
  assert.deepEqual(rates.cant_first_rate, { runs: 3, counted: 1, rate: (1 / 3) * 100 });
  assert.deepEqual(rates.write_and_confirm_accuracy, { runs: 3, counted: 2, rate: (2 / 3) * 100 });
  assert.deepEqual(rates.unnecessary_handback_rate, { runs: 3, counted: 0, rate: 0 });
  assert.equal(rates.tool_attempt_before_punt_rate, undefined, "no line names it, so it has no rate");
});

test("metricRates matches a verdict line read back from a result note, its whitespace folded", () => {
  const questions = new Map(parseTest(CASE).questions.map((q) => [q.n, q]));
  const judged = new Map([["a1", { verdicts: [{ kind: "must not", line: "tell her  to move it\nherself", pass: false }] }]]);
  const rates = metricRates({ key: [{ id: "a1", setup: "alpha", question: 1, run: 1 }], judged, questions }).alpha;
  assert.deepEqual(rates.unnecessary_handback_rate, { runs: 1, counted: 1, rate: 100 });
});

test("the score section prints the metrics by their ids, and nothing when no line names one", () => {
  const questions = new Map(parseTest(CASE).questions.map((q) => [q.n, q]));
  const key = [{ id: "a1", setup: "alpha", question: 1, run: 1 }];
  const judged = new Map([["a1", verdicts(["tell her to move it herself"])]]);
  const answers = new Map([["a1", { conversation: [{ from: "assistant", text: "Moved it to 1." }], time: null }]]);
  const scored = scoreSetups({ key, judged, answers, questions, bars: { score: null, price: null, speed: null, texts: null } });
  const section = scoreSection({ judgeModel: "judge", date: "2026-11-26", rows: scored.rows, best: scored.best, metrics: scored.metrics });
  assert.match(section, /### Metrics/);
  assert.match(section, /\| `task_completion_rate` \| higher \| 100% \(1 of 1\) \|/);
  assert.match(section, /\| `unnecessary_handback_rate` \| lower \| 100% \(1 of 1\) \|/);
  assert.deepEqual(metricLines({}, ["alpha"]), []);
});

test("tests/fd-completion.md reads, every case names metrics, and every Area 1 metric is measured", async () => {
  const raw = await readFile(fileURLToPath(new URL("../ai/tests/fd-completion.md", import.meta.url)), "utf8");
  const { questions } = parseTest(raw);
  assert.ok(questions.length >= 5);
  for (const q of questions) {
    assert.equal(q.kind, "task", `case ${q.n} is a gate`);
    assert.equal(q.drafted, null, `case ${q.n} runs`);
    assert.ok(q.metrics.length > 0, `case ${q.n} names metrics`);
    assert.ok(q.checks.length > 0, `case ${q.n} has a record check`);
  }
  const named = new Set(questions.flatMap((q) => q.metrics.flatMap((tag) => tag.ids)));
  assert.deepEqual([...named].sort(), Object.keys(METRICS).filter((id) => METRICS[id].area !== 2).sort(), "every Area 1 metric (Area 2's are groups.md and cross-chat.md's)");
  // Each metric is backed by at least one record check somewhere, except the judge-only rubric ones.
  const checked = new Set(questions.flatMap((q) => q.metrics.filter((tag) => q.checks.some((c) => c.line === tag.line)).flatMap((tag) => tag.ids)));
  for (const id of ["task_completion_rate", "cant_first_rate", "write_and_confirm_accuracy", "tool_attempt_before_punt_rate"]) assert.ok(checked.has(id), `${id} has a record check`);
});
