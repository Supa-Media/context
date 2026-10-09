// `pnpm ai run` with --fake, on an invented folder in a temp dir: the fluff switch and what
// the result note records. Fake runs spend nothing and need no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "..", "run.mjs");
const execFileAsync = promisify(execFile);

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";
const TEST = "---\nrun_as: Ana\nruns: 1\n---\n\n## 1. When is my dentist appointment?\n\n- kind: lookup\n- must: say Tuesday\n";
const FLUFF = [
  "---",
  "count: 5",
  "seed: 3",
  "from: meetings",
  "name: meeting-{date}.md",
  "dates: 2026-01-05 to 2026-10-01",
  "---",
  "",
  "## Distractors",
  "",
  "- older copy of ../health/dentist.md as dentist-old.md dated 2026-03-02",
  "",
].join("\n");

/** An invented folder with one workspace, a fluff folder, a template bank and one setup. */
async function benchFolder() {
  const dir = await mkdtemp(join(tmpdir(), "bench-run-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm\n",
    "workspaces/ana/meetings/fluff.md": FLUFF,
    "workspaces/_bank/meetings/standup.md": "---\ntitle: Standup\n---\n\nStandup {n}, {word}.\n",
    "tests/texting-assistant.md": TEST,
    "setups/texting-assistant/production.md": SETUP,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

/** Run the fake benchmark and return the result note's front matter, as lines. */
async function runFake(dir, extra = []) {
  const out = join(dir, "result.md");
  await execFileAsync(process.execPath, [RUN, "run", "texting-assistant", "--dir", dir, "--fake", "--out", out, ...extra], {
    timeout: 120000,
  });
  return (await readFile(out, "utf8")).split("\n---\n")[0].split("\n");
}

test("fluff is on by default and the result says how many notes it wrote", async () => {
  const dir = await benchFolder();
  try {
    const head = await runFake(dir);
    assert.ok(head.includes("fluff: on"), head.join("\n"));
    // Five filler notes and the one distractor copy.
    assert.ok(head.includes("fluff_notes: 6"), head.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--no-fluff skips the expansion and the result says so", async () => {
  const dir = await benchFolder();
  try {
    const head = await runFake(dir, ["--no-fluff"]);
    assert.ok(head.includes("fluff: off"), head.join("\n"));
    assert.ok(head.includes("fluff_notes: 0"), head.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--parallel answers the conversations in child processes and assembles the same result", async () => {
  const dir = await benchFolder();
  try {
    const front = await runFake(dir, ["--parallel", "2", "--runs", "2"]);
    const out = await readFile(join(dir, "result.md"), "utf8");
    assert.ok(front.some((line) => line === "runs_per_question: 2"), front.join("\n"));
    const ids = out.match(/^#### \S+$/gm) ?? [];
    assert.equal(ids.length, 2 * (out.match(/^### \d+\. /gm) ?? []).length, "every question has both runs");
    assert.ok(!out.includes("Error:"), out.slice(0, 600));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shards cover every conversation exactly once, and the shard count has a ceiling", async () => {
  const { parallelFor, shardJobs } = await import("../run.mjs");
  const jobs = Array.from({ length: 10 }, (_, k) => ({ k }));
  const shards = [0, 1, 2].map((index) => shardJobs(jobs, index, 3));
  assert.deepEqual(shards.map((s) => s.length), [4, 3, 3]);
  assert.deepEqual(shards.flat().map((j) => j.k).sort((a, b) => a - b), jobs.map((j) => j.k));
  assert.equal(parallelFor({}, 708), 6, "up to six processes by default");
  assert.equal(parallelFor({ fake: true }, 708), 1, "a fake run stays in one process unless asked");
  assert.equal(parallelFor({ parallel: "4" }, 708), 4);
  assert.equal(parallelFor({ parallel: "12" }, 5), 5, "never more shards than conversations");
});
