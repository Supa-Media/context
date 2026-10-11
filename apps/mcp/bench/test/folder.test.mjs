/**
 * Which benchmark folder a command reads: `--dir`, then `$AI_BENCH_DIR`, then
 * the repository's own copy. The GitHub Action and a bare checkout run with
 * neither set, so the default has to be a folder that exists and loads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
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

test("the repository's folder exists, loads, and holds the tests; the setups are pulled from Context", async () => {
  assert.ok(existsSync(REPO_BENCH_FOLDER), REPO_BENCH_FOLDER);
  const bench = await readBenchFolder(REPO_BENCH_FOLDER);
  assert.ok(
    Object.keys(bench.workspaces).length >= 9,
    "nine invented workspaces",
  );
  assert.ok(bench.tests["texting-assistant"], "the texting-assistant test");
  assert.ok(bench.tests.search, "the search test");
  // Decided 2026-10-10: a setup is edited and promoted in `@context-lc ai/`,
  // so none is committed here; `pnpm ai pull <job>` fills setups/<job>/ before
  // a run, and git ignores what it writes.
  const ignored = readFileSync(join(REPO_BENCH_FOLDER, "..", "..", "..", "..", ".gitignore"), "utf8");
  assert.match(ignored, /^apps\/mcp\/bench\/ai\/setups\/$/m, "setups/ is ignored by git");
});
