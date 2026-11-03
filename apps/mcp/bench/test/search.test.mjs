/**
 * The search benchmark (`bench/search.mjs`): a query's hits read back from
 * `search_notes`'s answer, the rank of the first expected note, the scores
 * per setup, and the command end to end on an invented folder with --fake.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { readBenchFolder } from "../load.mjs";
import { hitsOf, rankOf, scoreSearch, searchBars } from "../search.mjs";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "..", "run.mjs");
const execFileAsync = promisify(execFile);

test("the paths in an answer are read in order, each named with its workspace", () => {
  const text = [
    "3 matching notes",
    "",
    "health/dentist.md",
    "    Appointment: Tuesday",
    "@brand/todo.md",
    "    (Same topic, different words)",
    "    order twill",
    "notes/filler-1.md",
    "    Filler",
    "",
    'A path that starts with @name/ is in that workspace: pass context: "@name" with its path to read_note, or to any other tool, to reach it.',
  ].join("\n");
  assert.deepEqual(hitsOf(text, "@maya"), ["@maya/health/dentist.md", "@brand/todo.md", "@maya/notes/filler-1.md"]);
  assert.deepEqual(hitsOf("(no matches)\n\nA miss usually means the wrong word", "@maya"), []);
});

test("the rank is the first expected note's place, or null", () => {
  const hits = ["@maya/a.md", "@brand/b.md", "@maya/c.md"];
  assert.equal(rankOf(hits, ["@maya/c.md"]), 3);
  assert.equal(rankOf(hits, ["@brand/b.md", "@maya/c.md"]), 2);
  assert.equal(rankOf(hits, ["@maya/zzz.md"]), null);
  assert.equal(rankOf([], ["@maya/a.md"]), null);
});

test("a setup is scored on found, top three, MRR and complete, against the test's bars", () => {
  const setups = [{ name: "a", search: {} }, { name: "b", search: {} }];
  const records = [
    { setup: "a", question: 1, expected: ["@m/x.md"], hits: ["@m/x.md"], rank: 1, ms: 10 },
    { setup: "a", question: 2, expected: ["@m/y.md", "@m/z.md"], hits: ["@m/q.md", "@m/y.md"], rank: 2, ms: 30 },
    { setup: "a", question: 3, expected: ["@m/w.md"], hits: ["@m/q.md"], rank: null, ms: 20 },
    { setup: "b", question: 1, expected: ["@m/x.md"], hits: ["@m/x.md"], rank: 1, ms: 10 },
    { setup: "b", question: 2, expected: ["@m/y.md", "@m/z.md"], hits: ["@m/y.md", "@m/z.md"], rank: 1, ms: 10 },
    { setup: "b", question: 3, expected: ["@m/w.md"], hits: ["@m/w.md"], rank: 1, ms: 10 },
  ];
  const [a, b] = scoreSearch(records, setups, searchBars({ found: "90%", top3: "85%" }));
  assert.equal(a.found, 2);
  assert.equal(a.first, 1, "only question 1 had an expected note first");
  assert.equal(a.top3, 2);
  assert.equal(a.complete, 1, "question 2 wanted two notes and got one");
  assert.ok(Math.abs(a.mrr - (1 + 0.5 + 0) / 3) < 1e-9);
  assert.equal(a.goodEnough, false);
  assert.equal(b.found, 3);
  assert.equal(b.first, 3);
  assert.equal(b.complete, 3);
  assert.equal(b.goodEnough, true);
  assert.deepEqual(searchBars({}), { found: null, first: null, top3: null });
});

test("the first bar is read from good_enough, and a test that sets none is not held to one", () => {
  assert.deepEqual(searchBars({ found: "90%", first: "70%", top3: "90%" }), { found: 90, first: 70, top3: 90 });
  assert.equal(searchBars({ found: "90%" }).first, null);
  const setups = [{ name: "c", search: {} }];
  const records = [
    { setup: "c", question: 1, expected: ["@m/x.md"], hits: ["@m/x.md"], rank: 1, ms: 10 },
    { setup: "c", question: 2, expected: ["@m/y.md"], hits: ["@m/z.md", "@m/y.md"], rank: 2, ms: 10 },
  ];
  // Found and in the top three are 100%, but only half the first lines are expected notes.
  const [held] = scoreSearch(records, setups, searchBars({ found: "90%", first: "70%", top3: "90%" }));
  assert.equal(held.found, 2);
  assert.equal(held.first, 1);
  assert.equal(held.goodEnough, false);
  const [unheld] = scoreSearch(records, setups, searchBars({ found: "90%", top3: "90%" }));
  assert.equal(unheld.goodEnough, true);
});

const SEARCH_TEST = [
  "---",
  "job: search",
  "run_as: Ana",
  "today: 2026-10-08",
  "good_enough:",
  "  found: 90%",
  "  first: 70%",
  "  top3: 85%",
  "---",
  "",
  "## 1. dentist appointment",
  "",
  "- expect: @ana/health/dentist.md",
  "",
  "## 2. order twill",
  "",
  "- expect: @brand/todo.md",
  "",
  "## 3. twill order, in the brand",
  "",
  "- in: @brand",
  "- expect: @brand/todo.md",
  "",
].join("\n");

async function benchFolder() {
  const dir = await mkdtemp(join(tmpdir(), "bench-search-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n| Ana | brand | owner |\n",
    "workspaces/ana/health/dentist.md": "# Dentist\n\nDentist appointment Tuesday 3 pm\n",
    "workspaces/ana/notes/other.md": "# Other\n\nNothing about teeth.\n",
    "workspaces/brand/todo.md": "# To do\n\n- Order twill from the mill\n",
    "tests/search.md": SEARCH_TEST,
    "setups/search/here.md": "---\njob: search\nsearch:\n  everywhere: false\n---\n\nOne workspace.\n",
    "setups/search/everywhere.md": "---\njob: search\nsearch:\n  everywhere: true\n---\n\nEvery workspace.\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

test("pnpm ai search --fake scores each search setup on an invented folder, and everywhere finds the other workspace's note", async () => {
  const dir = await benchFolder();
  try {
    const out = join(dir, "result.md");
    await execFileAsync(process.execPath, [RUN, "search", "--dir", dir, "--fake", "--out", out], { timeout: 120000 });
    const note = await readFile(out, "utf8");
    assert.match(note, /^job: search$/m);
    assert.match(note, /^status: scored$/m);
    const summary = note.split("## Misses")[0];
    // From Ana's own workspace, q2 cannot be found with everywhere off; q3 names the brand and is found either way.
    const cell = (setup, heading) => {
      const lines = summary.split("\n");
      const columns = lines.find((line) => line.startsWith("| Setup |"))?.split("|").map((c) => c.trim());
      const row = lines.find((line) => line.startsWith(`| ${setup} |`))?.split("|").map((c) => c.trim());
      assert.ok(columns && row, summary);
      return row[columns.indexOf(heading)];
    };
    assert.equal(cell("here", "Found"), "66.7%");
    assert.equal(cell("here", "First"), "66.7%", "q1 and q3 both have an expected note first");
    assert.equal(cell("here", "In top 3"), "66.7%");
    assert.equal(cell("everywhere", "Found"), "100.0%");
    assert.equal(cell("everywhere", "First"), "100.0%");
    assert.equal(cell("everywhere", "In top 3"), "100.0%");
    assert.match(summary, /Bars: found 90%, first 70%, in top 3 85%\./);
    assert.match(note, /### here: 1 missed\n\n- q2 "order twill"/);
    assert.match(note, /### everywhere: 0 missed/);
    assert.match(note, /Best: everywhere\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every expected note in the invented world's search test is a real note, and no distractor is expected", async () => {
  const bench = await readBenchFolder(REPO_BENCH_FOLDER);
  const questions = bench.tests.search.questions;
  assert.ok(questions.length >= 59, "the search test has its questions");
  for (const question of questions) {
    for (const path of question.expect) {
      const match = /^@([^/]+)\/(.+)$/.exec(path);
      assert.ok(match, `q${question.n}: ${path} is not @workspace/path`);
      const [, workspace, rel] = match;
      assert.ok(bench.workspaces[workspace]?.files[rel] !== undefined, `q${question.n}: ${path} is not a note in the world`);
      // Archived sessions and message dumps, saved sessions and search probes are distractors, never answers.
      assert.doesNotMatch(rel, /(^|\/)(archive|sessions|search-probes)\//, `q${question.n}: ${path} is a distractor, not an answer`);
    }
  }
});
