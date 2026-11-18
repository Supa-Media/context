#!/usr/bin/env node
/**
 * `pnpm test` in apps/convex: the Convex suite, or on a pull request only the
 * part of it the change reaches.
 *
 * The whole suite is several hundred files and several minutes across six
 * runners; a texting-assistant change that edits two Convex files waited on
 * all of it.
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
 * Sharded: CI appends `--shard=i/n` to each runner. The runner takes its share
 * of the files, balanced by the durations recorded in
 * `apps/convex/.test-timings.json` (refreshed by scripts/convex-test-timings.mjs),
 * so no shard draws the slow files together. The timings only decide which
 * runner takes a file; they never decide which files run.
 * `CONVEX_TESTS_DRY_RUN=1` prints the shard's files and estimate, and starts
 * nothing.
 *
 * docs/decisions/testing/convex-test-impact.md has the reasoning.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median } from "./convex-test-timings.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONVEX = join(ROOT, "apps/convex");
const TIMINGS = join(CONVEX, ".test-timings.json");
const CONVEX_PREFIX = "apps/convex/";
/** Weight of a file when the timings file has no entry and no median can be taken. */
const UNKNOWN_MS = 1000;

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

/** vitest's own snapshot file for a test, which it reads where no recorder sees. */
const snapshotOf = (test) => join(dirname(test), "__snapshots__", `${test.split("/").at(-1)}.snap`);

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
    if (touched.has(test) || touched.has(snapshotOf(test))) reasons.set(test, "changed");
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

/**
 * The shard flag, exactly `--shard=i/n`, as `{ index, count }`; null when absent.
 * Another spelling of it is an error, not a silent run of the whole suite.
 */
export function parseShard(args) {
  const flags = args.filter((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (flags.length === 0) return null;
  const match = /^--shard=(\d+)\/(\d+)$/.exec(flags[0]);
  if (flags.length > 1 || !match) throw new Error(`unreadable shard flag ${flags.join(" ")}: expected --shard=i/n`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`shard ${index}/${count} is out of range`);
  return { index, count };
}

/** The arguments without the shard flag. */
export function withoutShard(args) {
  return args.filter((arg) => arg !== "--shard" && !arg.startsWith("--shard="));
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Splits `files` (repository paths) across `count` shards by greedy
 * longest-processing-time on recorded milliseconds. `timings` is keyed by path
 * relative to apps/convex. A file with no entry weighs the median of the
 * recorded timings, or UNKNOWN_MS if there are none.
 *
 * Heaviest files go first (ties by path), each to the currently lightest shard
 * (ties to the lowest index), so every runner computes the same split. Returns
 * one `{ files, ms }` per shard, shard 1 first, each `files` sorted; every
 * input file is on exactly one shard.
 */
export function balanceShards(files, timings, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer: ${count}`);
  const fallback = median(Object.values(timings)) ?? UNKNOWN_MS;
  const weighed = files.map((file) => {
    const key = file.startsWith(CONVEX_PREFIX) ? file.slice(CONVEX_PREFIX.length) : file;
    return { file, ms: Object.hasOwn(timings, key) ? timings[key] : fallback };
  });
  weighed.sort((a, b) => b.ms - a.ms || byPath(a.file, b.file));

  const shards = Array.from({ length: count }, () => ({ files: [], ms: 0 }));
  for (const { file, ms } of weighed) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.ms < lightest.ms) lightest = shard;
    lightest.files.push(file);
    lightest.ms += ms;
  }
  for (const shard of shards) shard.files.sort(byPath);
  return shards;
}

/** The files shard `index` (1-based) of `count` runs, from `balanceShards`. */
export function balanceShard(files, timings, index, count) {
  if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`shard ${index} is not in 1..${count}`);
  return balanceShards(files, timings, count)[index - 1].files;
}

function readTimings() {
  return existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, "utf8")) : {};
}

const abs = (file) => join(ROOT, file);
const dryRun = () => process.env.CONVEX_TESTS_DRY_RUN === "1";

function vitest(args) {
  if (dryRun()) {
    console.log(`CONVEX_TESTS_DRY_RUN=1: not starting vitest with ${args.length} argument(s).`);
    process.exit(0);
  }
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], { cwd: CONVEX, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

/**
 * Runs vitest over `files` (repository paths; null for the whole suite) with
 * `args`. With `--shard=i/n` it runs only this shard's balanced share. Always
 * exits the process.
 */
function run(args, files) {
  const shard = parseShard(args);
  if (shard === null) return vitest(files === null ? args : [...files.map(abs), "--passWithNoTests", ...args]);

  const all = files ?? testFiles();
  const { index, count } = shard;
  const { files: mine, ms } = balanceShards(all, readTimings(), count)[index - 1];
  console.log(
    `Shard ${index}/${count}: ${mine.length} of ${all.length} Convex test files, about ${(ms / 1000).toFixed(1)}s by recorded timings.`,
  );
  if (dryRun()) {
    for (const file of mine) console.log(`  ${file}`);
    process.exit(0);
  }
  // With no file arguments vitest runs everything, so an empty share must not reach it.
  if (mine.length === 0) {
    console.log("Nothing for this shard: more shards than files. A pass, not an error.");
    process.exit(0);
  }
  // Sharded, a runner can get none of a short list; that is a pass, not an error.
  vitest([...mine.map(abs), "--passWithNoTests", ...withoutShard(args)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const changedFile = process.env.CONVEX_TEST_CHANGED;
  if (!changedFile) run(args, null);
  if (!existsSync(changedFile)) {
    console.log("Running the whole Convex suite: no list of changed files.");
    run(args, null);
  }

  const { files, reason, reasons } = selectTests({
    tests: testFiles(),
    map: readMap(process.env.CONVEX_TEST_MAP),
    changes: parseChanged(readFileSync(changedFile, "utf8")),
    filesIn,
  });
  if (files === null) {
    console.log(`Running the whole Convex suite: ${reason}.`);
    run(args, null);
  }
  console.log(`Running ${files.length} of ${testFiles().length} Convex test files this pull request reaches:`);
  for (const file of files) console.log(`  ${file}  (${reasons.get(file)})`);
  if (files.length === 0) {
    console.log("None: nothing a Convex test uses changed. Main runs the whole suite after merge.");
    process.exit(0);
  }
  run(args, files);
}
