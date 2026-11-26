// The judge graded against people's labels (`judgeGold.mjs`, Dev2, 2026-11-26).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GOLD_DIR, compareWithLabels, goldReport, lineKind } from "../judgeGold.mjs";
import { parseTest } from "../load.mjs";
import { parseResult } from "../resultNote.mjs";

const label = (id, line, value) => ({ test: "t", id, line, label: value });
const round = (entries) => new Map(entries.map(([id, line, pass]) => [`t/${id}`, [{ line, pass, reason: `said ${pass}` }]]));

test("agreement is the majority across rounds against the label; a line called both ways is a flip", () => {
  const labels = [label("a", "x", "pass"), label("b", "x", "fail"), label("c", "x", "pass"), label("d", "gone", "pass")];
  const result = compareWithLabels(labels, [
    round([["a", "x", true], ["b", "x", true], ["c", "x", true]]),
    round([["a", "x", true], ["b", "x", true], ["c", "x", false]]),
    round([["a", "x", true], ["b", "x", true], ["c", "x", false]]),
  ]);
  assert.equal(result.lines, 3, "a label whose line never reached the judge is stale, not scored");
  assert.equal(result.stale, 1);
  assert.deepEqual(result.rows.map((row) => row.judge ?? "stale"), ["pass", "pass", "fail", "stale"]);
  assert.equal(result.agreement, 1 / 3);
  assert.equal(result.flips, 1);
  const report = goldReport(result, { model: "m", times: 3 });
  assert.match(report, /Agreement: \*\*33%\*\* of 3 labelled lines; 1 flipped between rounds; 1 stale/);
  assert.match(report, /- t b: "x"\. Label fail, judge pass\./);
});

test("an even split is neither pass nor fail, so it never agrees", () => {
  const result = compareWithLabels([label("a", "x", "pass")], [round([["a", "x", true]]), round([["a", "x", false]])]);
  assert.equal(result.rows[0].judge, "split");
  assert.equal(result.agreement, 0);
});

test("line kinds name what the judge is weak on", () => {
  assert.equal(lineKind("reads like texts from a capable friend, not a report"), "style");
  assert.equal(lineKind("never says it sent, saved, added, moved or set something its tools did not do"), "truthfulness");
  assert.equal(lineKind("say it was Dee's"), "case line");
});

test("every gold label names an answer in its gold file and a line its test still has", () => {
  const labels = JSON.parse(readFileSync(new URL("labels.json", `file://${GOLD_DIR}`), "utf8"));
  assert.ok(labels.length >= 10);
  for (const entry of labels) {
    assert.match(entry.label, /^(pass|fail)$/);
    const gold = parseResult(readFileSync(new URL(`${entry.test}.md`, `file://${GOLD_DIR}`), "utf8"));
    const answer = gold.answers.find((a) => a.id === entry.id);
    assert.ok(answer, `${entry.id} is in ${entry.test}.md`);
    const testFile = parseTest(readFileSync(new URL(`../ai/tests/${entry.test}.md`, import.meta.url), "utf8"));
    const question = testFile.questions.find((q) => q.n === answer.question);
    const all = JSON.stringify([question, testFile.everyAnswer]);
    assert.ok(all.includes(entry.line.slice(0, 40)), `${entry.test} q${answer.question} still has "${entry.line}"`);
  }
});
