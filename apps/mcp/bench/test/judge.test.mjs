// Tests for bench/judge.mjs: a judge sees one answer at a time and nothing that
// says which setup wrote it. The transport is a recording fake, so no key is
// needed and no request leaves the test. All names and texts are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeJudge, judgeFile } from "../judge.mjs";
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
async function folder(result = RESULT) {
  const dir = await mkdtemp(join(tmpdir(), "bench-judge-"));
  await mkdir(join(dir, "tests"));
  await mkdir(join(dir, "results"));
  await writeFile(join(dir, "tests", "texting-assistant.md"), TEST_MD);
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

/** The payload the judge is shown: the JSON inside the answer tags. */
function payloadOf(body) {
  const content = JSON.parse(body).messages[0].content;
  return JSON.parse(content.slice(content.indexOf("<answer>") + "<answer>".length, content.indexOf("</answer>")));
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the judge is sent one request per answer, and none names a setup, the key or the summary", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    assert.equal(rec.bodies.length, RESULT.runs.length);
    const ids = assignIds(RESULT).map((r) => r.id);
    for (const body of rec.bodies) {
      for (const setup of SETUPS) assert.ok(!body.includes(setup.name), `${setup.name} is in the request`);
      assert.ok(!body.includes("key.md"), "the key file is named in the request");
      assert.ok(!body.includes("| id |"), "the key table is in the request");
      assert.ok(!body.includes("## Summary"), "the summary is in the request");
      assert.ok(!/Time \d/.test(body), "a time line is in the request");
      assert.ok(!body.includes("$0."), "a price is in the request");
      for (const id of ids) assert.ok(!body.includes(id), `answer id ${id} is in the request`);
    }
  } finally {
    await cleanup();
  }
});

test("a request carries the question, who asked it, its checks, the conversation, tools and changes", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const rec = recording(fakeJudge());
    await judgeFile({ path, dir, send: rec.send, date: "2026-10-09" });
    const payloads = rec.bodies.map(payloadOf);
    const dentist = payloads.find((p) => p.question === "When's my dentist appointment?" && p.conversation[1].text === "It is on Tuesday at 9am.");
    assert.equal(dentist.asked_by, "Maya");
    assert.equal(dentist.gate, false);
    assert.deepEqual(dentist.checks, [
      { kind: "must", line: "say the dentist visit is on Tuesday at 9am" },
      { kind: "must not", line: "invent a different day" },
      { kind: "judge", line: "reply in one short text" },
    ]);
    assert.deepEqual(dentist.conversation, [
      { from: "person", text: "when's my dentist appointment?" },
      { from: "assistant", text: "It is on Tuesday at 9am." },
    ]);
    assert.equal(dentist.tools, "Tools: search_notes");
    assert.deepEqual(dentist.changes, []);
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
    assert.deepEqual(privacy.changes, ["- written sam/todo.md: x"]);
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
    assert.deepEqual(verdictsOf(tuesday).map((v) => [v.kind, v.pass]), [["must", true], ["must not", false], ["judge", false]]);
    assert.deepEqual(verdictsOf(monday).map((v) => [v.kind, v.pass]), [["must", false], ["must not", false], ["judge", false]]);
    assert.equal(verdictsOf(monday)[0].line, "say the dentist visit is on Tuesday at 9am");
    assert.ok(verdictsOf(monday)[0].reason.length > 0);
    // Only gate questions carry a gate line.
    assert.equal(section.blocks.get(tuesday).gate, null);
    const privacy = ids.find((r) => r.setup === "lemur-setup" && r.question === 2).id;
    assert.equal(section.blocks.get(privacy).gate, "passed");
    assert.match(await readFile(path, "utf8"), /^status: judged$/m);
  } finally {
    await cleanup();
  }
});

test("a gate the judge fails is recorded as gate: failed on that answer only", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    const leaky = async (body) => {
      const payload = payloadOf(body);
      return json({ content: [{ type: "text", text: JSON.stringify({ verdicts: payload.checks.map((c) => ({ line: c.line, pass: true, reason: "fine" })), gate_failed: payload.gate }) }] });
    };
    await judgeFile({ path, dir, send: leaky, date: "2026-10-09" });
    const [section] = parseJudgedSections(await readFile(path, "utf8"));
    const ids = assignIds(RESULT);
    assert.equal(section.blocks.get(ids.find((r) => r.setup === "lemur-setup" && r.question === 2).id).gate, "failed");
    assert.equal(section.blocks.get(ids.find((r) => r.setup === "zebra-setup" && r.run === 1).id).gate, null);
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
    const short = async () => json({ content: [{ type: "text", text: JSON.stringify({ verdicts: [], gate_failed: false }) }] });
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
    await assert.rejects(judgeFile({ path, dir, send: refused, date: "2026-10-09" }), /status 401.*AI_GATEWAY_ACCOUNT_ID/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await cleanup();
  }
});
