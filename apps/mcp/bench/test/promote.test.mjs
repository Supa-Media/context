/**
 * The promotion gate (`bench/promote.mjs`) and the spend cap (`bench/spend.mjs`):
 * a setup goes live only from scored rounds that measured today's files on an
 * unweakened test and beat live, and no round starts past the cap.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { productionNote, promotionVerdict, readRound, weakenedLines } from "../promote.mjs";
import { expectedUsd, parseSpend, roundRow, spendCheck, withRow } from "../spend.mjs";

const version = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 12);

const testFile = (cases, { runs = 3, score = "100%" } = {}) =>
  [
    "---",
    "job: texting-assistant",
    `runs: ${runs}`,
    "good_enough:",
    `  score: ${score}`,
    "---",
    "",
    ...cases.flatMap(([n, lines]) => [`## ${n}. Question ${n}`, "", "- kind: task", ...lines, ""]),
  ].join("\n");

const CORE = testFile([
  [1, ["- must: answer the date"]],
  [2, ["- must not: share the private note"]],
]);
const TASKS = testFile([[1, ["- must call: read_skill", "- must: end connected"]]]);

/** A scored round's text: front matter, one answer block per question, the scores table. */
function roundText({ test, testRaw, setups, rows, runs = 3, asked = [1, 2] }) {
  return [
    "---",
    "job: texting-assistant",
    `test: ${test}`,
    `test_version: ${version(testRaw)}`,
    `setups: [${setups.map(([name, v]) => `${name}@${v}`).join(", ")}]`,
    `runs_per_question: ${runs}`,
    "---",
    "",
    "## Answers",
    "",
    ...asked.flatMap((n) => [`### ${n}. Question ${n}`, "", "as Maya, task", "", `#### a${n}`, "", "**Assistant:** Done.", "", "Tools: none", "Time 4.0 s, $0.0100, 1 text", ""]),
    "## Scored by claude-haiku-5-5, 2026-10-17",
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(([setup, score, gates, price, speed, errors = 0]) => `| ${setup} | ${score} | ${gates} | 0 of 0 | ${price} | ${speed} | 1.0 | ${errors} | no |`),
    "",
  ].join("\n");
}

const round = (opts, committedRaw = opts.testRaw) => ({ ...readRound(roundText(opts)), testRaw: opts.testRaw, committedRaw });

const winning = () => [
  round({ test: "core", testRaw: CORE, setups: [["production", "live111"], ["cand", "cand222"]], rows: [["production", "0%", "passed", "$0.0072", "9.0 s"], ["cand", "100%", "passed", "$0.0071", "8.6 s"]] }),
  round({ test: "tasks", testRaw: TASKS, setups: [["production", "live111"], ["cand", "cand222"]], rows: [["production", "70%", "failed (q1)", "$0.1050", "60.0 s"], ["cand", "80%", "failed (q1)", "$0.1000", "58.0 s"]], asked: [1] }),
];

const verdict = (rounds, extra = {}) => promotionVerdict({ job: "texting-assistant", setup: "cand", rounds, liveVersion: "live111", candidateVersion: "cand222", ...extra });

test("a candidate that beats live on today's files and an unweakened test is promoted", () => {
  const result = verdict(winning());
  assert.deepEqual(result.reasons, []);
  assert.equal(result.ok, true);
  assert.match(result.proof.join("\n"), /core: cand 100% against live's 0%/);
});

test("a round of an earlier live file or an earlier candidate proves nothing", () => {
  assert.match(verdict(winning(), { liveVersion: "live999" }).reasons.join("\n"), /earlier live file/);
  assert.match(verdict(winning(), { candidateVersion: "cand999" }).reasons.join("\n"), /earlier cand/);
});

test("both tests must have run, every case asked, at the test's own runs", () => {
  assert.match(verdict([winning()[0]]).reasons.join("\n"), /no tasks round/);
  const short = winning();
  short[0] = round({ test: "core", testRaw: CORE, runs: 1, asked: [1], setups: [["production", "live111"], ["cand", "cand222"]], rows: [["production", "50%", "passed", "$0.0072", "9.0 s"], ["cand", "100%", "passed", "$0.0071", "8.6 s"]] });
  const reasons = verdict(short).reasons.join("\n");
  assert.match(reasons, /1 runs a question/);
  assert.match(reasons, /cases 2 were not asked/);
});

test("a test cut in the app cannot buy a promotion", () => {
  const cut = testFile([
    [1, ["- must: answer the date"]],
    [2, []],
  ]);
  assert.deepEqual(weakenedLines(CORE, cut), ['case 2 lost "- must not: share the private note"']);
  assert.deepEqual(weakenedLines(CORE, testFile([[1, ["- must: answer the date"]]])), ["case 2 is gone"]);
  assert.deepEqual(weakenedLines(CORE, testFile([[1, ["- must: answer the date"]], [2, ["- must not: share the private note"]]], { runs: 1, score: "50%" })), ["the score bar fell from 100% to 50%", "runs fell from 3 to 1"]);
  assert.deepEqual(weakenedLines(CORE, testFile([[1, ["- must: answer the date", "- must: and the time"]], [2, ["- must not: share the private note"]]])), [], "adding is never weakening");

  const rounds = winning();
  rounds[0] = { ...rounds[0], testRaw: cut, testVersion: version(cut) };
  rounds[0].committedRaw = CORE;
  assert.match(verdict(rounds).reasons.join("\n"), /the test was weakened: case 2 lost/);
});

test("a candidate under the bar, worse than live, broken on a gate, or no better is refused", () => {
  const mk = (core, tasks) => [
    round({ test: "core", testRaw: CORE, setups: [["production", "live111"], ["cand", "cand222"]], rows: core }),
    round({ test: "tasks", testRaw: TASKS, setups: [["production", "live111"], ["cand", "cand222"]], rows: tasks, asked: [1] }),
  ];
  // Two cases asked, so live at 0% leaves the candidate two cases to gain.
  const liveCore = ["production", "0%", "passed", "$0.0072", "9.0 s"];
  const liveTasks = ["production", "80%", "failed (q1)", "$0.1050", "60.0 s"];
  const okTasks = ["cand", "80%", "failed (q1)", "$0.1000", "58.0 s"];

  assert.match(verdict(mk([liveCore, ["cand", "84.2%", "passed", "$0.0071", "8.6 s"]], [liveTasks, okTasks])).reasons.join("\n"), /under the bar of 89.5%/);
  assert.match(verdict(mk([liveCore, ["cand", "100%", "failed (q2)", "$0.0071", "8.6 s"]], [liveTasks, okTasks])).reasons.join("\n"), /broke a gate/);
  assert.match(verdict(mk([liveCore, ["cand", "100%", "passed", "$0.0071", "8.6 s"]], [liveTasks, ["cand", "70%", "failed (q1)", "$0.1000", "58.0 s"]])).reasons.join("\n"), /under the bar of 75.0%/);
  assert.match(verdict(mk([liveCore, ["cand", "100%", "passed", "$0.0900", "8.6 s"]], [liveTasks, okTasks])).reasons.join("\n"), /costs \$0.09 a question/);
  assert.match(verdict(mk([liveCore, ["cand", "100%", "passed", "$0.0071", "8.6 s", 2]], [liveTasks, okTasks])).reasons.join("\n"), /erred 2 times/);
  const same = verdict(mk([["production", "100%", "passed", "$0.0072", "9.0 s"], ["cand", "100%", "passed", "$0.0071", "8.6 s"]], [liveTasks, ["cand", "80%", "failed (q1)", "$0.1040", "58.0 s"]]));
  assert.match(same.reasons.join("\n"), /not better than live by more than noise/);
  // One case better is noise, not a win.
  assert.match(verdict(mk([["production", "50%", "passed", "$0.0072", "9.0 s"], ["cand", "100%", "passed", "$0.0071", "8.6 s"]], [liveTasks, okTasks])).reasons.join("\n"), /1.0 cases gained, 2 needed/);
  // Over its price bar but no dearer than live: golden tasks today.
  assert.deepEqual(verdict(mk([liveCore, ["cand", "100%", "passed", "$0.0071", "8.6 s"]], [liveTasks, ["cand", "80%", "failed (q1)", "$0.1100", "58.0 s"]])).reasons, []);
});

test("only a job with a gate is ever promoted, and never live over itself", () => {
  assert.match(promotionVerdict({ job: "dream", setup: "cand", rounds: [] }).reasons[0], /no promotion gate/);
  assert.match(promotionVerdict({ job: "texting-assistant", setup: "production", rounds: [] }).reasons[0], /over itself/);
});

test("the promoted file keeps the candidate's settings and body, and says how it got there", () => {
  const candidateRaw = ["---", "job: texting-assistant", "models:", "  main: anthropic/claude-haiku-5-5", "title: Shorter replies", "based_on: production", "change: one line", "why: replies ran long", "made_by: improver (x)", "---", "", "You are Tex.", ""].join("\n");
  const liveRaw = ["---", "job: texting-assistant", "from: dates-sweep-3", "promoted_by: Dev2", "models:", "  main: anthropic/claude-haiku-5-5", "---", "", "You were Tex.", ""].join("\n");
  const note = productionNote({ candidateRaw, liveRaw, job: "texting-assistant", setup: "shorter", date: "2026-10-17", proof: ["core: shorter 100% against live's 90%"], runUrl: "https://example.test/run/1", archived: "ai/history/texting-assistant/2026-10-17T1200 dates-sweep-3.md" });
  assert.match(note, /^---\njob: texting-assistant\nfrom: shorter\nmodels:\n {2}main: anthropic\/claude-haiku-5-5\n/);
  assert.doesNotMatch(note, /title:|based_on:|made_by:|change:/);
  assert.match(note, /came_from: setups\/texting-assistant\/shorter, promoted 2026-10-17 over dates-sweep-3, whose file is ai\/history/);
  assert.match(note, /why: replies ran long/);
  assert.match(note, /promoted_by: the benchmark promotion gate .*Dev2's standing approval/);
  assert.match(note, /\n---\n\nYou are Tex.\n$/);
});

const SPEND = ["---", "role: benchmark-spend", "cap_usd: 20", "---", "", "# AI Benchmark spend", "", "| date | run | test | setups | answers | usd |", "| --- | --- | --- | --- | --- | --- |", "| 2026-10-17 | before the ledger | all | production | 879 | $12.00 |", "| 2026-10-17 | gh-51 | tasks | production | 30 | $3.78 |", "", "Total: $15.78 of the $20.00 cap.", ""].join("\n");

test("the spend note's total and cap are read back, and a round past the cap is refused", () => {
  const { cap, total, rows } = parseSpend(SPEND);
  assert.equal(cap, 20);
  assert.equal(Number(total.toFixed(2)), 15.78);
  assert.equal(expectedUsd({ rows, test: "tasks", setups: 2 }), 7.56, "two setups cost twice the dearest setup before");
  assert.equal(expectedUsd({ rows, test: "core", setups: 2 }), 2, "a test never run is $1 a setup");
  assert.equal(spendCheck({ raw: SPEND, test: "core", setups: 2 }).ok, true);
  assert.match(spendCheck({ raw: SPEND, test: "tasks", setups: 2 }).reason, /raise cap_usd/);
  assert.equal(spendCheck({ raw: null, test: "core", setups: 1 }).ok, false, "no note, no round");
  assert.equal(spendCheck({ raw: SPEND.replace("cap_usd: 20", "cap_usd: lots"), test: "core", setups: 1 }).ok, false, "an unreadable cap is no cap");
});

test("a round's row prices its answers plus a fifth, and the total follows", () => {
  const result = roundText({ test: "core", testRaw: CORE, setups: [["production", "live111"], ["cand", "cand222"]], rows: [], asked: [1, 2] }).replace("job: texting-assistant", "job: texting-assistant\ndate: 2026-10-17");
  const row = roundRow(result, "gh-60");
  assert.deepEqual(row, { date: "2026-10-17", run: "gh-60", test: "core", setups: ["production", "cand"], answers: 2, usd: 0.02 });
  const next = withRow(SPEND, row);
  assert.match(next, /\| 2026-10-17 \| gh-60 \| core \| production, cand \| 2 \| \$0.02 \|\n\nTotal: \$15.80 of the \$20.00 cap.\n$/);
  assert.equal(parseSpend(next).rows.length, 3);
});
