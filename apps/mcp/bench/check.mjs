/**
 * `pnpm ai check <job>`: THE SIMPLE TEST FOR A JOB THAT IS NOT A CONVERSATION.
 *
 * Asked for by the owner (2026-10-17): for each AI job still running in code,
 * "move the prompt into a note for me, create a very simple test case, and run
 * it". Tex's texts are graded by a judge (`run.mjs`) and search by ranks
 * (`search.mjs`); the rest are one call with one input, and a very simple test
 * is words that must, or must not, be in what comes out. No judge, no model
 * but the job's own:
 *
 *   dream                  Tex's nightly dream, through the real `/agent` in
 *                          a throwaway world (`jobs/dream.mjs`)
 *   heartbeat              Tex's daytime check-in, through the real `/agent`:
 *                          the text it would send, or SKIP (`jobs/heartbeat.mjs`)
 *   meeting-summaries      a meeting note's summary, the gateway's own
 *                          write-and-check path (`jobs/meetingSummaries.mjs`)
 *   meeting-transcription  a spoken sentence through Whisper (`jobs/transcription.mjs`)
 *   connected-ais          an AI client given only our MCP instructions and
 *                          tools (`jobs/connectedAis.mjs`)
 *
 * A test is `tests/<job>.md` in the shape every test has (`load.mjs`), and a
 * case's own lines say what goes in and what must come out:
 *
 *   - note: tex/transcripts/2026-10-08.md     the next fenced block is that
 *                                            note, put in the person's
 *                                            workspace first
 *   - input:                                 the next fenced block is the input
 *   - must include: peanut | peanuts         one of these, any case
 *   - must not include: 4417                 none of this, any case
 *
 * A setup is `setups/<job>/<name>.md` (the live one is pulled as
 * `production.md`); a job with no prompt runs once, as `production`. The
 * result note's "Scored by checks" table is the one `context.mjs` reads for
 * the AI tab, so a check round shows on its job like any other.
 *
 *   pnpm ai check <job> [--dir <folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { benchFolder } from "./folder.mjs";
import { readBenchFolder, runnableQuestions } from "./load.mjs";
import { dreamJob } from "./jobs/dream.mjs";
import { heartbeatJob } from "./jobs/heartbeat.mjs";
import { meetingSummariesJob } from "./jobs/meetingSummaries.mjs";
import { transcriptionJob } from "./jobs/transcription.mjs";
import { connectedAisJob } from "./jobs/connectedAis.mjs";

/** Every job `check` runs, by its name in the AI tab (`aiCatalog.ts`). */
export const CHECK_JOBS = Object.freeze({
  dream: dreamJob,
  heartbeat: heartbeatJob,
  "meeting-summaries": meetingSummariesJob,
  "meeting-transcription": transcriptionJob,
  "connected-ais": connectedAisJob,
});

const list = (value) => (value ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : null);

function commit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * A case's own lines: the notes to place, the input, and the words. Read from
 * the question's body, which `load.mjs` keeps whole.
 */
export function readCase(question) {
  const lines = question.body.split("\n");
  const notes = [];
  let input = null;
  const include = [];
  const exclude = [];
  let waiting = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    let m;
    if (line.startsWith("```") && waiting !== null) {
      const end = lines.findIndex((next, k) => k > i && next.trim().startsWith("```"));
      if (end === -1) throw new Error(`case ${question.n}: a fenced block is not closed`);
      const text = `${lines.slice(i + 1, end).join("\n")}\n`;
      if (waiting === true) input = text;
      else notes.push({ path: waiting, body: text });
      waiting = null;
      i = end;
    } else if ((m = line.match(/^- note:\s*(\S+)$/))) waiting = m[1];
    else if (/^- input:\s*$/.test(line)) waiting = true;
    else if ((m = line.match(/^- must include:\s*(.+)$/))) include.push(m[1].split(" | ").map((part) => part.trim()).filter(Boolean));
    else if ((m = line.match(/^- must not include:\s*(.+)$/))) exclude.push(m[1].trim());
  }
  if (waiting !== null) throw new Error(`case ${question.n}: "${waiting === true ? "input" : waiting}" has no fenced block after it`);
  if (include.length === 0 && exclude.length === 0) throw new Error(`case ${question.n}: no "must include" or "must not include" line`);
  return { n: question.n, text: question.text, as: question.as, notes, input, include, exclude };
}

/** Which lines an output fails, as the line says them; empty is a pass. */
export function failedLines(output, testCase) {
  const text = String(output ?? "").toLowerCase();
  const failed = [];
  for (const alternatives of testCase.include) {
    if (!alternatives.some((word) => text.includes(word.toLowerCase()))) failed.push(`must include: ${alternatives.join(" | ")}`);
  }
  for (const word of testCase.exclude) if (text.includes(word.toLowerCase())) failed.push(`must not include: ${word}`);
  return failed;
}

async function readSetups(dir, job, only) {
  if (!job.setupNote) return [{ name: "production", raw: null }];
  const folder = join(dir, "setups", job.name);
  let names = [];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".md") && name !== "about.md").map((name) => name.slice(0, -3)).sort();
  } catch {
    names = [];
  }
  const chosen = only ? names.filter((name) => only.includes(name)) : names;
  if (chosen.length === 0) throw new Error(`no setups to run in setups/${job.name}/: pull the job first (pnpm ai pull ${job.name})`);
  return Promise.all(chosen.map(async (name) => ({ name, raw: await readFile(join(folder, `${name}.md`), "utf8") })));
}

const pct = (n, of) => (of === 0 ? "0%" : `${((100 * n) / of).toFixed(1)}%`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};
const quoted = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

/** The bar from `good_enough.passed`, "100%" by default: a very simple test passes whole. */
export function passBar(good = {}) {
  const m = String(good?.passed ?? "100%").match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : 100;
}

/** One row per setup. */
export function scoreChecks(records, setups, bar) {
  return setups.map((setup) => {
    const mine = records.filter((record) => record.setup === setup.name);
    const passed = mine.filter((record) => record.error === null && record.failed.length === 0).length;
    const errors = mine.filter((record) => record.error !== null).length;
    const share = mine.length === 0 ? 0 : (100 * passed) / mine.length;
    return {
      setup: setup.name,
      cases: mine.length,
      passed,
      errors,
      score: pct(passed, mine.length),
      medianMs: median(mine.map((record) => record.ms)),
      model: [...new Set(mine.map((record) => record.model).filter(Boolean))].join(", ") || "-",
      goodEnough: mine.length > 0 && errors === 0 && share >= bar,
    };
  });
}

/** The result note: what `summary.mjs` and `context.mjs` read, then every case's output. */
export function checkResultMarkdown({ job, testVersion, date, codeCommit, setups, cases, records, bar }) {
  const rows = scoreChecks(records, setups, bar);
  const out = [
    "---",
    "role: benchmark-result",
    `job: ${job}`,
    `test: ${job}`,
    `date: ${date}`,
    `test_version: ${testVersion}`,
    `code_commit: ${codeCommit}`,
    `setups: [${setups.map((setup) => setup.name).join(", ")}]`,
    "status: scored",
    "---",
    "",
    `# ${job} check, ${date}`,
    "",
    "## Summary",
    "",
    `This run put ${cases.length} case${cases.length === 1 ? "" : "s"} to ${setups.length} setup${setups.length === 1 ? "" : "s"} once each, and checked the output for the words each case names. No judge.`,
    "",
    `## Scored by checks, ${date}`,
    "",
    "| setup | score | gates | passed | cases | errors | median time | model | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.setup} | ${row.score} | ${row.errors === 0 ? "passed" : "failed"} | ${row.passed} | ${row.cases} | ${row.errors} | ${(row.medianMs / 1000).toFixed(1)} s | ${row.model} | ${row.goodEnough ? "yes" : "no"} |`,
    ),
    "",
    `Bar: ${bar}% of cases passed, and no errors.`,
    "",
    "## Misses",
    "",
  ];
  const misses = records.filter((record) => record.error !== null || record.failed.length > 0);
  if (misses.length === 0) out.push("_None: every case passed._", "");
  for (const record of misses) {
    out.push(`- ${record.setup}, case ${record.case}: ${record.error !== null ? `error: ${record.error}` : record.failed.join("; ")}`);
  }
  if (misses.length > 0) out.push("");
  out.push("## Outputs", "");
  for (const testCase of cases) {
    out.push(`### ${testCase.n}. ${testCase.text}`, "");
    for (const record of records.filter((entry) => entry.case === testCase.n)) {
      const verdict = record.error !== null ? "error" : record.failed.length === 0 ? "passed" : "failed";
      out.push(`#### ${record.setup}: ${verdict}`, "", quoted(String(record.output || "(nothing)").trim().slice(0, 4000)), "");
    }
  }
  return out.join("\n");
}

export async function checkCommand(options) {
  const dir = benchFolder(options);
  const job = CHECK_JOBS[options.job];
  if (!dir || !job) {
    throw new Error(`usage: pnpm ai check <${Object.keys(CHECK_JOBS).join("|")}> [--dir <folder>] [--setups a,b] [--questions 1,2] [--out <note>] [--fake]`);
  }
  const bench = await readBenchFolder(dir);
  const test = bench.tests[job.name];
  if (!test) throw new Error(`no tests/${job.name}.md`);
  const only = list(options.questions)?.map(Number);
  const cases = runnableQuestions(test.questions, only).map((question) => ({
    ...readCase(question),
    as: question.as ?? test.front.run_as ?? null,
  }));
  const setups = await readSetups(dir, job, list(options.setups));
  const bar = passBar(test.front.good_enough);
  const fake = options.fake === true;
  const today = test.front.today ?? new Date().toISOString().slice(0, 10);

  const records = [];
  for (const setup of setups) {
    for (const testCase of cases) {
      const started = Date.now();
      let answer;
      try {
        answer = await job.run({ bench, setup, testCase, today, fake });
      } catch (error) {
        answer = { output: "", error: String(error?.message ?? error).slice(0, 300) };
      }
      const error = answer.error ?? null;
      const failed = error === null ? failedLines(answer.output, testCase) : [];
      records.push({ setup: setup.name, case: testCase.n, output: answer.output ?? "", error, failed, ms: answer.ms ?? Date.now() - started, model: answer.model ?? null });
      process.stderr.write(`${setup.name} case ${testCase.n}: ${error !== null ? `error (${error})` : failed.length === 0 ? "passed" : `failed (${failed.join("; ")})`}\n`);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const out = options.out ?? join(dir, "results", `${date} ${job.name}.md`);
  await mkdir(join(out, ".."), { recursive: true });
  const raw = test.raw ?? "";
  await writeFile(
    out,
    checkResultMarkdown({
      job: job.name,
      testVersion: createHash("sha256").update(raw).digest("hex").slice(0, 12),
      date,
      codeCommit: commit(),
      setups,
      cases,
      records,
      bar,
    }),
  );
  for (const row of scoreChecks(records, setups, bar)) process.stderr.write(`${row.setup}: ${row.passed}/${row.cases} passed, good enough: ${row.goodEnough ? "yes" : "no"}\n`);
  process.stderr.write(`wrote ${basename(out)}\n`);
}
