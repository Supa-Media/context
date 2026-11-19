/**
 * The replay gate's core area (`bench/coreArea.mjs`; Dev2, 2026-11-13): the core set and the simple asks answered by
 * a tree's own code, judged, and read back as one row per question. Fake runs: a scripted model and a scripted judge,
 * nothing spent.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `coreCases` counting a question right when any run passed -> "a question is right only when every run passed" fails;
 *  2. `coreCases` holding a target question to the test's bar -> "a target is reported, never held to the bar" fails;
 *  3. `runTests` ignoring `only` -> "only the named cases run again" fails;
 *  4. `runTests` rerunning a question without its mirror -> "a rerun asks a question's mirror too" fails.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { caseId, coreCases, failureReason, runTests, withMirrors } from "../coreArea.mjs";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";
// The fake model answers "Fake answer to: <their text>", and the fake judge passes a line sharing a long word with it.
const CORE = [
  "---",
  "run_as: Ana",
  "runs: 1",
  "good_enough:",
  "  score: 100%",
  "  price: under $1 a question",
  "  speed: under 90 s",
  "  texts: 4 or fewer",
  "---",
  "",
  "## 1. Remind me about the dentist",
  "",
  "- kind: task",
  '- person starts: "remind me about the dentist"',
  "- must: report the matches it found",
  "",
  "## 2. Book the plumber",
  "",
  "- kind: task",
  '- person starts: "book the plumber"',
  "- must: confirm Thursday",
  "- target: books before checking the calendar",
  "",
].join("\n");

async function folder(core = CORE) {
  const dir = await mkdtemp(join(tmpdir(), "core-area-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "tests/core.md": core,
    "setups/texting-assistant/production.md": SETUP,
    "setups/texting-assistant/experiment.md": SETUP,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

test("a case id names its test and question", () => {
  assert.deepEqual(caseId("simple-asks/q12"), { test: "simple-asks", n: 12 });
  assert.equal(caseId("held-out/x"), null);
});

test("the core area answers in the tree's own code, as production alone, and reads one row a question", async () => {
  const dir = await folder();
  const scratch = await mkdtemp(join(tmpdir(), "core-scratch-"));
  const first = await runTests(TREE, ["core", "simple-asks"], { dir, fake: true, scratch, tag: "branch-1" });
  assert.deepEqual(first.missing, ["simple-asks"], "a test the folder lacks is named, not invented");
  assert.deepEqual(first.rows.map((row) => [row.id, row.right, row.results.length]), [["core/q1", true, 1], ["core/q2", false, 1]], "production alone answered, once a question");
  assert.equal(first.rows[1].target, "books before checking the calendar");
  // Each row says what its turn did (`turnSteps.mjs`), through the run, the result note and the reading back.
  assert.match(first.rows[0].steps ?? "", /^tools .*\| outcome: replied$/, "the steps line reaches the row");
  assert.equal(first.bars.core.goodEnough, true, "a target is reported, never held to the bar");

  const again = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "branch-2", only: ["core/q2"], runs: 2 });
  assert.deepEqual(again.rows.map((row) => [row.id, row.results]), [["core/q2", [false, false]]], "only the named cases run again");
});

test("tests run several at once and read back in the tests' order, the same as one at a time", async () => {
  const dir = await folder();
  const scratch = await mkdtemp(join(tmpdir(), "core-scratch-"));
  const serial = await runTests(TREE, ["simple-asks", "core"], { dir, fake: true, scratch, tag: "serial" });
  const together = await runTests(TREE, ["simple-asks", "core"], { dir, fake: true, scratch, tag: "together", parallel: 3 });
  assert.deepEqual(together.missing, serial.missing);
  assert.deepEqual(together.rows.map((row) => [row.id, row.right]), serial.rows.map((row) => [row.id, row.right]));
  assert.deepEqual(Object.keys(together.bars), ["core"]);
});

test("a question is right only when every run passed", async () => {
  const dir = await folder();
  const scratch = await mkdtemp(join(tmpdir(), "core-scratch-"));
  const both = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "twice", only: ["core/q1"], runs: 2 });
  assert.deepEqual(both.rows.map((row) => [row.id, row.right, row.results]), [["core/q1", true, [true, true]]]);
  // The same round with its second run judged a fail.
  const resultRaw = await readFile(join(scratch, "core-core-twice.md"), "utf8");
  const at = resultRaw.lastIndexOf("| pass |");
  const flipped = `${resultRaw.slice(0, at)}| fail |${resultRaw.slice(at + "| pass |".length)}`;
  const keyRaw = await readFile(join(scratch, "core-core-twice key.md"), "utf8");
  const cases = coreCases({ test: "core", testRaw: CORE, resultRaw: flipped, keyRaw });
  assert.deepEqual(cases.rows.map((row) => [row.id, row.right, row.results]), [["core/q1", false, [true, false]]]);
  assert.equal(cases.bar.goodEnough, false, "a failed run of a held case fails the bar");
});

test("a rerun asks a question's mirror too, so the question is still counted", async () => {
  // Question 3 counts only when question 1, its mirror, passes (as core/q13 counts on q14). Rerun alone, it read as
  // untested, its row vanished, and the gate took one failed first run for a new case that failed (2026-11-13).
  const mirrored = `${CORE}\n## 3. Remind me about the dentist again\n\n- kind: task\n- person starts: "remind me about the dentist again"\n- must: report the matches it found\n- mirror: 1\n`;
  const dir = await folder(mirrored);
  const scratch = await mkdtemp(join(tmpdir(), "core-scratch-"));
  const again = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "mirror", only: ["core/q3"], runs: 2 });
  assert.deepEqual(again.rows.map((row) => [row.id, row.results]), [["core/q3", [true, true]]], "the question is counted, and only it is reported");
  assert.deepEqual(withMirrors([3, 2], [{ n: 1, mirror: null }, { n: 2, mirror: null }, { n: 3, mirror: 1 }]), [3, 2, 1]);
});

// gw Lab runs, 2026-11-18: every Claude call failed for lack of credit, and the row's reason was execFile's own message,
// the ~190-character command line, cut at 200. Sabotage: throw the exec error as it is, and this fails.
test("a step that fails says which step and why from its stderr, never its command line or a secret", async () => {
  const dir = await folder();
  const scratch = await mkdtemp(join(tmpdir(), "core-scratch-"));
  const command = `Command failed: ${process.execPath} ${join(TREE, "apps/mcp/bench/run.mjs")} judge ${join(scratch, "core-core-x.md")} --dir ${dir} --max-usd 1`;
  const stderr = [
    "Judge calls: through the AI gateway",
    "1 judge requests to claude-haiku-5-5, about 1,000 tokens in, about $0.01; 0 unanswered skipped",
    "retrying with Authorization: Bearer abc.def-123 after error",
    "judge call for question 1 failed: status 400 (Your credit balance is too low to access the Anthropic API. key sk-ant-api03-XyZ_9)",
    "",
  ].join("\n");
  const calls = [];
  const exec = async (_node, args) => {
    calls.push(args[1]);
    if (args[1] !== "judge") return { stdout: "", stderr: "" };
    throw Object.assign(new Error(command), { code: 1, stderr });
  };
  const error = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "x", exec }).catch((e) => e);
  assert.deepEqual(calls, ["run", "judge"]);
  assert.match(error.message, /^judge failed: /);
  assert.match(error.message, /status 400 \(Your credit balance is too low/);
  assert.ok(error.message.length <= "judge failed: ".length + 300, "the reason is at most 300 characters");
  assert.doesNotMatch(error.message, /Command failed|run\.mjs|--max-usd/, "never the command line");
  assert.doesNotMatch(error.message, /abc\.def|sk-ant|XyZ/, "never a token or key");
  assert.doesNotMatch(error.message, /Judge calls|judge requests/, "only the lines that name a failure");
  const answer = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "y", exec: async () => Promise.reject(Object.assign(new Error(command), { code: 1, stderr: "" })) }).catch((e) => e);
  assert.equal(answer.message, "answer failed: exit 1, no output");
});

test("a failure reason keeps the last telling lines within 300 characters", () => {
  const long = Array.from({ length: 20 }, (_, k) => `q${k} failed: status 500 ${"x".repeat(40)}`).join("\n");
  const reason = failureReason({ stderr: long });
  assert.ok(reason.length <= 300);
  assert.match(reason, /q19 failed/, "the last line is kept");
  assert.equal(failureReason({ stderr: `${"y".repeat(400)} error` }).length, 300);
  assert.equal(failureReason({ stderr: "just one line\n" }), "just one line", "a stderr with no telling line keeps its last");
});
