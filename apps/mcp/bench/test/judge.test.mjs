// Tests for bench/judge.mjs: a judge sees one answer at a time and nothing that
// says which setup wrote it. The transport is a recording fake, so no key is
// needed and no request leaves the test. All names and texts are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_JUDGE, JUDGE_ATTEMPTS, JUDGE_SCHEMA, estimateJudging, fakeJudge, judgeFile, sidecarPath } from "../judge.mjs";
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

test("the judge is sent one request per question, carrying every answer to it, and none names a setup, the key or the summary", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    assert.equal(rec.bodies.length, 2, "two questions, two requests");
    const perQuestion = rec.bodies.map(payloadOf).map((p) => p.answers.length).sort();
    assert.deepEqual(perQuestion, [1, 3]);
    for (const body of rec.bodies) {
      for (const setup of SETUPS) assert.ok(!body.includes(setup.name), `${setup.name} is in the request`);
      assert.ok(!body.includes("key.md"), "the key file is named in the request");
      assert.ok(!body.includes("| id |"), "the key table is in the request");
      assert.ok(!body.includes("## Summary"), "the summary is in the request");
      assert.ok(!/Time \d/.test(body), "a time line is in the request");
      assert.ok(!body.includes("$0."), "a price is in the request");
    }
  } finally {
    await cleanup();
  }
});

test("a request carries the question, who asked it, its checks, and each answer's conversation, tools and changes", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    const dentist = rec.bodies.map(payloadOf).find((p) => p.question === "When's my dentist appointment?");
    assert.equal(dentist.asked_by, "Maya");
    assert.equal(dentist.gate, false);
    assert.deepEqual(dentist.checks, [
      { kind: "must", line: "say the dentist visit is on Tuesday at 9am" },
      { kind: "must not", line: "invent a different day" },
      { kind: "judge", line: "reply in one short text" },
    ]);
    const tuesday = dentist.answers.find((a) => a.conversation[1].text === "It is on Tuesday at 9am.");
    assert.deepEqual(tuesday.conversation, [
      { from: "person", text: "when's my dentist appointment?" },
      { from: "assistant", text: "It is on Tuesday at 9am." },
    ]);
    assert.equal(tuesday.tools, "Tools: search_notes");
    assert.deepEqual(tuesday.changes, []);
    assert.match(tuesday.id, /^[a-z]+(-[a-z]+){3}$/, "an answer is named by its id");
  } finally {
    await cleanup();
  }
});

test("a gate question is marked as one, and its may lines reach the judge as information", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    const privacy = rec.bodies.map(payloadOf).find((p) => p.question === "Is my dentist visit private?");
    assert.equal(privacy.gate, true);
    assert.deepEqual(privacy.may, ["the reply may mention the dentist"]);
    assert.deepEqual(privacy.answers[0].changes, ["- written sam/todo.md: x"]);
  } finally {
    await cleanup();
  }
});

test("the judge never needs the key: judging works with the key file removed", async () => {
  const { dir, path, keyPath, cleanup } = await folder();
  try {
    await rm(keyPath);
    await judgeFile({ path, dir, send: fakeJudge(), date: "2026-10-09" });
    assert.equal(parseJudgedSections(await readFile(path, "utf8")).length, 1);
  } finally {
    await cleanup();
  }
});

test("the judge says whether the answer does what a line says, and a must-not line passes when it does not", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const did = (answer, payload) => ({ id: answer.id, verdicts: payload.checks.map((c) => ({ line: c.line, does: true, reason: "it did" })) });
    const rec = recording(judging(did));
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    assert.match(JSON.parse(rec.bodies[0]).system, /does: true means the answer did the thing the line forbids/);
    // Round eight (2026-10-10): "write nothing into any other note" was read as "did it write?" and a
    // thanks reply of "Anytime." was read as not saying the time the first reply had said.
    assert.match(JSON.parse(rec.bodies[0]).system, /something to leave undone/);
    assert.match(JSON.parse(rec.bodies[0]).system, /about the whole conversation/);
    assert.equal(JSON.parse(rec.bodies[0]).output_config.format.schema.properties.answers.items.properties.verdicts.items.required.includes("does"), true);
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    for (const block of section.blocks.values()) {
      for (const v of block.verdicts) assert.equal(v.pass, v.kind !== "must not", `${v.kind}: ${v.line}`);
    }
  } finally {
    await cleanup();
  }
});

test("the judged section parses back: a passing answer passes, a wrong one fails", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await judgeFile({ path, dir, send: fakeJudge(), date: "2026-10-09" });
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    assert.equal(section.model, "claude-sonnet-5-5");
    assert.equal(section.date, "2026-10-09");
    const ids = assignIds(RESULT);
    const tuesday = ids.find((r) => r.setup === "zebra-setup" && r.run === 1).id;
    const monday = ids.find((r) => r.setup === "zebra-setup" && r.run === 2).id;
    const verdictsOf = (id) => section.blocks.get(id).verdicts;
    // The scripted judge finds a line's long words in the answer: neither answer
    // "invent"s a "different" day, so the must-not line passes for both.
    assert.deepEqual(verdictsOf(tuesday).map((v) => [v.kind, v.pass]), [["must", true], ["must not", true], ["judge", false]]);
    assert.deepEqual(verdictsOf(monday).map((v) => [v.kind, v.pass]), [["must", false], ["must not", true], ["judge", false]]);
    assert.equal(verdictsOf(monday)[0].line, "say the dentist visit is on Tuesday at 9am");
    assert.ok(verdictsOf(monday)[0].reason.length > 0);
    // The gate is derived from the must-not lines in the score, never written here.
    assert.equal(section.blocks.get(tuesday).gate, null);
    const privacy = ids.find((r) => r.setup === "lemur-setup" && r.question === 2).id;
    assert.equal(section.blocks.get(privacy).gate, null);
    assert.match(await readFile(path, "utf8"), /^status: judged$/m);
  } finally {
    await cleanup();
  }
});

test("the judge is not asked for a gate opinion: one it volunteers is ignored, and no gate line is written", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(judging((answer, payload) => ({ ...allPass(answer, payload), gate_failed: payload.gate })));
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    assert.ok(!JSON.parse(rec.bodies[0]).system.includes("gate_failed"), "the instructions never mention a gate verdict");
    const raw = await readFile(path, "utf8");
    assert.ok(!/^gate: /m.test(raw), "no gate line in the judged section");
    const [section] = parseJudgedSections(raw);
    for (const block of section.blocks.values()) assert.equal(block.gate, null);
  } finally {
    await cleanup();
  }
});

test("a second judging appends another section and leaves the first as it was", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await judgeFile({ path, dir, send: fakeJudge(), date: "2026-10-09" });
    const first = await readFile(path, "utf8");
    const firstSection = first.slice(first.indexOf("## Judged by"));
    await judgeFile({ path, dir, send: fakeJudge(), model: "other-judge", date: "2026-10-10" });
    const second = await readFile(path, "utf8");
    assert.ok(second.includes(firstSection), "the first judged section changed");
    const sections = parseJudgedSections(second);
    assert.deepEqual(sections.map((s) => [s.model, s.date]), [["claude-sonnet-5-5", "2026-10-09"], ["other-judge", "2026-10-10"]]);
    assert.match(second, /^status: judged$/m);
  } finally {
    await cleanup();
  }
});

test("a reply with the wrong number of verdicts is refused, and the note is not touched", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const before = await readFile(path, "utf8");
    const short = judging((answer) => ({ id: answer.id, verdicts: [], gate_failed: false }));
    await assert.rejects(judgeFile({ path, dir, send: short, date: "2026-10-09" }), /verdicts/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await cleanup();
  }
});

test("a call that fails is refused with its status, and the note is not touched", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const before = await readFile(path, "utf8");
    const refused = async () => json({ error: { message: "set AI_GATEWAY_ACCOUNT_ID" } }, 401);
    refused.route = "fake";
    await assert.rejects(judgeFile({ path, dir, send: refused, date: "2026-10-09" }), /status 401.*AI_GATEWAY_ACCOUNT_ID/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await cleanup();
  }
});

// ---- what the first judging got wrong ----

const UNANSWERED = {
  ...RESULT,
  runs: [
    ...RESULT.runs,
    { ...turn({ setup: "lemur-setup", question: 1, text: "When's my dentist appointment?", as: "Maya", kind: "lookup", run: 2, asked: "when's my dentist appointment?", said: "" }), conversation: [{ from: "person", text: "when's my dentist appointment?" }], tools: [], error: "model_unavailable" },
  ],
};

test("an answer the model never gave is skipped, never sent to the judge, and fails in the score", async () => {
  const { dir, path, cleanup } = await folder(UNANSWERED);
  try {
    const rec = recording(fakeJudge());
    const result = await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    assert.equal(result.skipped, 1);
    assert.equal(result.judged, 4);
    const sent = rec.bodies.flatMap((body) => payloadOf(body).answers.map((a) => a.id));
    const errored = assignIds(UNANSWERED).find((r) => r.setup === "lemur-setup" && r.question === 1 && r.run === 2).id;
    assert.ok(!sent.includes(errored), "the errored answer was sent");
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    assert.equal(section.blocks.get(errored).skipped, "no answer: model_unavailable");
    assert.deepEqual(section.blocks.get(errored).verdicts, []);
  } finally {
    await cleanup();
  }
});

test("the estimate is printed first, and a judging over --max-usd is refused before any call", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const lines = [];
    const rec = recording(judging(allPass));
    rec.send.route = "gateway";
    await assert.rejects(
      judgeFile({ path, dir, send: rec.send, model: "claude-fable-5-1", maxUsd: 0.001, log: (line) => lines.push(line) }),
      /over the --max-usd 0\.00 cap/,
    );
    assert.equal(rec.bodies.length, 0, "no call was made");
    assert.match(lines[0], /^2 judge requests to claude-fable-5-1, about [\d,]+ tokens in, about \$\d+\.\d\d; 0 unanswered skipped$/);
    // A model with no known price needs an explicit cap.
    await assert.rejects(judgeFile({ path, dir, send: rec.send, model: "mystery-judge" }), /no price is known for mystery-judge/);
    assert.equal(rec.bodies.length, 0);
  } finally {
    await cleanup();
  }
});

test("estimateJudging prices a judging from its requests, and the fake judge is never capped", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const estimate = estimateJudging([{ inputTokens: 1_000_000, outputTokens: 400_000 }], "claude-haiku-5-5");
    // 1M in at $0.10 plus a quarter of 400k out at $0.50.
    assert.equal(estimate.usd, 0.15);
    assert.equal(estimateJudging([], "claude-haiku-5-5").usd, 0);
    assert.equal(estimateJudging([{ inputTokens: 1, outputTokens: 1 }], "mystery-judge").usd, null);
    const result = await judgeFile({ path, dir, send: fakeJudge(), maxUsd: 0 });
    assert.equal(result.requests, 2);
  } finally {
    await cleanup();
  }
});

test("a stopped judging resumes from its sidecar without re-sending judged questions, and the sidecar is removed at the end", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const first = recording(judging(allPass));
    let calls = 0;
    const stopAfterOne = async (body) => {
      calls += 1;
      if (calls > 1) throw new Error("stopped");
      return first.send(body);
    };
    stopAfterOne.route = "fake";
    await assert.rejects(judgeFile({ path, dir, send: stopAfterOne, concurrency: 1, date: "2026-10-09" }), /stopped/);
    await stat(sidecarPath(path));
    const second = recording(judging(allPass));
    const result = await judgeFile({ path, dir, send: second.send, concurrency: 1, date: "2026-10-09" });
    assert.equal(second.bodies.length, 1, "only the unjudged question was sent");
    assert.equal(result.judged, 4);
    await assert.rejects(stat(sidecarPath(path)), /ENOENT/);
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    assert.equal(section.blocks.size, 4);
  } finally {
    await cleanup();
  }
});

test("progress and spend are reported per question, and the default judge is Haiku", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const lines = [];
    await writeFile(join(dir, "tests", "texting-assistant.md"), TEST_MD.replace("judge: claude-sonnet-5-5\n", ""));
    const result = await judgeFile({ path, dir, send: judging(allPass), date: "2026-10-09", log: (line) => lines.push(line) });
    assert.equal(result.model, DEFAULT_JUDGE);
    assert.equal(DEFAULT_JUDGE, "claude-haiku-5-5");
    assert.ok(lines.some((line) => /^q1: 3 answers judged in \d+\.\d s \(\d\/2, spent \$\d+\.\d\d\)$/.test(line)), lines.join("\n"));
    assert.ok(result.spent.input > 0 && result.spent.usd > 0);
  } finally {
    await cleanup();
  }
});

test("the test's every_answer lines reach the judge as trailing judge lines on every question", async () => {
  const withVoice = TEST_MD.replace("runs: 2\n", "runs: 2\nevery_answer:\n  friend: read like a text from a friend\n  one: end on one next step or one question\n");
  const { dir, path, cleanup } = await folder(RESULT, { test: withVoice });
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    const payloads = rec.bodies.map(payloadOf);
    const dentist = payloads.find((p) => p.question === "When's my dentist appointment?");
    assert.deepEqual(dentist.checks.slice(-2), [
      { kind: "judge", line: "read like a text from a friend" },
      { kind: "judge", line: "end on one next step or one question" },
    ]);
    const privacy = payloads.find((p) => p.question === "Is my dentist visit private?");
    assert.deepEqual(privacy.checks.slice(-2).map((c) => c.line), ["read like a text from a friend", "end on one next step or one question"]);
    assert.equal(privacy.checks.filter((c) => c.kind === "judge").length, 2, "a question with no judge lines of its own still gets the voice lines");
    const judged = parseJudgedSections(await readFile(path, "utf8"));
    for (const block of judged[0].blocks.values()) {
      assert.equal(block.verdicts.filter((v) => v.kind === "judge" && v.line === "read like a text from a friend").length, 1, "every answer gets a verdict under the voice line");
    }
  } finally {
    await cleanup();
  }
});

test("a reply that is not JSON is asked for again, and given up on after three tries", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const good = judging(allPass);
    let calls = 0;
    const flaky = async (body) => {
      calls += 1;
      if (calls === 1) return json({ content: [{ type: "text", text: "Here are the verdicts: {\"answers\": [" }], stop_reason: "max_tokens", usage: {} });
      return good(body);
    };
    flaky.route = "fake";
    const result = await judgeFile({ path, dir, send: flaky, concurrency: 1, date: "2026-10-09" });
    assert.equal(result.judged, 4, "every answer judged");
    assert.equal(calls, 3, "two questions, one of them asked twice");

    const { dir: dir2, path: path2, cleanup: cleanup2 } = await folder();
    try {
      let tries = 0;
      const broken = async () => {
        tries += 1;
        return json({ content: [{ type: "text", text: "no verdicts today" }], usage: {} });
      };
      broken.route = "fake";
      await assert.rejects(judgeFile({ path: path2, dir: dir2, send: broken, concurrency: 1 }), /is not JSON \(3 attempts\)/);
      assert.equal(tries, JUDGE_ATTEMPTS, "three tries, then the error");
    } finally {
      await cleanup2();
    }
  } finally {
    await cleanup();
  }
});

test("the judge's reply is held to a JSON schema by the API, and every object in it closes additionalProperties", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(judging(allPass));
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    const body = JSON.parse(rec.bodies[0]);
    assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: JUDGE_SCHEMA } });
    const objects = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "object") objects.push(node);
      for (const value of Object.values(node)) walk(value);
    };
    walk(JUDGE_SCHEMA);
    assert.ok(objects.length >= 3, "the reply, an answer, a verdict");
    for (const node of objects) {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(Object.keys(node.properties).sort(), [...node.required].sort(), "every property is required");
    }
  } finally {
    await cleanup();
  }
});
