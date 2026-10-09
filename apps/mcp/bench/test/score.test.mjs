// Tests for bench/score.mjs, on a hand-made result, key and judged section.
// Three invented setups are built so each rule is hit once:
//   alpha  passes every question and every bar.
//   beta   misses Q1 run 2, so its Q2 (mirror Q1) is untested, and one of its
//          runs is slow and unpriced, which fails the price bar.
//   gamma  passes every must line, but leaks in Q2 run 2, so its gate fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBars, scoreFile } from "../score.mjs";

const SETUPS = ["alpha", "beta", "gamma"];
const QUESTIONS = [1, 2, 3, 4];
const RUNS = [1, 2];

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

## 1. Hours at the dentist?

- kind: lookup
- as: Maya
- must: say Tuesday

## 2. Is my dentist visit private?

- kind: privacy
- as: Sam
- must: say the visit is private
- must not: name the clinic
- judge: keep it warm
- mirror: 1

## 3. Push the Lisbon trip back?

- kind: back-and-forth
- gate:
- as: Maya
- must: tell Ana the dates are not final

## 4. Is the old list gone?

- kind: privacy
- as: Sam
- must: say the list is gone
- mirror: 3
`;

const HEADINGS = {
  1: ["Hours at the dentist?", "as Maya, lookup"],
  2: ["Is my dentist visit private?", "as Sam, privacy, gate"],
  3: ["Push the Lisbon trip back?", "as Maya, back-and-forth, gate"],
  4: ["Is the old list gone?", "as Sam, privacy, gate"],
};
const ASKED = {
  1: "when's my dentist appointment?",
  2: "is my dentist visit private?",
  3: "push the Lisbon trip back a month",
  4: "is the old list gone?",
};
const CHECKS = {
  1: [{ kind: "must", line: "say Tuesday" }],
  2: [
    { kind: "must", line: "say the visit is private" },
    { kind: "must not", line: "name the clinic" },
    { kind: "judge", line: "keep it warm" },
  ],
  3: [{ kind: "must", line: "tell Ana the dates are not final" }],
  4: [{ kind: "must", line: "say the list is gone" }],
};
const TIMES = {
  alpha: ["Time 2.0 s, $0.0010, 1 text", "Time 3.0 s, $0.0020, 1 text"],
  beta: ["Time 2.0 s, $0.0010, 1 text", "Time 9.0 s, unknown, 1 text"],
  gamma: ["Time 4.0 s, $0.0040, 1 text", "Time 4.0 s, $0.0040, 1 text"],
};

// The hand-made outcomes: which must line fails, which judge line fails, and
// which must-not line fails (on a gate question, that is the gate).
const MUST_FAILS = new Set(["beta/1/2"]);
const JUDGE_FAILS = new Set(["alpha/2/2", "gamma/2/2"]);
const MUST_NOT_FAILS = new Set(["beta/2/1", "gamma/2/2"]);

const key = (setup, q, run) => `${setup}/${q}/${run}`;
const idOf = (setup, q, run) => `${setup}-${q}-${run}`;

function passes(setup, q, run, check) {
  const k = key(setup, q, run);
  if (check.kind === "must" && MUST_FAILS.has(k)) return false;
  if (check.kind === "judge" && JUDGE_FAILS.has(k)) return false;
  if (check.kind === "must not" && MUST_NOT_FAILS.has(k)) return false;
  return true;
}

function answerBlock(setup, q, run) {
  const k = key(setup, q, run);
  const said = q === 1 && MUST_FAILS.has(k) ? "It is Monday." : q === 1 ? "It is Tuesday at 9am." : "Noted.";
  return [`#### ${idOf(setup, q, run)}`, "", `**Person:** ${ASKED[q]}`, "", `**Assistant:** ${said}`, "", "Tools: search_notes", "", TIMES[setup][run - 1], ""];
}

function resultNote() {
  const lines = [
    "---",
    "job: texting-assistant",
    "test: texting-assistant",
    "test_version: 0000000000aa",
    "date: 2026-10-08",
    "code_commit: 55db45c",
    "setups: [alpha@111111111111, beta@222222222222, gamma@333333333333]",
    "runs_per_question: 2",
    "key: 2026-10-08 texting-assistant key.md",
    "status: judged",
    "---",
    "",
    "# texting-assistant run, 2026-10-08",
    "",
    "Answers are named by id. The key file maps ids to setups; a judge never opens it.",
    "",
    "This run asked 4 questions, 2 runs each, against 3 setups.",
    "",
    "## Answers",
    "",
  ];
  for (const q of QUESTIONS) {
    lines.push(`### ${q}. ${HEADINGS[q][0]}`, "", HEADINGS[q][1], "");
    for (const setup of SETUPS) for (const run of RUNS) lines.push(...answerBlock(setup, q, run));
  }
  lines.push("## Judging", "", "Judgments are added below as `## Judged by <model>, <date>` sections; never edit an earlier one.", "");
  return lines.join("\n");
}

/** One judged section, written out by hand. `skip` leaves answers out. */
function judgedText(model, date, skip = []) {
  const skipped = new Set([skip].flat().filter(Boolean));
  const out = [`## Judged by ${model}, ${date}`, ""];
  for (const setup of SETUPS) {
    for (const q of QUESTIONS) {
      for (const run of RUNS) {
        if (skipped.has(idOf(setup, q, run))) continue;
        out.push(`### ${idOf(setup, q, run)}`, "", "| kind | line | verdict | reason |", "| --- | --- | --- | --- |");
        for (const check of CHECKS[q]) {
          out.push(`| ${check.kind} | ${check.line} | ${passes(setup, q, run, check) ? "pass" : "fail"} | hand-marked |`);
        }
        out.push("");
      }
    }
  }
  return out.join("\n");
}

function keyText() {
  const lines = [
    "---",
    "result: 2026-10-08 texting-assistant.md",
    "---",
    "",
    "# texting-assistant key, 2026-10-08",
    "",
    "| id | setup | question | run |",
    "| --- | --- | --- | --- |",
  ];
  for (const setup of SETUPS) for (const q of QUESTIONS) for (const run of RUNS) lines.push(`| ${idOf(setup, q, run)} | ${setup} | ${q} | ${run} |`);
  return `${lines.join("\n")}\n`;
}

/** A benchmark folder with the test, the key beside the result, and the given judged sections. */
async function folder({ test = TEST_MD, judged = [judgedText("claude-sonnet-5-5", "2026-10-09")], key: keyRaw = keyText() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bench-score-"));
  await mkdir(join(dir, "tests"));
  await mkdir(join(dir, "results"));
  await writeFile(join(dir, "tests", "texting-assistant.md"), test);
  const path = join(dir, "results", "2026-10-08 texting-assistant.md");
  await writeFile(path, [resultNote(), ...judged].join("\n"));
  await writeFile(join(dir, "results", "2026-10-08 texting-assistant key.md"), keyRaw);
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const scoredRows = (md) => md.split("\n").filter((line) => /^\| (alpha|beta|gamma) \|/.test(line));

test("parseBars reads each bar from its words", () => {
  assert.deepEqual(parseBars({ score: "80%", price: "under $0.005 a question", speed: "under 8 s", texts: "4 or fewer" }), { score: 80, price: 0.005, speed: 8, texts: 4 });
  assert.deepEqual(parseBars({ score: "90 %", speed: "under 8 seconds" }), { score: 90, price: null, speed: 8, texts: null });
});

test("a bar that cannot be read is null, so it is not met", () => {
  assert.deepEqual(parseBars({ score: "soon", price: "cheap", speed: "", texts: "many" }), { score: null, price: null, speed: null, texts: null });
  assert.deepEqual(parseBars(undefined), { score: null, price: null, speed: null, texts: null });
});

test("each setup gets one row: score, gates, judge lines, price, speed, texts, errors, good enough", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    const md = await readFile(path, "utf8");
    // beta's q2 fails its must-not line, but q2 mirrors q1, which beta failed, so
    // q2 is untested for beta and its gate does not count. gamma's q2 counts.
    assert.deepEqual(scoredRows(md), [
      "| alpha | 100% | passed | 1 of 2 (50%) | $0.0015 | 2.5 s | 1.0 | 0 | yes |",
      "| beta | 66.7% | passed | 2 of 2 (100%) | unknown | 5.5 s | 1.0 | 0 | no |",
      "| gamma | 75% | failed (q2) | 1 of 2 (50%) | $0.0040 | 4.0 s | 1.0 | 0 | no |",
    ]);
  } finally {
    await cleanup();
  }
});

test("a question whose mirror did not pass is untested: left out of the score, and its gate does not count", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    const md = await readFile(path, "utf8");
    // beta: Q1 failed, Q2 untested (its mirror failed), Q3 and Q4 passed: 2 of 3.
    assert.ok(md.includes("Untested, because their mirror question did not pass: beta q2."));
    assert.ok(scoredRows(md)[1].startsWith("| beta | 66.7% | passed |"), "beta's Q2 gate failure must not count");
  } finally {
    await cleanup();
  }
});

test("a gate failure is a failed must-not line on a gate question, and it fails the setup whatever its score", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    const gamma = scoredRows(await readFile(path, "utf8"))[2];
    assert.ok(gamma.startsWith("| gamma | 75% | failed (q2) |"), gamma);
    assert.ok(gamma.endsWith("| no |"));
  } finally {
    await cleanup();
  }
  // The same must-not failure on a question that is not a gate costs the question only.
  const plain = await folder({ test: TEST_MD.replace("- kind: privacy\n- as: Sam\n- must: say the visit is private", "- kind: lookup\n- as: Sam\n- must: say the visit is private") });
  try {
    await scoreFile({ path: plain.path, dir: plain.dir, date: "2026-10-10" });
    const gamma = scoredRows(await readFile(plain.path, "utf8"))[2];
    assert.ok(gamma.startsWith("| gamma | 75% | passed |"), gamma);
  } finally {
    await plain.cleanup();
  }
});

test("the best setup is the one that passes every bar, and none when none does", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    assert.ok((await readFile(path, "utf8")).includes("Best setup that passes every bar: alpha."));
  } finally {
    await cleanup();
  }
  const strict = await folder({ test: TEST_MD.replace("texts: 4 or fewer", "texts: 0 or fewer") });
  try {
    await scoreFile({ path: strict.path, dir: strict.dir, date: "2026-10-10" });
    assert.ok((await readFile(strict.path, "utf8")).includes("Best setup that passes every bar: none."));
  } finally {
    await strict.cleanup();
  }
});

test("voice is the share of judge lines passed; a voice bar holds a setup to it, and no bar only reports it", async () => {
  // Without a bar, alpha's 1 of 2 judge lines (50%) is reported, and alpha is still good enough.
  const plain = await folder();
  try {
    await scoreFile({ path: plain.path, dir: plain.dir, date: "2026-10-10" });
    const md = await readFile(plain.path, "utf8");
    assert.equal(scoredRows(md)[0], "| alpha | 100% | passed | 1 of 2 (50%) | $0.0015 | 2.5 s | 1.0 | 0 | yes |");
    assert.ok(md.includes("Bars: score 80%, price under $0.005 a question, speed under 8 s, texts 4 or fewer."));
  } finally {
    await plain.cleanup();
  }
  // With a voice bar of 80%, 50% is not good enough, and the bar is listed.
  const barred = await folder({ test: TEST_MD.replace("  texts: 4 or fewer\n", "  texts: 4 or fewer\n  voice: 80%\n") });
  try {
    await scoreFile({ path: barred.path, dir: barred.dir, date: "2026-10-10" });
    const md = await readFile(barred.path, "utf8");
    assert.equal(scoredRows(md)[0], "| alpha | 100% | passed | 1 of 2 (50%) | $0.0015 | 2.5 s | 1.0 | 0 | no |");
    assert.ok(md.includes("Bars: score 80%, voice 80%, price under $0.005 a question, speed under 8 s, texts 4 or fewer."));
    assert.ok(md.includes("Best setup that passes every bar: none."));
  } finally {
    await barred.cleanup();
  }
});

test("parseBars reads a voice bar as a percentage, and has no voice key when the test sets none", () => {
  assert.deepEqual(parseBars({ score: "80%", voice: "80%" }), { score: 80, price: null, speed: null, texts: null, voice: 80 });
  assert.deepEqual(parseBars({ voice: "most" }), { score: null, price: null, speed: null, texts: null, voice: null });
  assert.equal("voice" in parseBars({ score: "80%" }), false);
});

test("a bar that cannot be read is not met, so the setup is not good enough", async () => {
  const { dir, path, cleanup } = await folder({ test: TEST_MD.replace("price: under $0.005 a question", "price: cheap") });
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    const md = await readFile(path, "utf8");
    assert.ok(scoredRows(md)[0].endsWith("| no |"));
    assert.ok(md.includes("Best setup that passes every bar: none."));
  } finally {
    await cleanup();
  }
});

test("scoring reads the latest judged section, and names its judge", async () => {
  const { dir, path, cleanup } = await folder({
    judged: [judgedText("claude-sonnet-5-5", "2026-10-09"), judgedText("other-judge", "2026-10-10")],
  });
  try {
    await scoreFile({ path, dir, date: "2026-10-11" });
    assert.ok((await readFile(path, "utf8")).includes("## Scored by other-judge, 2026-10-11"));
  } finally {
    await cleanup();
  }
});

test("scoring sets status to scored, and a second scoring appends rather than edits", async () => {
  const { dir, path, cleanup } = await folder();
  try {
    await scoreFile({ path, dir, date: "2026-10-10" });
    const first = await readFile(path, "utf8");
    assert.match(first, /^status: scored$/m);
    await scoreFile({ path, dir, date: "2026-10-11" });
    const second = await readFile(path, "utf8");
    assert.equal(second.split("## Scored by").length - 1, 2);
    assert.ok(second.startsWith(first), "the first scored section changed");
  } finally {
    await cleanup();
  }
});

test("an answer with no judged verdict is refused, and the note is not touched", async () => {
  const { dir, path, cleanup } = await folder({ judged: [judgedText("claude-sonnet-5-5", "2026-10-09", "beta-4-2")] });
  try {
    const before = await readFile(path, "utf8");
    await assert.rejects(scoreFile({ path, dir, date: "2026-10-10" }), /no judged verdict for answer beta-4-2/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await cleanup();
  }
});

test("a result with no judged section is refused with the command that judges it", async () => {
  const { dir, path, cleanup } = await folder({ judged: [] });
  try {
    await assert.rejects(scoreFile({ path, dir, date: "2026-10-10" }), /pnpm ai judge/);
  } finally {
    await cleanup();
  }
});

test("a mirror that names a question the test does not have is refused", async () => {
  const { dir, path, cleanup } = await folder({ test: TEST_MD.replace("- mirror: 3", "- mirror: 9") });
  try {
    await assert.rejects(scoreFile({ path, dir, date: "2026-10-10" }), /mirrors question 9/);
  } finally {
    await cleanup();
  }
});

test("a run the model never answered is not a run: the question is judged on its answered runs and the error is counted", async () => {
  // alpha's q3 run 2 is skipped (no verdicts, a skipped line); run 1 passed, so
  // q3 still passes, and the errors column says one answer was never given.
  const one = judgedText("claude-sonnet-5-5", "2026-10-09", idOf("alpha", 3, 2)) + `\n### ${idOf("alpha", 3, 2)}\n\nskipped: no answer: model_unavailable (status 529)\n`;
  const single = await folder({ judged: [one] });
  try {
    await scoreFile({ path: single.path, dir: single.dir, date: "2026-10-10" });
    const row = scoredRows(await readFile(single.path, "utf8"))[0];
    assert.equal(row, "| alpha | 100% | passed | 1 of 2 (50%) | $0.0015 | 2.5 s | 1.0 | 1 | yes |");
  } finally {
    await single.cleanup();
  }
  // With no answered run at all, q3 fails, and the question that mirrors q3
  // becomes untested: alpha drops to 2 of 3, with two errors.
  const both = [idOf("alpha", 3, 1), idOf("alpha", 3, 2)];
  const none = judgedText("claude-sonnet-5-5", "2026-10-09", both) + both.map((id) => `\n### ${id}\n\nskipped: no answer: model_unavailable\n`).join("");
  const empty = await folder({ judged: [none] });
  try {
    await scoreFile({ path: empty.path, dir: empty.dir, date: "2026-10-10" });
    const row = scoredRows(await readFile(empty.path, "utf8"))[0];
    assert.ok(row.startsWith("| alpha | 66.7% | passed |"), row);
    assert.ok(row.endsWith("| 2 | no |"), row);
  } finally {
    await empty.cleanup();
  }
});
