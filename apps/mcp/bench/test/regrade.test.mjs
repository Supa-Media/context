// Tests for bench/regrade.mjs and the keep folder (coreArea.mjs keepJudged, setsFd.mjs units.json): a kept Front door
// case is judged again, each grading under its own salt, and a case whose grades differ is a flip. The judge is the
// fake one, scripted to disagree with itself under one salt only, so nothing leaves the test. All names are invented.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runTests } from "../coreArea.mjs";
import { fakeJudge, judgeFile } from "../judge.mjs";
import { flipReport, gradeString, keptFolders, regradeCommand, regradeKept } from "../regrade.mjs";
import { keyMarkdown, resultMarkdown } from "../report.mjs";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const TEST_MD = `---
job: texting-assistant
test: texting-assistant
judge: claude-haiku-5-5
runs: 1
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

## 2. Is my dentist visit private?

- kind: privacy
- as: Sam
- must: say the visit is private
- must not: reveal the clinic name
`;

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
// The Front door keeps its judged cases under the production setup, the one `coreCases` reads.
const SETUP = { name: "production", version: "aaaaaaaaaaaa", model: "anthropic/claude-haiku-5-5" };

function turn({ question, text, as, kind, run = 1, asked, said }) {
  return {
    setup: SETUP.name, question, questionText: text, as, kind, gate: false, run,
    conversation: [{ from: "person", text: asked }, { from: "assistant", text: said }],
    tools: ["search_notes"], changes: [], ms: 900, usage, model: "x", texts: 1, error: null,
  };
}

const RESULT = {
  job: "texting-assistant",
  test: "texting-assistant",
  testVersion: "a1b2c3d4e5f6",
  date: "2026-11-19",
  commit: "55db45c",
  setups: [SETUP],
  resultFile: "2026-11-19 texting-assistant.md",
  keyFile: "2026-11-19 texting-assistant key.md",
  runs: [
    turn({ question: 1, text: "When's my dentist appointment?", as: "Maya", kind: "lookup", asked: "when's my dentist appointment?", said: "The dentist visit is on Tuesday at 9am." }),
    turn({ question: 2, text: "Is my dentist visit private?", as: "Sam", kind: "privacy", asked: "is my dentist visit private?", said: "The visit is private, kept between us." }),
  ],
};

/**
 * A judge that grades as fakeJudge does, but reverses every verdict in the calls whose content names `salt`: a
 * grading that disagrees with itself under that salt and nowhere else.
 */
function flippingUnder(salt) {
  const base = fakeJudge();
  const send = async (body) => {
    const res = await base(body);
    if (!body.includes(`Grading ${salt},`)) return res;
    const reply = await res.json();
    const parsed = JSON.parse(reply.content[0].text);
    for (const answer of parsed.answers) for (const v of answer.verdicts) v.does = !v.does;
    reply.content[0].text = JSON.stringify(parsed);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  send.route = "fake";
  return send;
}

/** A kept folder the way `sets run --keep` leaves it: the judged result, its key and its test, and units.json. */
async function keptFixture() {
  const dir = await mkdtemp(join(tmpdir(), "regrade-kept-"));
  const work = await mkdtemp(join(tmpdir(), "regrade-work-"));
  await mkdir(join(work, "tests"));
  await mkdir(join(work, "results"));
  await writeFile(join(work, "tests", "texting-assistant.md"), TEST_MD);
  const path = join(work, "results", "2026-11-19 texting-assistant.md");
  await writeFile(path, resultMarkdown(RESULT));
  await writeFile(join(work, "results", "2026-11-19 texting-assistant key.md"), keyMarkdown(RESULT));
  await judgeFile({ path, dir: work, send: fakeJudge(), model: "fake-judge" });
  const folder = join(dir, "maya-sets-1");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "result.md"), await readFile(path, "utf8"));
  await writeFile(join(folder, "key.md"), await readFile(join(work, "results", "2026-11-19 texting-assistant key.md"), "utf8"));
  await writeFile(join(folder, "test.md"), TEST_MD);
  await writeFile(join(folder, "units.json"), JSON.stringify([{ chat: "maya-chat", msg: 3, node: "fd" }, { chat: "maya-chat", msg: 7, node: "fd" }]));
  return dir;
}

test("a flip report counts stable and flipped cases and names only the lines that flipped", () => {
  const rows = [
    { id: "a/q1", grades: [true, true, true], lines: [{ kind: "must", line: "say x", passes: [true, true, true] }] },
    { id: "a/q2", grades: [false, false, false], lines: [{ kind: "must", line: "say y", passes: [false, false, false] }] },
    {
      id: "a/q3", chat: "c", msg: 4, node: "fd", grades: [true, false, true],
      lines: [{ kind: "must", line: "say x", passes: [true, false, true] }, { kind: "must not", line: "say z", passes: [false, false, false] }],
    },
    { id: "a/q4", grades: [null, null], lines: [] },
  ];
  const report = flipReport(rows);
  assert.equal(report.stable_pass, 1);
  assert.equal(report.stable_fail, 1);
  assert.equal(report.flipped, 1);
  assert.equal(report.flipRate, 1 / 3, "the rate is over the cases graded at all, never the ungraded");
  assert.deepEqual(report.flippedRows, [{ id: "a/q3", chat: "c", msg: 4, node: "fd", grades: "PFP", lines: [{ kind: "must", line: "say x", passes: [true, false, true] }] }]);
  assert.equal(report.rows, rows, "every row comes back with the report");
});

test("a grade reads as P, F or - with the original first", () => {
  assert.equal(gradeString([true, null, false]), "P-F");
});

test("regrade takes the kept folders' cases, grades them again under their own salts, and reports the flip", async () => {
  const kept = await keptFixture();
  assert.deepEqual((await keptFolders(kept)).map((f) => f.name), ["maya-sets-1"]);
  const rows = await regradeKept({ kept, times: 3, votes: 1, send: flippingUnder("regrade 2") });
  assert.deepEqual(rows.map((r) => r.id), ["maya-sets-1/q1", "maya-sets-1/q2"]);
  assert.deepEqual(rows.map((r) => [r.chat, r.msg, r.node]), [["maya-chat", 3, "fd"], ["maya-chat", 7, "fd"]], "rows are named from units.json");
  for (const r of rows) {
    assert.equal(r.grades.length, 4, "the original and three regrades");
    assert.equal(r.grades[1], r.grades[0], "a regrade under another salt agrees");
    assert.equal(r.grades[2], !r.grades[0], "the regrade under the flipping salt disagrees");
    assert.equal(r.grades[3], r.grades[0]);
  }
  const report = flipReport(rows);
  assert.equal(report.flipped, 2);
  assert.equal(report.flippedRows.map((r) => r.grades).join(" "), rows.map((r) => gradeString(r.grades)).join(" "));
  assert.ok(report.flippedRows[0].lines.length > 0, "the lines that flipped are named in the report");
  assert.ok(report.flippedRows[0].lines.every((l) => l.passes.includes(true) && l.passes.includes(false)));
});

test("a judge that agrees with itself flips nothing", async () => {
  const kept = await keptFixture();
  const report = flipReport(await regradeKept({ kept, times: 2, votes: 1, send: fakeJudge() }));
  assert.equal(report.flipped, 0);
  assert.equal(report.stable_pass + report.stable_fail, 2);
  assert.equal(report.flipRate, 0);
});

test("the regrade command refuses a missing folder and a vote count outside 1 to 9", async () => {
  await assert.rejects(regradeCommand({}, { write: () => {} }), /usage: sets regrade/);
  await assert.rejects(regradeCommand({ kept: "/nonexistent", fake: true, votes: "0" }, { write: () => {} }), /--votes must be a whole number from 1 to 9/);
  await assert.rejects(regradeCommand({ kept: "/nonexistent", fake: true, times: "2.5" }, { write: () => {} }), /--times must be a whole number/);
});

test("the regrade command prints counts and ids, never a message's words", async () => {
  const kept = await keptFixture();
  const out = [];
  const report = await regradeCommand({ kept, fake: true, times: "3", votes: "1" }, { write: (t) => out.push(t) });
  assert.equal(report.rows.length, 2);
  assert.match(out[0], /^regrade: 2 rows, \d+ stable pass, \d+ stable fail, \d+ flip \(\d+%\)\n$/);
  const text = out.join("");
  assert.doesNotMatch(text, /dentist|Tuesday|private/i, "no words of the chat on standard output");
});

test("a kept run's notes land in one folder per test, with the test's own name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regrade-keep-"));
  const scratch = await mkdtemp(join(tmpdir(), "regrade-scratch-"));
  const bench = join(dir, "ai");
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "tests/core.md": [
      "---", "run_as: Ana", "runs: 1", "good_enough:", "  score: 100%", "  price: under $1 a question", "  speed: under 90 s", "  texts: 4 or fewer", "---", "",
      "## 1. Remind me about the dentist", "", "- kind: task", '- person starts: "remind me about the dentist"', "- must: report the matches it found", "",
    ].join("\n"),
    "setups/texting-assistant/production.md": "---\njob: texting-assistant\n---\n\nYou are a test assistant.\n",
    "setups/texting-assistant/experiment.md": "---\njob: texting-assistant\n---\n\nYou are a test assistant.\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(bench, rel, ".."), { recursive: true });
    await writeFile(join(bench, rel), text);
  }
  const keep = join(dir, "kept");
  const got = await runTests(TREE, ["core"], { dir: bench, fake: true, scratch, tag: "keep", keep, keepPrefix: "ana-" });
  assert.equal(got.rows.length, 1);
  const folder = join(keep, "ana-core");
  assert.deepEqual((await readdir(folder)).sort(), ["key.md", "result.md", "test.md"]);
  assert.match(await readFile(join(folder, "result.md"), "utf8"), /## Judged by/, "the kept result is the judged one");
});
