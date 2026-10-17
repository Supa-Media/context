/**
 * `pnpm ai promote <job> --setup <name> --results <a.md,b.md> [--dir <folder>] [--run-url <url>]`
 * `pnpm ai promote <job> --revert [--run-url <url>]`
 *
 * The step the testing loop could not take on its own: making a setup that won
 * its rounds the live one. Decided by Dev2 on 2026-10-17 ("I want the testing
 * loop to work autonomously without me having to approve things as long as
 * it's under the budget cap, including running actions and promoting to
 * prod"), replacing the rule of 2026-10-16 that only a person promotes. The
 * improver still never promotes its own draft in the same run: a draft is
 * promoted only by this command, from scored rounds, through this gate.
 *
 * The gate (`promotionVerdict`) reads scored rounds that ran the live setup
 * and the candidate side by side, and promotes only when every one holds:
 *
 *  - the job has a gate at all (`PROMOTION_BARS`), and there is one round of
 *    every test it names;
 *  - each round measured today's live file and today's candidate file (the
 *    versions in its front matter match the files in Context now), on the
 *    test as it stands, asked every question at the test's own runs or more;
 *  - the test was not weakened: every graded line the repository's copy holds
 *    is still in the copy the round ran (`weakenedLines`), so cutting a line
 *    in the app cannot buy a promotion; cutting one takes a reviewed commit;
 *  - the candidate meets the loop's bars, passes its gates where the bars say
 *    so, errs no more than live, and scores no lower than live on any test;
 *  - its price and speed are under the bar, or no more than a tenth over live;
 *  - and it is better by more than noise: at least two more cases passing
 *    in every run, summed over the tests, or the same scores for at least a
 *    tenth less. The same live prompt scored 72% and 83% in two core rounds
 *    of 2026-10-17, so one case either way is not a difference (Dev2 asked
 *    whether three runs show one).
 *
 * Promoting copies the replaced live file to `ai/history/<job>/` first, then
 * writes the candidate's body and settings to `ai/production/<job>.md` with
 * `from`, `came_from`, `proved_by`, `why` and `promoted_by` saying which rounds
 * proved it. `--revert` puts the newest file in `ai/history/<job>/` back,
 * archiving the one it replaces, so a revert is undone by reverting again.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { parseSetup } from "../src/agent/production.js";
import { callTool, LIVE_SETUP, notePaths, PRODUCTION_FOLDER, SETUPS_FOLDER, signIn, splitNote } from "./context.mjs";
import { benchFolder, REPO_BENCH_FOLDER } from "./folder.mjs";
import { parseTest, runnableQuestions } from "./load.mjs";
import { frontMatter, parseResult } from "./resultNote.mjs";
import { parseBars } from "./score.mjs";

export const HISTORY_FOLDER = "ai/history";

/**
 * The loop's bars, per job and test (Dev2, 2026-10-17): core 17 of 19 or
 * better in every run with no gate broken, golden tasks 6 of 8 or better,
 * under $0.05 a question and 90 s an answer. A job not named here is never
 * promoted by the gate.
 */
export const PROMOTION_BARS = {
  "texting-assistant": {
    core: { score: (17 / 19) * 100, gates: true, price: 0.05, speed: 90 },
    tasks: { score: 75, gates: false, price: 0.05, speed: 90 },
  },
};

/** How many more cases a candidate must pass than live, over all its tests. */
export const MIN_CASES_GAINED = 2;
/** How much worse than live a price or speed over its bar may be: a tenth. */
const SLACK = 1.1;
/** What the replaced file's settings are not carried over as: how the candidate got there. */
const NOT_CARRIED = new Set(["from", "live_since", "promoted_by", "came_from", "proved_by", "why", "status", "made_by", "based_on", "change", "title"]);
const STANDING_APPROVAL = `Dev2's standing approval of 2026-10-17 ("I want the testing loop to work autonomously without me having to approve things as long as it's under the budget cap, including running actions and promoting to prod")`;

const version = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 12);
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const number = (text, pattern) => {
  const m = String(text ?? "").match(pattern);
  return m ? Number(m[1]) : null;
};

/** The latest "## Scored by" table's rows, by setup. */
export function scoredRows(raw) {
  const at = raw.lastIndexOf("\n## Scored by ");
  if (at === -1) return new Map();
  const rows = new Map();
  let inTable = false;
  for (const line of raw.slice(at).split("\n")) {
    if (!line.startsWith("| ")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    if (line.startsWith("| setup ") || line.startsWith("| ---")) continue;
    const [setup, score, gates, , price, speed, , errors] = line.slice(2, -2).split(" | ").map((cell) => cell.trim());
    rows.set(setup, {
      setup,
      score: number(score, /^(\d+(?:\.\d+)?)%$/),
      gatesPassed: gates === "passed",
      price: number(price, /^\$(\d+(?:\.\d+)?)$/),
      speed: number(speed, /^(\d+(?:\.\d+)?) s$/),
      errors: Number(errors) || 0,
    });
  }
  return rows;
}

/** A scored round as the gate reads it. */
export function readRound(raw) {
  const front = frontMatter(raw);
  const versions = new Map(
    String(front.setups ?? "")
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim().split("@"))
      .filter((pair) => pair.length === 2),
  );
  return {
    test: front.test,
    testVersion: front.test_version,
    runs: Number(front.runs_per_question) || 0,
    versions,
    asked: new Set(parseResult(raw).answers.map((answer) => answer.question)),
    rows: scoredRows(raw),
  };
}

// Every line a question is graded by or gated on, as written.
const gradedLines = (q) =>
  q.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^- (must[^:]*|forbid|kind|gate|mirror):/.test(line));

/**
 * What the test a round ran gave up against the repository's copy: a case
 * dropped or drafted again, a graded line gone, a lower score bar, fewer runs.
 * Empty when it gave up nothing; a test may always add.
 */
export function weakenedLines(committedRaw, ranRaw) {
  const committed = parseTest(committedRaw);
  const ran = parseTest(ranRaw);
  const out = [];
  const ranByNumber = new Map(ran.questions.map((q) => [q.n, q]));
  for (const q of committed.questions) {
    if (q.drafted !== null) continue;
    const now = ranByNumber.get(q.n);
    if (!now) {
      out.push(`case ${q.n} is gone`);
      continue;
    }
    if (now.drafted !== null) out.push(`case ${q.n} is drafted again`);
    const lines = new Set(gradedLines(now));
    for (const line of gradedLines(q)) if (!lines.has(line)) out.push(`case ${q.n} lost "${line}"`);
  }
  const bar = (test) => parseBars(test.front.good_enough).score ?? 0;
  if (bar(ran) < bar(committed)) out.push(`the score bar fell from ${bar(committed)}% to ${bar(ran)}%`);
  if (ran.front.runs < committed.front.runs) out.push(`runs fell from ${committed.front.runs} to ${ran.front.runs}`);
  return out;
}

const within = (value, bar, live) => value !== null && (value < bar || (live !== null && value <= live * SLACK));

/**
 * Whether `setup` may replace live. `rounds` are `readRound` results with
 * their test's text (`testRaw`, as the round ran it) and the repository's copy
 * (`committedRaw`); `liveVersion` and `candidateVersion` are the files in
 * Context now. Returns `{ ok, reasons, proof }`: every reason is a refusal.
 */
export function promotionVerdict({ job, setup, rounds, liveVersion, candidateVersion }) {
  const bars = PROMOTION_BARS[job];
  if (!bars) return { ok: false, reasons: [`${job} has no promotion gate`], proof: [] };
  if (setup === LIVE_SETUP) return { ok: false, reasons: ["live cannot be promoted over itself"], proof: [] };
  const reasons = [];
  const proof = [];
  let gained = 0;
  let priceNow = 0;
  let priceThen = 0;
  for (const test of Object.keys(bars)) {
    const round = rounds.find((r) => r.test === test);
    if (!round) {
      reasons.push(`no ${test} round`);
      continue;
    }
    const bar = bars[test];
    const say = (text) => reasons.push(`${test}: ${text}`);
    const live = round.rows.get(LIVE_SETUP);
    const cand = round.rows.get(setup);
    if (!live || !cand) {
      say(`the round did not run both ${LIVE_SETUP} and ${setup}`);
      continue;
    }
    if (round.versions.get(LIVE_SETUP) !== liveVersion) say("the round measured an earlier live file");
    if (round.versions.get(setup) !== candidateVersion) say(`the round measured an earlier ${setup}`);
    const test_ = parseTest(round.testRaw);
    if (round.testVersion !== version(round.testRaw)) say("the round ran an earlier version of the test");
    if (round.runs < test_.front.runs) say(`${round.runs} runs a question, under the test's ${test_.front.runs}`);
    const wanted = runnableQuestions(test_.questions, null, () => {}).map((q) => q.n);
    const missing = wanted.filter((n) => !round.asked.has(n));
    if (missing.length) say(`cases ${missing.join(", ")} were not asked`);
    for (const line of weakenedLines(round.committedRaw, round.testRaw)) say(`the test was weakened: ${line}`);
    if (cand.score === null || cand.score < bar.score) say(`${setup} scored ${cand.score ?? "n/a"}%, under the bar of ${bar.score.toFixed(1)}%`);
    if (bar.gates && !cand.gatesPassed) say(`${setup} broke a gate`);
    if (cand.errors > live.errors) say(`${setup} erred ${cand.errors} times, live ${live.errors}`);
    if (cand.score !== null && live.score !== null && cand.score < live.score) say(`${setup} scored ${cand.score}%, under live's ${live.score}%`);
    if (!within(cand.price, bar.price, live.price)) say(`${setup} costs $${cand.price ?? "unknown"} a question, over $${bar.price} and over live's $${live.price ?? "unknown"}`);
    if (!within(cand.speed, bar.speed, live.speed)) say(`${setup} takes ${cand.speed ?? "n/a"} s, over ${bar.speed} s and over live's ${live.speed ?? "n/a"} s`);
    if (cand.score !== null && live.score !== null) gained += ((cand.score - live.score) / 100) * round.asked.size;
    priceNow += cand.price ?? 0;
    priceThen += live.price ?? 0;
    proof.push(`${test}: ${setup} ${cand.score}% against live's ${live.score}%, gates ${cand.gatesPassed ? "passed" : "broken"}, $${cand.price} a question, ${cand.speed} s`);
  }
  // A rounding hair under a whole case still counts as that case.
  const better = gained >= MIN_CASES_GAINED - 0.01 || (gained > -0.01 && priceNow * SLACK <= priceThen);
  if (!better) reasons.push(`${setup} is not better than live by more than noise: ${gained.toFixed(1)} cases gained, ${MIN_CASES_GAINED} needed, and not a tenth cheaper`);
  return { ok: reasons.length === 0, reasons, proof };
}

/**
 * The new live file: the candidate's settings and body, without the
 * bookkeeping of how the candidate or the replaced file got there, and with
 * the promotion's own.
 */
export function productionNote({ candidateRaw, liveRaw, job, setup, date, proof, runUrl, archived }) {
  const match = candidateRaw.match(/^---\n([\s\S]*?)\n---\n?/);
  const kept = [];
  let skipping = false;
  for (const line of match[1].split("\n")) {
    const key = line.match(/^([a-z_][a-z0-9_-]*):/)?.[1];
    if (key) skipping = NOT_CARRIED.has(key) || key === "job";
    else if (!/^\s/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const cand = frontMatter(candidateRaw);
  const live = frontMatter(liveRaw);
  return [
    "---",
    `job: ${job}`,
    `from: ${setup}`,
    ...kept,
    `came_from: setups/${job}/${setup}, promoted ${date} over ${oneLine(live.from) || "the earlier live file"}, whose file is ${archived}. Read that file for the history before it.`,
    `proved_by: ${proof.join("; ")}${runUrl ? ` (${runUrl})` : ""}`,
    `why: ${oneLine(cand.why || cand.change) || "it beat live on the promotion gate"}`,
    `promoted_by: the benchmark promotion gate (apps/mcp/bench/promote.mjs), ${date}, under ${STANDING_APPROVAL}. Revert with the AI Promote Action's revert.`,
    "---",
    candidateRaw.slice(match[0].length).replace(/^\n?/, "\n"),
  ].join("\n");
}

async function readNote(connection, path, fetchImpl) {
  const read = await callTool(connection, "read_note", { path }, fetchImpl);
  if (read.isError) return null;
  const { header, content } = splitNote(read.text);
  return { etag: header.etag ?? null, content: content.endsWith("\n") ? content : `${content}\n` };
}

async function writeNote(connection, args, fetchImpl) {
  const written = await callTool(connection, "write_note", args, fetchImpl);
  if (written.isError) throw new Error(`write_note ${args.path}: ${written.text}`);
}

async function archive(connection, { job, raw, stamp }, fetchImpl) {
  const from = oneLine(frontMatter(raw).from).replace(/[^\w.-]+/g, "-") || "live";
  const path = `${HISTORY_FOLDER}/${job}/${stamp} ${from}.md`;
  if (!(await readNote(connection, path, fetchImpl))) await writeNote(connection, { path, content: raw, summary: `the ${job} file replaced on ${stamp}` }, fetchImpl);
  return path;
}

/** Puts `setup` live when the gate passes. Returns `{ promoted, reasons, proof }`. */
export async function promote({ job, setup, rounds, connection, runUrl = null, now = new Date(), fetchImpl = fetch }) {
  const livePath = `${PRODUCTION_FOLDER}/${job}.md`;
  const live = await readNote(connection, livePath, fetchImpl);
  const cand = await readNote(connection, `${SETUPS_FOLDER}/${job}/${setup}.md`, fetchImpl);
  if (!live || !cand) return { promoted: false, reasons: [`${live ? `${SETUPS_FOLDER}/${job}/${setup}.md` : livePath} is not in Context`], proof: [] };
  const [liveSetup, candSetup] = [await parseSetup(live.content), await parseSetup(cand.content)];
  if (!liveSetup || !candSetup) return { promoted: false, reasons: ["a file the gateway would refuse"], proof: [] };
  const verdict = promotionVerdict({ job, setup, rounds, liveVersion: liveSetup.version, candidateVersion: candSetup.version });
  // A skill only the candidate's folder has would not be live with it.
  const liveSkills = notePaths((await callTool(connection, "list_notes", { prefix: `${PRODUCTION_FOLDER}/skills` }, fetchImpl)).text).map((p) => basename(p, ".md"));
  const missing = candSetup.skills.map((skill) => skill.name).filter((name) => !liveSkills.includes(name));
  if (missing.length) verdict.reasons.push(`skills not live yet: ${missing.join(", ")}`);
  if (verdict.reasons.length) return { promoted: false, reasons: verdict.reasons, proof: verdict.proof };

  const date = now.toISOString().slice(0, 10);
  const archived = await archive(connection, { job, raw: live.content, stamp: now.toISOString().slice(0, 16).replace(":", "") }, fetchImpl);
  const next = productionNote({ candidateRaw: cand.content, liveRaw: live.content, job, setup, date, proof: verdict.proof, runUrl, archived });
  const parsed = await parseSetup(next);
  if (!parsed || parsed.prompt !== candSetup.prompt || parsed.model !== candSetup.model) throw new Error("the promoted file would not read as the candidate; nothing was promoted");
  await writeNote(connection, { path: livePath, content: next, expected_etag: live.etag, summary: `promote ${setup} to live ${job}` }, fetchImpl);
  return { promoted: true, reasons: [], proof: verdict.proof, archived };
}

/** Puts the newest archived file back live, archiving the one it replaces. */
export async function revert({ job, connection, now = new Date(), fetchImpl = fetch }) {
  const livePath = `${PRODUCTION_FOLDER}/${job}.md`;
  const listed = await callTool(connection, "list_notes", { prefix: `${HISTORY_FOLDER}/${job}` }, fetchImpl);
  const newest = notePaths(listed.text).sort().at(-1);
  if (!newest) throw new Error(`nothing in ${HISTORY_FOLDER}/${job}/ to revert to`);
  const [live, back] = [await readNote(connection, livePath, fetchImpl), await readNote(connection, newest, fetchImpl)];
  if (!live || !back || !(await parseSetup(back.content))) throw new Error(`${newest} cannot go live`);
  const archived = await archive(connection, { job, raw: live.content, stamp: now.toISOString().slice(0, 16).replace(":", "") }, fetchImpl);
  await writeNote(connection, { path: livePath, content: back.content, expected_etag: live.etag, summary: `revert live ${job} to ${newest}` }, fetchImpl);
  return { restored: newest, archived };
}

/** The repository's copy of a test, as committed, whatever `pull` wrote over it. */
function committedTest(test) {
  const path = relative(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), join(REPO_BENCH_FOLDER, "tests", `${test}.md`));
  return execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
}

/** The `promote` command: options come from run.mjs's argument parser. */
export async function promoteCommand(options) {
  const job = options.job;
  if (!job) throw new Error("usage: pnpm ai promote <job> --setup <name> --results <a.md,b.md> | --revert");
  const connection = await signIn({ env: process.env });
  if (options.revert) {
    const { restored, archived } = await revert({ job, connection });
    process.stdout.write(`Reverted live ${job} to ${restored}; the file it replaced is ${archived}.\n`);
    return;
  }
  if (!options.setup || !options.results) throw new Error("promote needs --setup and --results");
  const dir = benchFolder(options);
  const rounds = [];
  for (const path of options.results.split(",").filter(Boolean)) {
    const round = readRound(await readFile(path, "utf8"));
    round.testRaw = await readFile(join(dir, "tests", `${round.test}.md`), "utf8");
    round.committedRaw = committedTest(round.test);
    rounds.push(round);
  }
  const result = await promote({ job, setup: options.setup, rounds, connection, runUrl: options["run-url"] ?? null });
  const lines = result.promoted
    ? [`Promoted ${options.setup} to live ${job}. The file it replaced is ${result.archived}.`, ...result.proof.map((line) => `- ${line}`)]
    : [`Not promoted: ${options.setup} stays a setup.`, ...result.reasons.map((line) => `- ${line}`)];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!result.promoted) process.exitCode = 3;
}
