/**
 * Which benchmark folder a command reads: `--dir`, then `$AI_BENCH_DIR`, then
 * the repository's own copy. The GitHub Action and a bare checkout run with
 * neither set, so the default has to be a folder that exists and loads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { REPO_BENCH_FOLDER, benchFolder } from "../folder.mjs";
import { readBenchFolder } from "../load.mjs";

test("--dir wins, then AI_BENCH_DIR, then the repository's bench/ai", () => {
  assert.equal(
    benchFolder({ dir: "/elsewhere" }, { AI_BENCH_DIR: "/env" }),
    "/elsewhere",
  );
  assert.equal(benchFolder({}, { AI_BENCH_DIR: "/env" }), "/env");
  assert.equal(benchFolder({}, {}), REPO_BENCH_FOLDER);
  assert.ok(REPO_BENCH_FOLDER.endsWith(join("bench", "ai")));
});

test("the repository's folder exists, loads, and holds the texting-assistant test and setups", async () => {
  assert.ok(existsSync(REPO_BENCH_FOLDER), REPO_BENCH_FOLDER);
  const bench = await readBenchFolder(REPO_BENCH_FOLDER);
  assert.ok(
    Object.keys(bench.workspaces).length >= 9,
    "nine invented workspaces",
  );
  assert.ok(bench.tests["texting-assistant"], "the texting-assistant test");
  assert.ok(
    existsSync(join(REPO_BENCH_FOLDER, "setups", "texting-assistant")),
    "setups for the job",
  );
});
