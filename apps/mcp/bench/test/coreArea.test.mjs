/**
 * The replay gate's core area (`bench/coreArea.mjs`; Dev2, 2026-11-13): the core set and the simple asks answered by
 * a tree's own code, judged, and read back as one row per question. Fake runs: a scripted model and a scripted judge,
 * nothing spent.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `coreCases` counting a question right when any run passed -> "a question is right only when every run passed" fails;
 *  2. `coreCases` holding a target question to the test's bar -> "a target is reported, never held to the bar" fails;
 *  3. `runTests` ignoring `only` -> "only the named cases run again" fails.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { caseId, coreCases, runTests } from "../coreArea.mjs";

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

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "core-area-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "tests/core.md": CORE,
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
  assert.equal(first.bars.core.goodEnough, true, "a target is reported, never held to the bar");

  const again = await runTests(TREE, ["core"], { dir, fake: true, scratch, tag: "branch-2", only: ["core/q2"], runs: 2 });
  assert.deepEqual(again.rows.map((row) => [row.id, row.results]), [["core/q2", [false, false]]], "only the named cases run again");
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
