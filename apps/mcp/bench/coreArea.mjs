/**
 * THE REPLAY GATE'S CORE AREA (Dev2, 2026-11-13; docs/decisions/testing/replay-gate.md): a change to the front door,
 * the prompt modules or the turn runs the core set and the simple asks through the real answer maker, as
 * production's setup, and the judge grades each answer. Each question is one case, `<test>/q<n>`.
 *
 * It runs `pnpm ai run` and `pnpm ai judge` in the tree it is given (the change's, or main's beside it), so each
 * tree answers with its own code; the scoring is read here, the same way `score.mjs` reads it. The production setup
 * and the tests edited in Context are pulled into each tree first (`pnpm ai pull texting-assistant`).
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { isGateQuestion, parseTest } from "./load.mjs";
import { frontMatter, parseJudgedSections, parseKey, parseResult } from "./resultNote.mjs";
import { parseBars, scoreSetups } from "./score.mjs";
import { OVERHEAD } from "./spend.mjs";

const run = promisify(execFile);

/** The tests the core area runs, in order. */
export const CORE_TESTS = ["core", "simple-asks"];
const SETUP = "production";

/** `core/q3` -> { test: "core", n: 3 }, or null. */
export function caseId(id) {
  const m = /^([a-z0-9-]+)\/q(\d+)$/.exec(id);
  return m ? { test: m[1], n: Number(m[2]) } : null;
}

/**
 * A judged result's cases: one row per question, with each answered run's pass, from the same rules the scores use
 * (a run passes when every must and must-not line passed). A question whose mirror did not pass is untested and
 * left out: its mirror's own row carries the failure. `usd` is what the answers cost plus the judge's share.
 */
export function coreCases({ test, testRaw, resultRaw, keyRaw, setup = SETUP }) {
  const parsed = parseTest(testRaw);
  const questions = new Map(parsed.questions.map((q) => [q.n, q]));
  const sections = parseJudgedSections(resultRaw);
  if (sections.length === 0) throw new Error(`the ${test} result has no "## Judged by" section`);
  const answers = parseResult(resultRaw).answers;
  const key = parseKey(keyRaw).filter((row) => row.setup === setup);
  const { cases } = scoreSetups({ key, judged: sections.at(-1).blocks, answers: new Map(answers.map((a) => [a.id, a])), questions, bars: {} });
  const rows = [];
  for (const c of cases) {
    const cell = c.cells[setup];
    if (cell === undefined || cell === "untested") continue;
    const q = questions.get(c.question);
    const results = [...Array(cell.passed).fill(true), ...Array(cell.runs - cell.passed).fill(false)];
    rows.push({
      id: `${test}/q${c.question}`,
      right: cell.runs > 0 && cell.passed === cell.runs,
      results,
      must: isGateQuestion(q),
      heldOut: false,
      cause: null,
      target: q.target ?? null,
      expected: `pass every must line of "${c.title}"`,
    });
  }
  const price = answers.reduce((sum, answer) => sum + (answer.time?.price ?? 0), 0);
  // The test's own bars, held on every case but the targets (known bugs, reported apart).
  const targets = new Set(parsed.questions.filter((q) => q.target !== null).map((q) => q.n));
  const held = scoreSetups({ key: key.filter((row) => !targets.has(row.question)), judged: sections.at(-1).blocks, answers: new Map(answers.map((a) => [a.id, a])), questions, bars: parseBars(parsed.front.good_enough) }).rows[0] ?? null;
  const bar = held && { score: held.score, gateFailed: held.gateFailed, goodEnough: held.goodEnough, speed: held.speed, price: held.price };
  return { rows, usd: Math.round(price * OVERHEAD * 10000) / 10000, bar };
}

/**
 * `tests` answered in `tree`: every case, or `only` those, `runs` times each. `dir` is the bench folder the tree's
 * run reads (its own `apps/mcp/bench/ai` unless named). Returns rows whose `results` hold one boolean a run, what it
 * cost, each test's bar, and the tests the tree does not have.
 */
export async function runTests(tree, tests, { only = null, runs = 1, fake = false, scratch, tag, dir = null }) {
  const folder = dir ?? join(tree, "apps/mcp/bench/ai");
  const script = join(tree, "apps/mcp/bench/run.mjs");
  const rows = [];
  const bars = {};
  const missing = [];
  let usd = 0;
  for (const test of tests) {
    const named = only ? only.map(caseId).filter((c) => c?.test === test).map((c) => c.n) : null;
    if (named && named.length === 0) continue;
    const testPath = join(folder, "tests", `${test}.md`);
    const testRaw = await readFile(testPath, "utf8").catch(() => null);
    if (testRaw === null) {
      missing.push(test); // a tree without the test (main, before a change adds it) answers none of it
      continue;
    }
    // A question with a mirror counts only when its mirror passes, so a rerun asks the mirror too: without it the
    // question read as untested, its row vanished, and one failed first run looked like a new case (core/q13, 2026-11-13).
    const numbers = named && withMirrors(named, parseTest(testRaw).questions);
    const out = join(scratch, `core-${test}-${tag}.md`);
    const args = ["run", "texting-assistant", "--dir", folder, "--test", test, "--setups", SETUP, "--runs", String(runs), "--out", out];
    if (numbers) args.push("--questions", numbers.join(","));
    if (fake) args.push("--fake");
    await run(process.execPath, [script, ...args], { cwd: tree, maxBuffer: 64 * 1024 * 1024, env: process.env });
    await run(process.execPath, [script, "judge", out, "--dir", folder, "--max-usd", "1", ...(fake ? ["--fake"] : [])], { cwd: tree, maxBuffer: 64 * 1024 * 1024, env: process.env });
    const resultRaw = await readFile(out, "utf8");
    const keyRaw = await readFile(join(dirname(out), frontMatter(resultRaw).key), "utf8");
    const cases = coreCases({ test, testRaw, resultRaw, keyRaw });
    rows.push(...cases.rows.filter((row) => !only || only.includes(row.id)));
    usd += cases.usd;
    bars[test] = cases.bar;
  }
  return { rows, usd, bars, missing };
}

/** `numbers` and the mirror question each of them counts on, in order, each once. */
export function withMirrors(numbers, questions) {
  const mirrors = numbers.map((n) => questions.find((q) => q.n === n)?.mirror ?? null).filter((n) => n !== null);
  return [...new Set([...numbers, ...mirrors])];
}

/** The core area: the core set and the simple asks. */
export const runCore = (tree, options) => runTests(tree, CORE_TESTS, options);
