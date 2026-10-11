/**
 * `pnpm ai calibrate`: a decision model against the judge of record. The
 * state it reads is what the judge saw for one answer; one yes-or-no per
 * check in the judge's order; agreement counted per verdict.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agreementMarkdown,
  calibrateFile,
  fakeDecide,
  questionsFor,
  stateFor,
} from "../calibrate.mjs";
import { keyMarkdown, resultMarkdown } from "../report.mjs";
import {
  judgedSection,
  parseJudgedSections,
  parseResult,
} from "../resultNote.mjs";

const run = (setup, id, run, said) => ({
  setup,
  question: 1,
  questionText: "When's my dentist appointment?",
  as: "Maya",
  kind: "lookup",
  gate: false,
  run,
  id,
  model: "anthropic/claude-haiku-5-5",
  ms: 1000,
  usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
  tools: ["read_note"],
  conversation: [
    { from: "person", text: "when's my dentist appointment?" },
    { from: "assistant", text: said },
  ],
  changes: [],
  texts: 1,
  error: null,
});

const RESULT = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-10-10",
  today: "2026-10-08",
  commit: "abc1234",
  setups: [
    { name: "a", version: "111111111111", model: "anthropic/claude-haiku-5-5" },
  ],
  resultFile: "r.md",
  keyFile: "r key.md",
  runs: [
    run("a", "acorn-boot-linen-lagoon", 1, "Tuesday at 9am."),
    run(
      "a",
      "zinc-curve-belt-circle",
      2,
      "I searched everywhere and found nothing.",
    ),
  ],
};

const CHECKS = [
  { kind: "must", line: "say Tuesday at 9am" },
  { kind: "must not", line: "invent a date" },
  { kind: "judge", line: "never mentions searching" },
];

async function judgedFixture() {
  const dir = await mkdtemp(join(tmpdir(), "bench-calibrate-"));
  const path = join(dir, "r.md");
  // The result names answers by ids of its own; the judged section uses those.
  const md = resultMarkdown(RESULT);
  const answers = parseResult(md).answers;
  const idOf = (said) =>
    answers.find((answer) => answer.conversation.at(-1).text === said).id;
  const first = idOf("Tuesday at 9am.");
  const second = idOf("I searched everywhere and found nothing.");
  const blocks = [
    {
      id: first,
      verdicts: CHECKS.map((c) => ({ ...c, pass: true, reason: "fine" })),
      gate: null,
    },
    {
      id: second,
      verdicts: CHECKS.map((c, i) => ({ ...c, pass: i === 1, reason: "no" })),
      gate: null,
    },
  ];
  await writeFile(
    path,
    `${md}\n${judgedSection({ model: "claude-haiku-5-5", date: "2026-10-10", blocks })}`,
  );
  await writeFile(join(dir, "r key.md"), keyMarkdown(RESULT));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the state is what the judge saw for one answer, and the questions are one yes-or-no per check in order", () => {
  const answer = {
    questionText: "When's my dentist appointment?",
    as: "Maya",
    conversation: RESULT.runs[0].conversation,
    toolsLine: "read_note",
    changes: [],
  };
  const state = stateFor(answer);
  assert.match(
    state,
    /Person: when's my dentist appointment\?\nAssistant: Tuesday at 9am\./,
  );
  assert.match(state, /Tools the assistant used: read_note/);
  assert.doesNotMatch(state, /setup/, "never a setup name");
  const questions = questionsFor(CHECKS);
  assert.deepEqual(Object.keys(questions), ["c0", "c1", "c2"]);
  assert.equal(questions.c0.type, "noul");
  assert.match(questions.c0.instructions, /do this: say Tuesday at 9am/);
  assert.match(questions.c1.instructions, /avoid this: invent a date/);
  assert.match(
    questions.c2.instructions,
    /true of the assistant's answer: never mentions searching/,
  );
});

test("agreement is counted per verdict against the latest judging, by kind, and the note is not touched", async () => {
  const { path, cleanup } = await judgedFixture();
  try {
    const before = (await import("node:fs/promises")).readFile(path, "utf8");
    // Agrees with the judge on everything but the second answer's must-not.
    const decide = async (state, questions) =>
      Object.fromEntries(
        Object.keys(questions).map((key) => [
          key,
          {
            noul: /Tuesday at 9am\./.test(state)
              ? 0.9
              : key === "c1"
                ? 0.2
                : 0.1,
          },
        ]),
      );
    const result = await calibrateFile({
      path,
      decide,
      model: "@cf/cloudflare/clef",
      concurrency: 2,
    });
    assert.equal(result.calls, 2);
    assert.equal(result.rows.length, 6);
    assert.equal(result.rows.filter((row) => row.agree).length, 5);
    assert.equal(result.judge, "claude-haiku-5-5");
    assert.ok(result.tokens > 0);
    const md = agreementMarkdown(result);
    assert.match(
      md,
      /## Calibration: @cf\/cloudflare\/clef against claude-haiku-5-5/,
    );
    assert.match(md, /\| all \| 6 \| 83\.3% \|/);
    assert.match(md, /\| must not \| 2 \| 50\.0% \|/);
    assert.match(md, /about \$0\.00/, "priced from Clef's rate");
    assert.equal(
      await before,
      await (await import("node:fs/promises")).readFile(path, "utf8"),
      "nothing written to the result",
    );
    assert.equal(
      parseJudgedSections(
        await (await import("node:fs/promises")).readFile(path, "utf8"),
      ).length,
      1,
    );
  } finally {
    await cleanup();
  }
});

test("a decision that fails is counted, not thrown, and the scripted model runs the plumbing", async () => {
  const { path, cleanup } = await judgedFixture();
  try {
    let calls = 0;
    const flaky = async (state, questions) =>
      calls++ === 0 ? null : fakeDecide()(state, questions);
    const result = await calibrateFile({
      path,
      decide: flaky,
      model: "fake-decision",
      concurrency: 1,
    });
    assert.equal(result.failed, 1);
    assert.equal(result.rows.length, 3);
    assert.match(agreementMarkdown(result), /2 decision calls, 1 failed/);
  } finally {
    await cleanup();
  }
});
