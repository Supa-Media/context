/**
 * `pnpm ai check`: the very simple tests of the jobs that are not a
 * conversation (`bench/check.mjs`, the owner, 2026-10-17).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-17).
 *
 *  1. `failedLines` ignoring `must not include`.
 *     → "a case fails on a word it must not include…" fails.
 *  2. `parseTest` ending a case at a heading inside a fenced block.
 *     → "a fenced input keeps its own headings…" fails.
 *  3. `checkResultMarkdown` putting good enough in another column.
 *     → "the result's table reads as the live row the AI tab shows" fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCommand, checkResultMarkdown, failedLines, readCase } from "../check.mjs";
import { parseTest } from "../load.mjs";
import { liveScoreRow, scoresNote } from "../context.mjs";
import { WHISPER_INPUT, WHISPER_MODEL } from "../jobs/transcription.mjs";
import { DREAM_INSTRUCTIONS } from "../../src/agent/dream.js";
import { CHECK_SYSTEM, SUMMARY_SYSTEM } from "../../../../packages/meetings/src/summary.js";

const TEST = [
  "---",
  "job: dream",
  "run_as: Maya",
  "---",
  "",
  "# A test",
  "",
  "## 1. Keeps a fact",
  "",
  "- note: tex/transcripts/2026-10-08.md",
  "",
  "```markdown",
  "# Tex, October 8",
  "",
  "## Not a case",
  "**Them:** I'm allergic to peanuts, door code 4417",
  "```",
  "",
  "- must include: peanut | nuts",
  "- must not include: 4417",
  "",
].join("\n");

test("a fenced input keeps its own headings, and the case reads its note and its words", () => {
  const parsed = parseTest(TEST);
  assert.equal(parsed.questions.length, 1);
  const testCase = readCase(parsed.questions[0]);
  assert.deepEqual(testCase.notes.map((note) => note.path), ["tex/transcripts/2026-10-08.md"]);
  assert.match(testCase.notes[0].body, /## Not a case/);
  assert.deepEqual(testCase.include, [["peanut", "nuts"]]);
  assert.deepEqual(testCase.exclude, ["4417"]);
});

test("a case fails on a word it must not include, and passes on any one of its alternatives", () => {
  const testCase = readCase(parseTest(TEST).questions[0]);
  assert.deepEqual(failedLines("- Allergic to NUTS", testCase), []);
  assert.deepEqual(failedLines("- Allergic to peanuts\n- Door code 4417", testCase), ["must not include: 4417"]);
  assert.deepEqual(failedLines("- Likes tea", testCase), ["must include: peanut | nuts"]);
});

test("a case with no words to check is refused when the test is read", () => {
  const raw = "---\njob: dream\n---\n\n## 1. Nothing\n\n- input:\n\n```text\nhi\n```\n";
  assert.throws(() => readCase(parseTest(raw).questions[0]), /no "must include"/);
});

test("the result's table reads as the live row the AI tab shows", () => {
  const raw = checkResultMarkdown({
    job: "dream",
    testVersion: "abc",
    date: "2026-10-17",
    codeCommit: "deadbee",
    setups: [{ name: "production" }],
    cases: [{ n: 1, text: "Keeps a fact" }],
    records: [{ setup: "production", case: 1, output: "- peanuts", error: null, failed: [], ms: 1200, model: "anthropic/claude-haiku-5-5" }],
    bar: 100,
  });
  assert.deepEqual(liveScoreRow(raw), { setup: "production", score: "100.0%", gates: "passed", goodEnough: "yes" });
  const note = scoresNote(raw, { runUrl: null });
  assert.match(note, /^job: dream$/m);
  assert.match(note, /^test: dream$/m);
  assert.match(note, /^good_enough: yes$/m);
});

test("transcription is asked the way the transcribe Worker asks it", async () => {
  const worker = await readFile(new URL("../../../../infra/transcribe-worker/src/transcribe.ts", import.meta.url), "utf8");
  assert.ok(worker.includes(`export const TURBO_MODEL = "${WHISPER_MODEL}";`));
  assert.ok(worker.includes(`export const TURBO_INPUT = Object.freeze(${JSON.stringify(WHISPER_INPUT).replace(/"(\w+)":/g, "$1: ").replace(/^\{/, "{ ").replace(/\}$/, " }")});`));
});

test("every job's test in the repository runs end to end on a scripted model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-check-"));
  try {
    await cp(new URL("../ai/", import.meta.url), dir, { recursive: true });
    const setups = {
      dream: `---\njob: dream\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\n${DREAM_INSTRUCTIONS}\n`,
      "meeting-summaries": `---\njob: meeting-summaries\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\n## Write\n\n${SUMMARY_SYSTEM}\n\n## Check\n\n${CHECK_SYSTEM}\n`,
    };
    for (const [job, raw] of Object.entries(setups)) {
      await mkdir(join(dir, "setups", job), { recursive: true });
      await writeFile(join(dir, "setups", job, "production.md"), raw);
    }
    const write = process.stderr.write;
    process.stderr.write = () => true;
    try {
      for (const job of ["dream", "meeting-summaries", "meeting-transcription", "connected-ais"]) {
        const out = join(dir, "results", `${job}.md`);
        await checkCommand({ job, dir, fake: true, out });
        const raw = await readFile(out, "utf8");
        const row = liveScoreRow(raw);
        assert.equal(row?.setup, "production", job);
        assert.match(raw, /## Outputs/, job);
        assert.doesNotMatch(raw, /\| production \| [^|]+ \| failed \|/, `${job}: no case errored on the scripted model`);
      }
    } finally {
      process.stderr.write = write;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
