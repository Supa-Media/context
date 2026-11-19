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
import { fallbacksIn } from "./fallbacks.mjs";
import { handoffTotals } from "./handoffTotals.mjs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_JUDGE, labJudge } from "./judge.mjs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { isGateQuestion, parseTest } from "./load.mjs";
import { frontMatter, parseJudgedSections, parseKey, parseResult } from "./resultNote.mjs";
import { parseBars, scoreSetups } from "./score.mjs";
import { OVERHEAD } from "./spend.mjs";

const run = promisify(execFile);

/** Bearer tokens and Anthropic-style keys, never kept in a reason. */
const SECRET = /Bearer\s+\S+|sk-[\w-]+/g;
/** A stderr line worth reporting: a failure, an error, an HTTP status, or credit. */
const TELLING = /failed|error|status \d{3}|credit/i;
/** At most this much of a reason is kept. */
const REASON_CHARS = 300;

/**
 * Why a `pnpm ai run` or `judge` process failed, from its stderr: the last non-empty lines that name a failure, joined,
 * at most 300 characters, with any token or key redacted. Never the command line: execFile's own message starts with
 * it (~190 characters), and a Lab row kept 200, so every Claude call failing for lack of credit read as nothing at all
 * (gw Lab runs, 2026-11-18).
 */
export function failureReason(error) {
  const lines = String(error?.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const telling = lines.filter((line) => TELLING.test(line));
  const picked = (telling.length > 0 ? telling : lines.slice(-1)).map((line) => line.replace(SECRET, "[redacted]"));
  let reason = "";
  for (let k = picked.length - 1; k >= 0; k -= 1) {
    const next = reason === "" ? picked[k] : `${picked[k]}; ${reason}`;
    if (next.length > REASON_CHARS) {
      if (reason === "") reason = picked[k].slice(-REASON_CHARS);
      break;
    }
    reason = next;
  }
  if (reason !== "") return reason;
  const code = error?.code ?? error?.signal;
  return code === undefined || code === null ? "no output" : `exit ${code}, no output`;
}

/** One bench step's process, or an error that says which step and why, never its command line. */
async function step(name, exec, args, options) {
  try {
    return await exec(process.execPath, args, options);
  } catch (error) {
    throw new Error(`${name} failed: ${failureReason(error)}`);
  }
}

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
    // What went wrong, for a reader of the run (a Lab run's row, `setsFd.mjs`): each failed must or never line and
    // the judge's reason, and the texts Tex sent. Kept beside the row, never in a score.
    const runIds = key.filter((row) => row.question === c.question).map((row) => row.id);
    const verdicts = runIds.flatMap((id) => (sections.at(-1).blocks.get(id)?.verdicts ?? []).filter((v) => v.kind !== "judge"));
    const misses = verdicts.filter((v) => !v.pass).map((v) => ({ kind: v.kind, line: v.line, reason: v.reason }));
    // And each line that held with the judge's reason, so a passed row can be audited too (Dev2, 2026-11-17).
    const held = verdicts.filter((v) => v.pass).map((v) => ({ kind: v.kind, line: v.line, reason: v.reason }));
    const said = answers.filter((a) => runIds.includes(a.id)).flatMap((a) => (a.conversation ?? []).filter((turn) => turn.from !== "person" && turn.from !== "them").map((turn) => turn.text));
    // The background jobs its runs handed off and ran (`jobDelivery.mjs`): what they added, never a score.
    const handoff = handoffTotals(answers.filter((a) => runIds.includes(a.id)).flatMap((a) => a.delivered ?? []));
    // What the bench could not stand in for on its runs (`benchGaps.mjs`): the row's reader treats it as a harness error.
    const bench = [...new Set(answers.filter((a) => runIds.includes(a.id)).flatMap((a) => a.bench ?? []))];
    // Each texted turn's rounds of its bound, and whether it ran out (`report.mjs`): what a miss is read against, never a score.
    const rounds = answers.filter((a) => runIds.includes(a.id) && (a.rounds ?? []).length > 0).map((a) => a.rounds); // one list per run
    // Each texted turn's route (`report.mjs`): one list per run, read for the Lab's route summary, never a score.
    const routes = answers.filter((a) => runIds.includes(a.id) && (a.routes ?? []).length > 0).map((a) => a.routes);
    // Calls its runs answered with the fallback model (`fallbacks.mjs`): a Lab run with any is not Tex's score.
    const fallbacks = answers.filter((a) => runIds.includes(a.id)).reduce((n, a) => n + fallbacksIn(a.tools), 0);
    // What the turn did (`turnSteps.mjs`): the first answered run's steps line, shown on the row beside its rounds, never a score.
    const steps = answers.find((a) => runIds.includes(a.id) && typeof a.steps === "string" && a.steps !== "")?.steps ?? null;
    // Each failed tool's own error on its runs (`toolErrors.mjs`): why a tool failed, shown on the row, never a score.
    const toolErrors = [...new Set(answers.filter((a) => runIds.includes(a.id)).flatMap((a) => a.toolErrors ?? []))].slice(0, 6);
    rows.push({
      ...(bench.length > 0 ? { bench } : {}),
      misses,
      held,
      said,
      ...(handoff.jobs > 0 ? { handoff } : {}),
      ...(rounds.length > 0 ? { rounds } : {}),
      ...(routes.length > 0 ? { routes } : {}),
      ...(fallbacks > 0 ? { fallbacks } : {}),
      ...(steps !== null ? { steps } : {}),
      ...(toolErrors.length > 0 ? { toolErrors } : {}),
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
 * Keeps one judged case's three notes in `keep/name`: the judged result, its key and the test, as `result.md`,
 * `key.md` and `test.md`, so `regrade.mjs` can grade them again. A copy that fails is reported on stderr and never
 * fails the run that judged them.
 */
export async function keepJudged(keep, name, { result, key, test, units = null }) {
  const folder = join(keep, name);
  try {
    await mkdir(folder, { recursive: true });
    // Who each question was (`setsFd.mjs`: chat, message and node, in question order), so a regrade names its rows.
    if (units) await writeFile(join(folder, "units.json"), JSON.stringify(units, null, 1) + "\n");
    await copyFile(result, join(folder, "result.md"));
    await copyFile(key, join(folder, "key.md"));
    await copyFile(test, join(folder, "test.md"));
  } catch (error) {
    process.stderr.write(`could not keep ${name}: ${String(error?.message ?? error).slice(0, 200)}\n`);
  }
}

/**
 * `tests` answered in `tree`: every case, or `only` those, `runs` times each. `dir` is the bench folder the tree's
 * run reads (its own `apps/mcp/bench/ai` unless named). Returns rows whose `results` hold one boolean a run, what it
 * cost, each test's bar, and the tests the tree does not have. `envOf(test)`, when given, is that test's own environment
 * (a Training conversation cut at its moment, `setsFd.mjs`). `keep`, a folder, keeps each judged test's three notes
 * under `keepPrefix` + the test's name (`keepJudged`), with `keepUnits` as its units.json when given.
 */
export async function runTests(tree, tests, { only = null, runs = 1, fake = false, scratch, tag, dir = null, parallel = 1, env = process.env, envOf = null, exec = run, keep = null, keepPrefix = "", keepUnits = null }) {
  const folder = dir ?? join(tree, "apps/mcp/bench/ai");
  const script = join(tree, "apps/mcp/bench/run.mjs");
  // Each test is its own run and judge process writing its own files, so `parallel` of them can go at once (a Lab
  // Dev run's ~30 Front door tests took ~40 minutes one after another; Dev2, 2026-11-17: "why so long?"). The
  // answers are gathered in the tests' order, so the result reads the same either way.
  const answers = new Array(tests.length);
  const one = async (test) => {
    const named = only ? only.map(caseId).filter((c) => c?.test === test).map((c) => c.n) : null;
    if (named && named.length === 0) return null;
    const testPath = join(folder, "tests", `${test}.md`);
    const testRaw = await readFile(testPath, "utf8").catch(() => null);
    if (testRaw === null) return { missing: true }; // a tree without the test (main, before a change adds it) answers none of it
    // A question with a mirror counts only when its mirror passes, so a rerun asks the mirror too: without it the
    // question read as untested, its row vanished, and one failed first run looked like a new case (core/q13, 2026-11-13).
    const numbers = named && withMirrors(named, parseTest(testRaw).questions);
    const out = join(scratch, `core-${test}-${tag}.md`);
    const args = ["run", "texting-assistant", "--dir", folder, "--test", test, "--setups", SETUP, "--runs", String(runs), "--out", out];
    if (numbers) args.push("--questions", numbers.join(","));
    if (fake) args.push("--fake");
    const own = envOf?.(test) ?? env;
    await step("answer", exec, [script, ...args], { cwd: tree, maxBuffer: 64 * 1024 * 1024, env: own });
    // A Lab judge is Haiku, always (`judge.mjs` labJudge): a test's own judge line is never read here.
    await step("judge", exec, [script, "judge", out, "--dir", folder, "--max-usd", "1", ...(fake ? ["--fake"] : ["--judge", labJudge(DEFAULT_JUDGE)])], { cwd: tree, maxBuffer: 64 * 1024 * 1024, env: own });
    const resultRaw = await readFile(out, "utf8");
    const keyPath = join(dirname(out), frontMatter(resultRaw).key);
    const keyRaw = await readFile(keyPath, "utf8");
    if (keep) await keepJudged(keep, `${keepPrefix}${test}`, { result: out, key: keyPath, test: testPath, units: keepUnits });
    return { cases: coreCases({ test, testRaw, resultRaw, keyRaw }) };
  };
  let next = 0;
  const worker = async () => {
    while (next < tests.length) {
      const k = next++;
      answers[k] = await one(tests[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(parallel) || 1, tests.length)) }, worker));
  const rows = [];
  const bars = {};
  const missing = [];
  let usd = 0;
  tests.forEach((test, k) => {
    const a = answers[k];
    if (!a) return;
    if (a.missing) return void missing.push(test);
    rows.push(...a.cases.rows.filter((row) => !only || only.includes(row.id)));
    usd += a.cases.usd;
    bars[test] = a.cases.bar;
  });
  return { rows, usd, bars, missing };
}

/** `numbers` and the mirror question each of them counts on, in order, each once. */
export function withMirrors(numbers, questions) {
  const mirrors = numbers.map((n) => questions.find((q) => q.n === n)?.mirror ?? null).filter((n) => n !== null);
  return [...new Set([...numbers, ...mirrors])];
}

/** The core area: the core set and the simple asks. */
export const runCore = (tree, options) => runTests(tree, CORE_TESTS, options);
