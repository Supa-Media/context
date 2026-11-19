// Tests for bench/resultNote.mjs: reading a result note back, and writing and
// reading a judged section. All names and texts are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignIds, resultMarkdown } from "../report.mjs";
import { frontMatter, judgedSection, parseJudgedSections, parseResult, setFrontStatus } from "../resultNote.mjs";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

function answer({ setup, question = 1, questionText = "When is it?", as = "Maya", kind = "lookup", gate = false, run = 1, asked, said, model = "x", error = null, ms = 1200, changes = [] }) {
  return {
    setup, question, questionText, as, kind, gate, run,
    conversation: [{ from: "person", text: asked }, ...(said === null ? [] : [{ from: "assistant", text: said }])],
    tools: ["search_notes"],
    changes,
    ms, usage, model, texts: said === null ? 0 : 1, error,
  };
}

const RESULT = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-10-08",
  commit: "55db45c",
  setups: [
    { name: "zebra-setup", version: "aaaaaaaaaaaa", model: "claude-haiku-5-5" },
    { name: "lemur-setup", version: "bbbbbbbbbbbb", model: "x" },
  ],
  runs: [
    answer({ setup: "zebra-setup", asked: "when is it?", said: "# Not a heading\nIt is Tuesday.", model: "claude-haiku-5-5", changes: [{ workspace: "maya", path: "todo.md", kind: "proposed", detail: "add a reminder" }] }),
    answer({ setup: "lemur-setup", asked: "when is it?", said: null, error: "tool timeout", ms: 900 }),
  ],
};

test("parseResult reads every answer, its id and its question heading", () => {
  const { answers } = parseResult(resultMarkdown(RESULT));
  assert.equal(answers.length, 2);
  const ids = assignIds(RESULT).map((r) => r.id).sort();
  assert.deepEqual(answers.map((a) => a.id).sort(), ids);
  for (const a of answers) {
    assert.equal(a.question, 1);
    assert.equal(a.questionText, "When is it?");
    assert.equal(a.as, "Maya");
    assert.equal(a.kind, "lookup");
    assert.equal(a.gate, false);
  }
});

test("parseResult reads the conversation back, unescaping a heading-like line", () => {
  const { answers } = parseResult(resultMarkdown(RESULT));
  const zebra = answers.find((a) => a.conversation.length === 2 && a.conversation[1].text.includes("Tuesday"));
  assert.deepEqual(zebra.conversation, [
    { from: "person", text: "when is it?" },
    { from: "assistant", text: "# Not a heading\nIt is Tuesday." },
  ]);
});

test("parseResult reads the tools, the recorded changes and the time line", () => {
  const { answers } = parseResult(resultMarkdown(RESULT));
  const zebra = answers.find((a) => a.conversation.length === 2 && a.conversation[1].text.includes("Tuesday"));
  assert.equal(zebra.toolsLine, "Tools: search_notes");
  assert.deepEqual(zebra.tools, ["search_notes"]);
  assert.deepEqual(zebra.changes, ["- proposed maya/todo.md: add a reminder"]);
  // The haiku model is priced, so the time line carries a dollar amount, not "unknown".
  assert.equal(zebra.time.seconds, 1.2);
  assert.equal(typeof zebra.time.price, "number");
  assert.equal(zebra.time.texts, 1);
  assert.equal(zebra.error, null);
});

test("parseResult reads an errored answer as an error with no time", () => {
  const { answers } = parseResult(resultMarkdown(RESULT));
  const errored = answers.find((a) => a.error);
  assert.equal(errored.error, "tool timeout");
  assert.equal(errored.time, null);
  assert.deepEqual(errored.conversation, [{ from: "person", text: "when is it?" }]);
});

test("an unpriced model reads as a null price", () => {
  const { answers } = parseResult(resultMarkdown(RESULT));
  const lemur = answers.find((a) => a.error);
  assert.equal(lemur.time, null);
  const priced = parseResult(resultMarkdown({ ...RESULT, runs: [answer({ setup: "lemur-setup", asked: "q", said: "a", model: "vendor/unknown-1" })] })).answers[0];
  assert.equal(priced.time.price, null);
});

test("a judged section parses back into its verdicts, gate and model", () => {
  const raw = [
    "## Judged by claude-sonnet-5-5, 2026-10-09",
    "",
    "### amber-fox-quiet-lane",
    "",
    "| kind | line | verdict | reason |",
    "| --- | --- | --- | --- |",
    "| must | say a \\| day | pass | it says Tuesday |",
    "| must not | invent a date | fail | it invents Monday |",
    "",
    "gate: failed",
    "",
  ].join("\n");
  const [section] = parseJudgedSections(raw);
  assert.equal(section.model, "claude-sonnet-5-5");
  assert.equal(section.date, "2026-10-09");
  const block = section.blocks.get("amber-fox-quiet-lane");
  assert.equal(block.gate, "failed");
  assert.deepEqual(block.verdicts, [
    { kind: "must", line: "say a | day", pass: true, reason: "it says Tuesday" },
    { kind: "must not", line: "invent a date", pass: false, reason: "it invents Monday" },
  ]);
});

test("judgedSection writes what parseJudgedSections reads back", () => {
  const blocks = [
    { id: "amber-fox-quiet-lane", gate: null, verdicts: [{ kind: "judge", line: "keep it short | plain", pass: true, reason: "one line" }] },
    { id: "cedar-lamp-moss-fern", gate: "passed", verdicts: [] },
  ];
  const raw = judgedSection({ model: "claude-sonnet-5-5", date: "2026-10-09", blocks });
  const [section] = parseJudgedSections(raw);
  assert.deepEqual([...section.blocks.keys()], ["amber-fox-quiet-lane", "cedar-lamp-moss-fern"]);
  assert.deepEqual(section.blocks.get("amber-fox-quiet-lane").verdicts, [
    { kind: "judge", line: "keep it short | plain", pass: true, reason: "one line" },
  ]);
  assert.equal(section.blocks.get("cedar-lamp-moss-fern").gate, "passed");
});

test("parseJudgedSections ignores the placeholder and the result's own sections", () => {
  const md = resultMarkdown(RESULT);
  assert.deepEqual(parseJudgedSections(md), []);
});

test("setFrontStatus changes only the status line of the front matter", () => {
  const md = resultMarkdown(RESULT);
  const next = setFrontStatus(md, "judged");
  assert.equal(frontMatter(next).status, "judged");
  assert.equal(next.replace("status: judged", "status: not judged"), md);
});

test("frontMatter reads the result's keys, including the key file", () => {
  const front = frontMatter(resultMarkdown({ ...RESULT, keyFile: "2026-10-08 texting-assistant key.md" }));
  assert.equal(front.test, "texting-assistant");
  assert.equal(front.key, "2026-10-08 texting-assistant key.md");
});

test("a skipped answer in a judged section is written and read back", async () => {
  const { judgedSection, parseJudgedSections } = await import("../resultNote.mjs");
  const text = judgedSection({ model: "m", date: "2026-10-09", blocks: [{ id: "a-b-c-d", verdicts: [], gate: null, skipped: "no answer: model_unavailable" }] });
  assert.ok(text.includes("skipped: no answer: model_unavailable"));
  const [section] = parseJudgedSections(`${text}\n`);
  assert.equal(section.blocks.get("a-b-c-d").skipped, "no answer: model_unavailable");
});

test("a run's Gmail searches are written as a Mail line and read back, and the browser's line stays its own", () => {
  const run = { ...RESULT.runs[0], browser: ["open shop.example/form"], mail: ['mail search "serving sunday": 0 found', "mail read 19a3c0servingrq"] };
  const { answers } = parseResult(resultMarkdown({ ...RESULT, runs: [run] }));
  assert.deepEqual(answers[0].mail, ['mail search "serving sunday": 0 found', "mail read 19a3c0servingrq"]);
  assert.deepEqual(answers[0].browser, ["open shop.example/form"]);
});

test("the jobs an answer started are written as one line and read back for the start checks", () => {
  const jobs = [{ title: "Find flights", mail: "1-projects/lisbon/overview.md", name: "flights", on: null }, { title: "Find a flat", mail: "1-projects/lisbon/overview.md", name: "stay", on: null }];
  const result = { ...RESULT, runs: [{ ...RESULT.runs[0], jobs }, RESULT.runs[1]] };
  const { answers } = parseResult(resultMarkdown(result));
  const read = answers.map((a) => a.jobs);
  assert.deepEqual(read.find((list) => list.length > 0), jobs);
  assert.deepEqual(read.find((list) => list.length === 0), [], "an answer that started none reads none");
});

test("a run's steps line is written and read back, so a Lab row can say what its turn did (Lab, 2026-11-18)", () => {
  const steps = "tools search_mail ok | answer check: let go (only_acknowledged) | outcome: quiet (send say_nothing)";
  const result = { ...RESULT, runs: [{ ...RESULT.runs[0], said: null, steps }, RESULT.runs[1]] };
  const { answers } = parseResult(resultMarkdown(result));
  assert.deepEqual(answers.filter((a) => "steps" in a).map((a) => a.steps), [steps], "only the run with steps says so");
});

// Lab incident (Training, 2026-11-19): two check-in rows that called say_nothing were graded "Tex sent words". The
// silent flag was on the run in memory, but report.mjs wrote only the "(stayed quiet: …)" text and resultNote.mjs read
// back {from, text}, so the judge process saw the marker as words. The flag now rides in the note as a Silent: line.
test("a silent turn survives the note: the judge reads it as silent, not as words (Lab, 2026-11-19)", async () => {
  const { codeVerdict, wordsSent } = await import("../codeLines.mjs");
  const silentRun = {
    ...RESULT.runs[0],
    conversation: [
      { from: "person", text: "check in on the lease, please" },
      { from: "assistant", text: '(stayed quiet: send({"action":"say_nothing"}))', silent: true },
    ],
  };
  const md = resultMarkdown({ ...RESULT, runs: [silentRun] });
  assert.match(md, /^Silent: \[1\]$/m);
  const [parsed] = parseResult(md).answers;
  assert.equal(parsed.conversation[1].silent, true);
  assert.equal("silent" in parsed.conversation[0], false, "a spoken person turn carries no silent key");
  assert.equal(wordsSent(parsed), false);
  assert.equal(codeVerdict({ kind: "must", line: "stay quiet, nothing here needs them" }, parsed)?.does, true);

  // A spoken answer round-trips with no silent key, and its note has no Silent line.
  const spoken = resultMarkdown({ ...RESULT, runs: [RESULT.runs[0]] });
  assert.doesNotMatch(spoken, /^Silent: /m);
  const [back] = parseResult(spoken).answers;
  assert.equal(back.conversation.some((turn) => "silent" in turn), false);
  assert.equal(wordsSent(back), true);
});
