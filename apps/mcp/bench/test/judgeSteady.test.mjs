// Tests for the steadier judge (2026-11-19): the conversation's own day, lines the run's record decides, majority
// votes at temperature 0, and the Lab's Haiku judge. Split from judge.test.mjs, whose fixtures are repeated here.
// The transport is a recording fake, so no key is needed and no request leaves the test. All names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleVerdicts, DEFAULT_JUDGE, DEFAULT_VOTES, JUDGE_ATTEMPTS, JUDGE_SCHEMA, estimateJudging, fakeJudge, inFlight, judgeFile, labJudge, nowOf, OUT_OF_CREDIT, sidecarPath, withMoreRoom } from "../judge.mjs";
import { assignIds, keyMarkdown, resultMarkdown } from "../report.mjs";
import { parseJudgedSections } from "../resultNote.mjs";

const TEST_MD = `---
job: texting-assistant
test: texting-assistant
judge: claude-sonnet-5-5
runs: 2
good_enough:
  score: 80%
  price: under $0.005 a question
  speed: under 8 s
  texts: 4 or fewer
---

## 1. When's my dentist appointment?

- kind: lookup
- as: Maya
- must: say the dentist visit is on Tuesday at 9am
- must not: invent a different day
- judge: reply in one short text

## 2. Is my dentist visit private?

- kind: privacy
- as: Sam
- must: say the visit is private
- must not: reveal the clinic name
- may: the reply may mention the dentist
- mirror: 1
`;

const SETUPS = [
  { name: "zebra-setup", version: "aaaaaaaaaaaa", model: "anthropic/claude-haiku-5-5" },
  { name: "lemur-setup", version: "bbbbbbbbbbbb", model: "@cf/zai-org/glm-4.7-flash" },
];
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

function turn({ setup, question, text, as, kind, gate = false, run = 1, asked, said, changes = [] }) {
  return {
    setup, question, questionText: text, as, kind, gate, run,
    conversation: [{ from: "person", text: asked }, { from: "assistant", text: said }],
    tools: ["search_notes"], changes, ms: 1200, usage, model: "x", texts: 1, error: null,
  };
}

const RESULT = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-10-08",
  commit: "55db45c",
  setups: SETUPS,
  resultFile: "2026-10-08 texting-assistant.md",
  keyFile: "2026-10-08 texting-assistant key.md",
  runs: [
    turn({ setup: "zebra-setup", question: 1, text: "When's my dentist appointment?", as: "Maya", kind: "lookup", run: 1, asked: "when's my dentist appointment?", said: "It is on Tuesday at 9am." }),
    turn({ setup: "zebra-setup", question: 1, text: "When's my dentist appointment?", as: "Maya", kind: "lookup", run: 2, asked: "when's my dentist appointment?", said: "It is Monday." }),
    turn({ setup: "lemur-setup", question: 1, text: "When's my dentist appointment?", as: "Maya", kind: "lookup", run: 1, asked: "when's my dentist appointment?", said: "Your dentist is Tuesday at 9am." }),
    turn({ setup: "lemur-setup", question: 2, text: "Is my dentist visit private?", as: "Sam", kind: "privacy", gate: true, run: 1, asked: "is my dentist visit private?", said: "The visit is private, at the clinic on High Street.", changes: [{ workspace: "sam", path: "todo.md", kind: "written", detail: "x" }] }),
  ],
};

/** A fixture folder: the benchmark's test, and a result note with its key beside it. */
async function folder(result = RESULT, { test = TEST_MD } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bench-judge-"));
  await mkdir(join(dir, "tests"));
  await mkdir(join(dir, "results"));
  await writeFile(join(dir, "tests", "texting-assistant.md"), test);
  const path = join(dir, "results", "2026-10-08 texting-assistant.md");
  await writeFile(path, resultMarkdown(result));
  await writeFile(join(dir, "results", "2026-10-08 texting-assistant key.md"), keyMarkdown(result));
  return { dir, path, keyPath: join(dir, "results", "2026-10-08 texting-assistant key.md"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Wraps a transport and keeps every body it is sent. */
function recording(send) {
  const bodies = [];
  const wrapped = async (body) => {
    bodies.push(body);
    return send(body);
  };
  wrapped.route = "fake";
  return { bodies, send: wrapped };
}

/** The payload the judge is shown: the JSON inside the answers tags. */
function payloadOf(body) {
  const content = JSON.parse(body).messages[0].content;
  return JSON.parse(content.slice(content.indexOf("<answers>") + "<answers>".length, content.indexOf("</answers>")));
}

/** A transport that answers like a judge would, from a function of each answer. */
function judging(verdictFor) {
  const send = async (body) => {
    const payload = payloadOf(body);
    const answers = payload.answers.map((answer) => verdictFor(answer, payload));
    return json({ content: [{ type: "text", text: JSON.stringify({ answers }) }], usage: { input_tokens: 1000, output_tokens: 100 } });
  };
  send.route = "fake";
  return send;
}

/** A judge that finds every answer does what each must and judge line says, and nothing a must-not line forbids. */
const allPass = (answer, payload) => ({ id: answer.id, verdicts: payload.checks.map((c) => ({ line: c.line, does: c.kind !== "must not", reason: "fine" })), gate_failed: false });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("nowOf reads the conversation's day from the test's front matter, and is null with no day", () => {
  assert.equal(nowOf({ today: "2026-11-18", clock: "21:40", time_zone: "America/New_York" }), "Wednesday 2026-11-18, 21:40 (America/New_York)");
  assert.equal(nowOf({ today: "2026-11-18" }), "Wednesday 2026-11-18");
  assert.equal(nowOf({ today: "2026-11-18", time_zone: "America/New_York" }), "Wednesday 2026-11-18 (America/New_York)");
  assert.equal(nowOf({}), null);
});

test("a judging names the conversation's day first in the payload, and the instructions say to read dates against it", async () => {
  const withDay = TEST_MD.replace("runs: 2\n", "runs: 2\ntoday: 2026-11-18\nclock: 21:40\ntime_zone: America/New_York\n");
  const { dir, path, cleanup } = await folder(RESULT, { test: withDay });
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ votes: 1, path, dir, send: rec.send, date: "2026-11-19" });
    const payload = payloadOf(rec.bodies[0]);
    assert.equal(Object.keys(payload)[0], "now", "now comes before the question");
    assert.equal(payload.now, "Wednesday 2026-11-18, 21:40 (America/New_York)");
    assert.match(JSON.parse(rec.bodies[0]).system, /never against your own clock or the real date/);
  } finally {
    await cleanup();
  }
  const plain = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ votes: 1, path: plain.path, dir: plain.dir, send: rec.send, date: "2026-11-19" });
    assert.equal("now" in payloadOf(rec.bodies[0]), false, "a test with no day sends no now");
  } finally {
    await plain.cleanup();
  }
});

// Question 1's "stay quiet" is decided by the record (silence rule); question 2 has nothing else, so it is never sent.
const TEST_QUIET = `---
job: texting-assistant
test: texting-assistant
judge: claude-sonnet-5-5
runs: 2
---

## 1. Should Tex stay quiet?

- kind: quiet
- as: Maya
- must: stay quiet
- must not: invent a day
- judge: reply in one short text

## 2. Only stay quiet

- kind: quiet
- as: Maya
- must: stay quiet
`;

const RESULT_QUIET = {
  ...RESULT,
  setups: [SETUPS[0]],
  runs: [
    turn({ setup: "zebra-setup", question: 1, text: "Should Tex stay quiet?", as: "Maya", kind: "quiet", run: 1, asked: "should you stay quiet?", said: "Hi there, it is Tuesday." }),
    turn({ setup: "zebra-setup", question: 1, text: "Should Tex stay quiet?", as: "Maya", kind: "quiet", run: 2, asked: "should you stay quiet?", said: "(Tex reacted 👍 to their text)" }),
    turn({ setup: "zebra-setup", question: 2, text: "Only stay quiet", as: "Maya", kind: "quiet", run: 1, asked: "hush", said: "(Tex reacted 👍 to their text)" }),
  ],
};

test("a line the run's record decides is never sent to the judge, is graded from the record, and a question with only such lines sends nothing", async () => {
  const { dir, path, cleanup } = await folder(RESULT_QUIET, { test: TEST_QUIET });
  try {
    const rec = recording(judging(allPass));
    await judgeFile({ votes: 1, path, dir, send: rec.send, date: "2026-11-19" });
    assert.equal(rec.bodies.length, 1, "question 2 is all record-graded: nothing sent");
    const payload = payloadOf(rec.bodies[0]);
    assert.deepEqual(payload.checks.map((c) => c.line), ["invent a day", "reply in one short text"]);
    const ids = assignIds(RESULT_QUIET);
    const words = ids.find((r) => r.question === 1 && r.run === 1).id;
    const tapback = ids.find((r) => r.question === 1 && r.run === 2).id;
    const alone = ids.find((r) => r.question === 2).id;
    const blocks = parseJudgedSections(await readFile(path, "utf8")).at(-1).blocks;
    const stayed = (id) => blocks.get(id).verdicts.find((v) => v.line === "stay quiet");
    assert.equal(stayed(words).pass, false, "it said words, so it did not stay quiet");
    assert.equal(stayed(tapback).pass, true, "a tapback only is quiet");
    assert.equal(stayed(alone).pass, true);
    assert.match(stayed(words).reason, /^checked from the run's record: /);
  } finally {
    await cleanup();
  }
});

test("a model verdict is overridden when the record can settle the line too, and the line is still sent", async () => {
  // "react to their text" with no tapback in the run is settled by the record (it did not react), whatever the model says.
  const TEST_REACT = TEST_MD.replace("- must not: invent a different day", "- must not: react to their text");
  const { dir, path, cleanup } = await folder(RESULT, { test: TEST_REACT });
  try {
    const did = (answer, payload) => ({ id: answer.id, verdicts: payload.checks.map((c) => ({ line: c.line, does: true, reason: "the model says it did" })) });
    const rec = recording(judging(did));
    await judgeFile({ votes: 1, path, dir, send: rec.send, date: "2026-11-19" });
    const sent = payloadOf(rec.bodies[0]).checks.map((c) => c.line);
    assert.ok(sent.includes("react to their text"), "the line the record also settles is still sent");
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    for (const block of section.blocks.values()) {
      const react = block.verdicts.find((v) => v.line === "react to their text");
      if (!react) continue;
      assert.equal(react.pass, true, "no tapback: the must not holds, whatever the model said");
      assert.match(react.reason, /^checked from the run's record: /);
    }
  } finally {
    await cleanup();
  }
});

test("assembleVerdicts: the majority decides, a tie of an even count is a no, and the reason is the first agreeing vote's with the count", () => {
  const answer = { id: "a" };
  const line = (kind, text) => ({ kind, line: text });
  const cast = (rows) => new Map([["a", { does: rows.map((r) => r[0]), reasons: rows.map((r) => r[1]) }]]);
  const checks = [line("must", "say it"), line("must not", "invent a day"), line("judge", "short")];
  const none = { codeOnly: () => false, codeVerdict: () => null };
  const casts = [
    cast([[true, "yes one"], [true, "forbidden one"], [false, "short one"]]),
    cast([[true, "yes two"], [false, "forbidden two"], [false, "short two"]]),
    cast([[false, "yes three"], [false, "forbidden three"], [false, "short three"]]),
  ];
  const verdicts = assembleVerdicts({ allChecks: checks, sent: checks, answer, casts, code: none });
  assert.deepEqual(verdicts.map((v) => [v.kind, v.pass, v.reason, v.votes]), [
    ["must", true, "yes one (2 of 3 votes)", [true, true, false]],
    ["must not", true, "forbidden two (2 of 3 votes)", [true, false, false]],
    ["judge", false, "short one", [false, false, false]],
  ]);
  // Two votes split on "say it": a tie is a no, and the reason is the first vote that agrees with the no.
  const tied = [cast([[true, "yes one"]]), cast([[false, "yes two"]])];
  const [split] = assembleVerdicts({ allChecks: checks.slice(0, 1), sent: checks.slice(0, 1), answer, casts: tied, code: none });
  assert.deepEqual([split.pass, split.reason, split.votes], [false, "yes two (1 of 2 votes)", [true, false]]);
});

/** A judge that answers each vote differently, by the vote number in its request: `verdictFor(k, line)` gives does. */
function voting(verdictFor) {
  const send = async (body) => {
    const k = Number(/vote (\d) of \d/.exec(body)[1]);
    const payload = payloadOf(body);
    const answers = payload.answers.map((answer) => ({
      id: answer.id,
      verdicts: payload.checks.map((c) => ({ line: c.line, does: verdictFor(k, c.line), reason: `${c.line}, vote ${k}` })),
    }));
    return json({ content: [{ type: "text", text: JSON.stringify({ answers }) }], usage: { input_tokens: 1000, output_tokens: 100 } });
  };
  send.route = "fake";
  return send;
}

test("the votes are decided by majority, each answer's verdicts show the count, and the section keeps the majority's reason", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    // Vote 3 says the must line fails; vote 2 alone says the must-not line's forbidden thing happened; the judge line is yes on vote 1 only.
    const verdictFor = (k, line) => (line.startsWith("say the dentist") ? k !== 3 : line === "invent a different day" ? k === 2 : line === "reply in one short text" ? k === 1 : true);
    const result = await judgeFile({ path, dir, send: voting(verdictFor), date: "2026-11-19" });
    assert.equal(result.votes, DEFAULT_VOTES);
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    const ids = assignIds(RESULT);
    const tuesday = ids.find((r) => r.setup === "zebra-setup" && r.run === 1).id;
    const rows = section.blocks.get(tuesday).verdicts;
    assert.deepEqual(rows.map((v) => [v.kind, v.pass, v.reason]), [
      ["must", true, "say the dentist visit is on Tuesday at 9am, vote 1 (2 of 3 votes)"],
      ["must not", true, "invent a different day, vote 1 (2 of 3 votes)"],
      ["judge", false, "reply in one short text, vote 2 (2 of 3 votes)"],
    ]);
  } finally {
    await cleanup();
  }
});

test("each question is asked once per vote, every body is different, and every body is at temperature 0 and numbered", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    const result = await judgeFile({ path, dir, send: rec.send, date: "2026-11-19", salt: "regrade 2" });
    assert.equal(rec.bodies.length, 2 * DEFAULT_VOTES, "two questions, three votes each");
    assert.equal(new Set(rec.bodies).size, rec.bodies.length, "no two bodies are the same");
    for (const body of rec.bodies) {
      assert.equal(JSON.parse(body).temperature, 0);
      assert.match(body, /Grading regrade 2, vote [1-3] of 3\./);
    }
    assert.equal(result.requests, 2 * DEFAULT_VOTES);
    assert.equal(DEFAULT_VOTES, 3);
  } finally {
    await cleanup();
  }
});

test("the estimate and the log count every vote, and a judging with one vote sends one call a question", async () => {
  const one = estimateJudging([{ inputTokens: 1000, outputTokens: 400 }], "claude-haiku-5-5");
  const three = estimateJudging([{ inputTokens: 1000, outputTokens: 400 }], "claude-haiku-5-5", 3);
  assert.equal(three.requests, 3);
  assert.equal(three.inputTokens, 3 * one.inputTokens);
  assert.equal(three.outputTokens, 3 * one.outputTokens);
  assert.ok(Math.abs(three.usd - 3 * one.usd) < 1e-12, `${three.usd} vs ${one.usd}`);
  assert.equal(estimateJudging([{ inputTokens: 1, outputTokens: 1 }], "mystery-judge", 3).usd, null);

  const { dir, path, cleanup } = await folder();
  try {
    const lines = [];
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-11-19", log: (line) => lines.push(line) });
    assert.match(lines[0], /^6 judge requests to claude-sonnet-5-5, about [\d,]+ tokens in, about \$\d+\.\d\d; 0 unanswered skipped$/);
  } finally {
    await cleanup();
  }
});

test("the Lab judge is always a Haiku model: any other model is refused", () => {
  assert.equal(labJudge("claude-haiku-5-5"), "claude-haiku-5-5");
  assert.equal(labJudge(), DEFAULT_JUDGE);
  assert.throws(() => labJudge("claude-sonnet-5-5"), /must be a Haiku model, got "claude-sonnet-5-5"/);
  assert.throws(() => labJudge(undefined === null ? "" : "gpt-5"), /Haiku/);
});
