import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { fakeJudge } from "../bench/judge.mjs";
import { goldCheck, goldOf, goldRequests } from "../bench/setsGold.mjs";
import { loadSets } from "../bench/sets.mjs";

const SCRIPT = new URL("../bench/setsGold.mjs", import.meta.url).pathname;
// The test runner's flags name ./test/tsRegister.mjs relative to apps/mcp, so the child runs from there.
const MCP = new URL("..", import.meta.url).pathname;

const conv = (msgs, id = "g1") => ({ id, set: "training", kind: "one", members: ["Maya"], msgs });
const fd = (must, never = []) => ({ fd: { must, never, star: true } });

/** A fake judge: a line passes (does: true) when the gold text contains its keyword; `keywords` maps line to keyword. */
function ruledSend(keywords, seen = []) {
  return async (body) => {
    seen.push(JSON.parse(body));
    const content = JSON.parse(body).messages[0].content;
    const payload = JSON.parse(content.slice(content.indexOf("<answers>") + 9, content.indexOf("</answers>")));
    const [answer] = payload.answers;
    const said = answer.conversation
      .filter((turn) => turn.from === "assistant")
      .map((turn) => turn.text)
      .join(" ")
      .toLowerCase();
    const verdicts = payload.checks.map((check) => {
      const word = keywords[check.line] ?? check.line;
      const does = said.includes(word.toLowerCase());
      return { line: check.line, does, reason: does ? `the reply has "${word}"` : `the reply has no "${word}"` };
    });
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ answers: [{ id: answer.id, verdicts }] }) }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const payloadsOf = (seen) => seen.map((request) => {
  const content = request.messages[0].content;
  return JSON.parse(content.slice(content.indexOf("<answers>") + 9, content.indexOf("</answers>")));
});

test("a label its own gold reply fails is reported with the judge's reason; one its gold passes is not", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "When is the dentist?", labels: fd(["say Tuesday"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday at three." },
    { id: "m3", who: "Maya", text: "And the vet?", labels: fd(["say Friday"]) },
    { id: "m4", who: "Tex", tex: true, text: "Tuesday at three." },
  ]);
  const report = await goldCheck([c], { send: ruledSend({ "say Tuesday": "tuesday", "say Friday": "friday" }), model: "test-model" });
  assert.equal(report.model, "test-model");
  assert.equal(report.rows, 2);
  assert.equal(report.goldFails.length, 1);
  assert.deepEqual(report.goldFails[0], {
    convId: "g1",
    msgIndex: 2,
    msgId: "m3",
    failed: [{ kind: "must", line: "say Friday", reason: 'the reply has no "friday"' }],
  });
  assert.deepEqual(report.skipped, []);
});

test("the gold window stops at the next person line: a Tex text after it never reaches the judge", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "first question", labels: fd(["say Tuesday"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday, first answer." },
    { id: "m3", who: "Maya", text: "second question" },
    { id: "m4", who: "Tex", tex: true, text: "Friday, second answer AFTERWARDS." },
  ]);
  assert.deepEqual(goldOf(c, 0), [{ from: "assistant", text: "Tuesday, first answer." }]);
  const seen = [];
  await goldCheck([c], { send: ruledSend({}, seen), model: "test-model" });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].messages[0].content.includes("Tuesday, first answer."));
  assert.ok(!seen[0].messages[0].content.includes("AFTERWARDS"));
});

test("a must not line is inverted: the judge saying the reply does the forbidden thing fails it", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "when is it?", labels: fd(["say Tuesday"], ["make up a date"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday, and I made up a date too." },
  ]);
  const report = await goldCheck([c], { send: ruledSend({ "say Tuesday": "tuesday", "make up a date": "made up" }), model: "test-model" });
  assert.equal(report.goldFails.length, 1);
  assert.deepEqual(report.goldFails[0].failed, [{ kind: "must not", line: "make up a date", reason: 'the reply has "made up"' }]);

  const clean = conv([
    { id: "m1", who: "Maya", text: "when is it?", labels: fd(["say Tuesday"], ["make up a date"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday at three." },
  ]);
  const passing = await goldCheck([clean], { send: ruledSend({ "say Tuesday": "tuesday", "make up a date": "made up" }), model: "test-model" });
  assert.deepEqual(passing.goldFails, []);
});

test("a tapback on another text renders with the quoted text it reacted to", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "lunch?" },
    { id: "m2", who: "Tex", tex: true, text: "Yes, at noon in the usual place." },
    { id: "m3", who: "Maya", text: "and the bill?", labels: fd(["say noon"]) },
    { id: "m4", who: "Tex", tex: true, kind: "react", to: "m2", text: "🔍" },
  ]);
  const [row] = goldRequests([c], { model: "test-model" }).requests;
  assert.ok(row, "the labelled row is judged");
  const seen = [];
  await goldCheck([c], { send: ruledSend({}, seen), model: "test-model" });
  const [payload] = payloadsOf(seen);
  assert.deepEqual(payload.answers[0].conversation, [
    { from: "person", text: "and the bill?" },
    { from: "assistant", text: '(Tex reacted 🔍 to their text "Yes, at noon in the usual place.")', tapback: true },
  ]);
});

test("the CLI refuses any set but training", () => {
  const run = spawnSync(process.execPath, [...process.execArgv, SCRIPT, "--set", "dev", "--fake"], { cwd: MCP, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /the gold self-check reads Training labels only/);
});

test("the gold check plumbs through the real Training sets with the fake judge", async () => {
  const training = (await loadSets()).filter((c) => c.set === "training");
  const report = await goldCheck(training, { send: fakeJudge(), model: "fake" });
  assert.ok(report.rows > 0, "some Training labels are judged");
  assert.equal(report.model, "fake");
  assert.ok(Array.isArray(report.goldFails));
  assert.ok(Array.isArray(report.skipped));
  for (const fail of report.goldFails) {
    assert.ok(fail.convId && Number.isInteger(fail.msgIndex) && fail.failed.length > 0);
  }
});

test("a gold picture reads as a sent picture, and a job tapback that was the whole answer reads as a started job", async () => {
  const { textOf, goldOf, goldJobs } = await import("../bench/setsGold.mjs");
  assert.equal(textOf("Pinned: [picture: the three apps side by side]"), "Pinned:\n[Sent a picture with this answer: 1. the three apps side by side.]");
  assert.equal(textOf("no picture here"), "no picture here");
  const c = { id: "t", set: "training", msgs: [
    { id: "a", who: "Pia", text: "Tex pull up prices for the readers. Thanks", labels: { fd: { must: ["react first, then go look"], star: true } } },
    { id: "b", tex: true, kind: "react", text: "🔎", to: "a" },
    { id: "c", who: "Kofi", text: "nice" },
    { id: "d", tex: true, text: "Square is cheapest." },
  ] };
  assert.deepEqual(goldJobs(c, 0, goldOf(c, 0)), [{ title: "Tex pull up prices for the readers." }]);
  const worded = { ...c, msgs: [c.msgs[0], c.msgs[1], { id: "e", tex: true, text: "On it" }] };
  assert.deepEqual(goldJobs(worded, 0, goldOf(worded, 0)), [], "words after the tapback: answered, no job");
});
