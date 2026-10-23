#!/usr/bin/env node
/**
 * `pnpm test` in apps/convex: the Convex suite, or on a pull request only the
 * part of it the change reaches.
 *
 * The whole suite is 545 files and four to six minutes across three runners;
 * a texting-assistant change that edits two Convex files waited on all of it.
 * On pushes to main CI records, per test file, which repository files that
 * test actually ran or read (`apps/convex/testImpact.setup.ts`) and keeps the
 * map in the Actions cache. A pull request restores the newest map and runs:
 *
 *  - every test file the pull request adds or edits, and any the map has
 *    never seen;
 *  - every test whose recorded files include a file the pull request edits,
 *    deletes or renames;
 *  - for a file added, deleted or renamed, every test that listed its
 *    directory or used most of the files in it, which is what a glob over
 *    that directory looks like from outside.
 *
 * Anything it cannot reason about runs everything: no map, no list of
 * changed files, or a change to the schema, the test setup, this script or
 * the install inputs. Main always runs everything, and production deploys a
 * commit only once main's CI passed on it (scripts/production-release.mjs),
 * so a test the selection missed still stops the release.
 *
 * Inputs, set by the reusable CI workflow (`convex-test-map`):
 *   CONVEX_TEST_MAP      the restored map directory, one JSON file per test
 *   CONVEX_TEST_CHANGED  the pull request's `git diff --name-status --no-renames`
 * Neither set (locally, or on main): the whole suite, arguments passed through.
 *
 * docs/decisions/testing/convex-test-impact.md has the reasoning.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONVEX = join(ROOT, "apps/convex");

/** A change to one of these can alter any test, without any test "using" it. */
export const RUN_EVERYTHING = [
  "apps/convex/schema.ts",
  "apps/convex/functions/lib/schema/**",
  "apps/convex/_generated/**",
  "apps/convex/test.setup.ts",
  "apps/convex/testImpact.setup.ts",
  "apps/convex/vitest.config.ts",
  "apps/convex/package.json",
  "apps/convex/tsconfig.json",
  "apps/convex/convex.config.ts",
  "convex.json",
  "scripts/convex-tests.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".npmrc",
  "patches/**",
];

/** Share of a directory's files a test must use to count as globbing it. */
const GLOB_SHARE = 0.5;

const matches = (file, pattern) =>
  pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;

/** `STATUS<TAB>path` lines, as `git diff --name-status --no-renames` prints them. */
export function parseChanged(text) {
  const changes = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [status, path] = line.split("\t");
    if (!status || !path) throw new Error(`unreadable changed-file line: ${JSON.stringify(line)}`);
    changes.push({ status, path });
  }
  return changes;
}

/**
 * Which test files to run, or null for all of them.
 *
 * `tests` are the suite's test files (repository paths), `map` the recorded
 * `{ test, deps }` entries, `changes` the pull request's files, and `filesIn`
 * lists a directory's files now, for the glob rule.
 */
export function selectTests({ tests, map, changes, filesIn }) {
  if (map.length === 0) return { files: null, reason: "no recorded map" };
  const everything = changes.find((change) => RUN_EVERYTHING.some((pattern) => matches(change.path, pattern)));
  if (everything) return { files: null, reason: `${everything.path} can change any test` };

  const known = new Map(map.map((entry) => [entry.test, new Set(entry.deps)]));
  const touched = new Set(changes.map((change) => change.path));
  // `git diff --name-status --no-renames`: M and T edit a file in place; A and
  // D change what a directory holds (a rename is a D and an A).
  const reshaped = changes.filter((change) => change.status !== "M" && change.status !== "T");
  const reshapedDirs = new Set(reshaped.map((change) => dirname(change.path)));
  const dirSize = new Map([...reshapedDirs].map((dir) => [dir, filesIn(dir).length]));

  const reasons = new Map();
  for (const test of tests) {
    if (touched.has(test)) reasons.set(test, "changed");
    else if (!known.has(test)) reasons.set(test, "not in the map yet");
    else {
      const deps = known.get(test);
      const hit = [...touched].find((path) => deps.has(path));
      if (hit) reasons.set(test, `uses ${hit}`);
      else
        for (const dir of reshapedDirs) {
          const inDir = [...deps].filter((dep) => dep === dir || dirname(dep) === dir);
          const listed = deps.has(dir);
          const size = Math.max(dirSize.get(dir), 1);
          if (listed || inDir.length / size >= GLOB_SHARE) {
            reasons.set(test, `reads most of ${dir}/`);
            break;
          }
        }
    }
  }
  return { files: [...reasons.keys()].sort(), reasons };
}

function testFiles(dir = join(CONVEX, "__tests__")) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [relative(ROOT, path)] : [];
  });
}

function readMap(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function filesIn(dir) {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  return readdirSync(absolute).map((name) => join(dir, name));
}

function vitest(args) {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], { cwd: CONVEX, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const changedFile = process.env.CONVEX_TEST_CHANGED;
  if (!changedFile) vitest(args);
  if (!existsSync(changedFile)) {
    console.log("Running the whole Convex suite: no list of changed files.");
    vitest(args);
  }

  const { files, reason, reasons } = selectTests({
    tests: testFiles(),
    map: readMap(process.env.CONVEX_TEST_MAP),
    changes: parseChanged(readFileSync(changedFile, "utf8")),
    filesIn,
  });
  if (files === null) {
    console.log(`Running the whole Convex suite: ${reason}.`);
    vitest(args);
  }
  console.log(`Running ${files.length} of ${testFiles().length} Convex test files this pull request reaches:`);
  for (const file of files) console.log(`  ${file}  (${reasons.get(file)})`);
  if (files.length === 0) {
    console.log("None: nothing a Convex test uses changed. Main runs the whole suite after merge.");
    process.exit(0);
  }
  // Sharded, a runner can get none of a short list; that is a pass, not an error.
  vitest([...files.map((file) => join(ROOT, file)), "--passWithNoTests", ...args]);
}
