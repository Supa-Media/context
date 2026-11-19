import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeJudge } from "../bench/judge.mjs";
import { abilityList, fakeAbilityReply, isAbilityBody } from "../bench/setsAbility.mjs";
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

/** The `--fake` sender: the scripted judge, and the scripted ability check for its own requests. */
function routedFake() {
  const judge = fakeJudge();
  return async (body) => (isAbilityBody(body) ? fakeAbilityReply(body) : judge(body));
}

/**
 * A sender that answers the ability check by a rule: `impossibleBy(line, vote)` says whether that must line is
 * impossible on that vote. The judge is the scripted one.
 */
function abilitySend(impossibleBy, seen = []) {
  const judge = fakeJudge();
  return async (body) => {
    if (!isAbilityBody(body)) return judge(body);
    seen.push(JSON.parse(body));
    const content = JSON.parse(body).messages[0].content;
    const vote = Number(/vote: (\d)/.exec(content)[1]);
    const must = JSON.parse(content.slice(content.indexOf("<must_lines>") + 12, content.indexOf("</must_lines>")));
    const lines = must.map((line) => (impossibleBy(line, vote)
      ? { line, missing: "the phone's address book", possible: false }
      : { line, missing: "", possible: true }));
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ lines }) }] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
  const report = await goldCheck([c], { send: ruledSend({ "say Tuesday": "tuesday", "say Friday": "friday" }), model: "test-model", abilities: false });
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
  await goldCheck([c], { send: ruledSend({}, seen), model: "test-model", abilities: false });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].messages[0].content.includes("Tuesday, first answer."));
  assert.ok(!seen[0].messages[0].content.includes("AFTERWARDS"));
});

test("a must not line is inverted: the judge saying the reply does the forbidden thing fails it", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "when is it?", labels: fd(["say Tuesday"], ["make up a date"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday, and I made up a date too." },
  ]);
  const report = await goldCheck([c], { send: ruledSend({ "say Tuesday": "tuesday", "make up a date": "made up" }), model: "test-model", abilities: false });
  assert.equal(report.goldFails.length, 1);
  assert.deepEqual(report.goldFails[0].failed, [{ kind: "must not", line: "make up a date", reason: 'the reply has "made up"' }]);

  const clean = conv([
    { id: "m1", who: "Maya", text: "when is it?", labels: fd(["say Tuesday"], ["make up a date"]) },
    { id: "m2", who: "Tex", tex: true, text: "Tuesday at three." },
  ]);
  const passing = await goldCheck([clean], { send: ruledSend({ "say Tuesday": "tuesday", "make up a date": "made up" }), model: "test-model", abilities: false });
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
  await goldCheck([c], { send: ruledSend({}, seen), model: "test-model", abilities: false });
  const [payload] = payloadsOf(seen);
  assert.deepEqual(payload.answers[0].conversation, [
    { from: "person", text: "and the bill?" },
    { from: "assistant", text: '(Tex reacted 🔍 to their text "Yes, at noon in the usual place.")', tapback: true },
  ]);
});

test("the CLI and the functions refuse any set but Training or Dev: the Test set is sealed", async () => {
  const run = spawnSync(process.execPath, [...process.execArgv, SCRIPT, "--set", "test", "--fake"], { cwd: MCP, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /the gold self-check reads Training or Dev labels only; the Test set is sealed/);
  assert.throws(() => goldRequests([], { set: "test" }), /the Test set is sealed/);
  await assert.rejects(goldCheck([], { send: fakeJudge(), set: "test" }), /the Test set is sealed/);
});

test("the gold check plumbs through the real Training sets with the fake judge", async () => {
  const training = (await loadSets()).filter((c) => c.set === "training");
  const report = await goldCheck(training, { send: routedFake(), model: "fake" });
  assert.ok(report.rows > 0, "some Training labels are judged");
  assert.equal(report.model, "fake");
  assert.equal(report.set, "training");
  assert.deepEqual(report.impossible, [], "the fake ability check says every line is possible");
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

test("a Dev run judges Dev labels only, and a Training run skips them; the report names its set", async () => {
  const training = conv([{ id: "t1", who: "Maya", text: "tr?", labels: fd(["say Tuesday"]) }, { id: "t2", tex: true, text: "Tuesday." }], "tr");
  const dev = { ...conv([{ id: "d1", who: "Maya", text: "dv?", labels: fd(["say Friday"]) }, { id: "d2", tex: true, text: "Friday." }], "dv"), set: "dev" };
  assert.equal(goldRequests([training, dev], { model: "m" }).requests.length, 1, "Training by default");
  assert.equal(goldRequests([training, dev], { model: "m" }).requests[0].convId, "tr");
  const seen = [];
  const report = await goldCheck([training, dev], { send: ruledSend({}, seen), model: "m", set: "dev", abilities: false });
  assert.equal(report.set, "dev");
  assert.equal(report.rows, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].messages[0].content.includes("dv?"), "the Dev row is judged");
  assert.ok(!seen[0].messages[0].content.includes("tr?"), "the Training row is not");
});

test("a Dev report keeps no label line or judge reason, only each failed line's kind", async () => {
  const dev = { ...conv([{ id: "d1", who: "Maya", text: "dv?", labels: fd(["say Friday"]) }, { id: "d2", tex: true, text: "Tuesday." }], "dv"), set: "dev" };
  const report = await goldCheck([dev], { send: ruledSend({ "say Friday": "friday" }), model: "m", set: "dev", abilities: false });
  assert.deepEqual(report.goldFails, [{ convId: "dv", msgIndex: 0, msgId: "d1", failed: [{ kind: "must" }] }]);
});

test("the ability check flags a row only when both votes call a must line impossible, by index", async () => {
  const c = conv([
    { id: "m1", who: "Maya", text: "read my contacts", labels: fd(["find Ana's number in the phone's contacts", "say hello"]) },
    { id: "m2", who: "Tex", tex: true, text: "Hello." },
  ]);
  const line = "find Ana's number in the phone's contacts";
  const one = await goldCheck([c], { send: abilitySend((l, vote) => l === line && vote === 1), model: "m" });
  assert.deepEqual(one.impossible, [], "one vote alone never marks a row");

  const both = await goldCheck([c], { send: abilitySend((l) => l === line), model: "m" });
  assert.deepEqual(both.impossible, [{ convId: "g1", msgIndex: 0, msgId: "m1", lines: [{ line, missing: "the phone's address book" }] }]);

  const seen = [];
  await goldCheck([c], { send: abilitySend(() => false, seen), model: "m" });
  assert.deepEqual(seen.map((request) => /vote: (\d)/.exec(request.messages[0].content)[1]), ["1", "2"], "two separate asks, told apart by vote");
  assert.equal(seen[0].system, seen[1].system);
  assert.equal(seen[0].output_config.format.type, "json_schema");
});

test("the ability check is off with abilities: false, and a judge request is never taken for an ability one", async () => {
  const c = conv([{ id: "m1", who: "Maya", text: "q", labels: fd(["find the phone's contacts"]) }, { id: "m2", tex: true, text: "a" }]);
  const off = await goldCheck([c], { send: abilitySend(() => true), model: "m", abilities: false });
  assert.deepEqual(off.impossible, []);
  const [judgeRequest] = goldRequests([c], { model: "m" }).requests;
  assert.equal(isAbilityBody(judgeRequest.body), false);
});

test("abilityList: a group chat gets the group text and the group can'ts; a 1:1 gets the texts and the 1:1 can'ts", () => {
  const group = abilityList("group");
  const one = abilityList("one");
  assert.ok(group.includes("- Who is in a chat: say who is in this chat from its whole list"), "the group text");
  assert.ok(group.includes("- can't: see the account of someone whose number here isn't on Context"), "a group can't");
  assert.ok(!group.includes("- can't: archive, comment on, add a picture to or remember in a note, or move a folder"), "a guest-only can't is left out");
  assert.ok(!group.includes("share someone's mail with a group chat from a 1:1 text"), "a 1:1-only can't is left out of a group");
  assert.ok(one.includes("- Who is in a chat: a 1:1 text is just them"), "the 1:1 text");
  assert.ok(!one.includes("say who is in this chat from its whole list"), "no group text in a 1:1");
  assert.ok(one.includes("- can't: share someone's mail with a group chat from a 1:1 text"), "a 1:1 can't");
  assert.ok(!one.includes("see the account of someone whose number here isn't on Context"), "a group-only can't is left out of a 1:1");
});

test("the CLI with --set dev prints counts and ids only, never a label line, a message or a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold-dev-"));
  const convs = [
    { id: "d1", set: "dev", kind: "one", members: ["Maya"], msgs: [
      { id: "m1", who: "Maya", text: "QUOKKA question", labels: fd(["flamingo schedule"]) },
      { id: "m2", tex: true, text: "Nothing relevant here." },
    ] },
    { id: "t1", set: "training", kind: "one", members: ["Maya"], msgs: [
      { id: "m1", who: "Maya", text: "training question", labels: fd(["penguin nursery"]) },
      { id: "m2", tex: true, text: "Nothing relevant here." },
    ] },
  ];
  writeFileSync(join(dir, "convs.json"), JSON.stringify(convs));
  const report = join(dir, "gold.json");
  const run = spawnSync(process.execPath, [...process.execArgv, SCRIPT, "--set", "dev", "--fake", "--conversations", join(dir, "convs.json"), "--out", report], { cwd: MCP, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /gold self-check \(dev\): 1 of 1 Dev labels fail their own gold/);
  assert.match(run.stdout, /^GOLD FAIL d1 0$/m);
  for (const secret of ["flamingo", "schedule", "QUOKKA", "Nothing", "penguin", "training question"]) {
    assert.ok(!run.stdout.includes(secret), `stdout names nothing of a Dev row: ${secret}`);
    assert.ok(!run.stderr.includes(secret), `stderr names nothing of a Dev row: ${secret}`);
  }
  const written = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(written.set, "dev");
  assert.deepEqual(written.goldFails, [{ convId: "d1", msgIndex: 0, msgId: "m1", failed: [{ kind: "must" }] }]);
});
