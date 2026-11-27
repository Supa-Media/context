#!/usr/bin/env node
/**
 * The test files a branch's change reaches, run by `pnpm precheck`
 * (scripts/precheck.mjs), so a red suite shows before the push and not after
 * CI has been waited on.
 *
 * Three suites, each selected by its own rule and run only when a changed file
 * can reach it. Nothing here runs a full suite; a suite whose tests a change
 * does not reach is skipped, and the whole run is quick when nothing reaches any.
 *
 *  - gateway (apps/mcp): one import graph built from `test/unit.list`, read
 *    with the same import rules as scripts/import-reach.mjs. A test is reached
 *    when a changed file is in its import closure; the distance is the number
 *    of import hops, and the nearest tests run first.
 *  - mobile (apps/mobile): the change must touch a path in the mobile change
 *    filter in .github/workflows/ci.yml (the list that decides whether CI runs
 *    the mobile job at all); then jest asks which tests relate to the changed
 *    source files.
 *  - convex (apps/convex): the same filter for the convex job, then
 *    `vitest list --changed` for the tests that import a changed module.
 *
 * Caps: a change that reaches more tests than a suite's cap runs the nearest
 * ones here and leaves the rest to CI. The caps keep the local time bounded:
 * CI runs every test selected here, and it is the place that proves the rest.
 *
 * Changed files are the working tree against the merge-base (which includes
 * uncommitted edits) plus untracked files, so a test is selected before its
 * change is committed.
 *
 * The selection cannot see every dependency. A test that reads a fixture by
 * path, or a file loaded by computed path, is not linked to that fixture here;
 * CI, which runs every selected test and the rest of its suite, still catches
 * such a change.
 *
 *   node scripts/precheck-tests.mjs [--root <dir>] [--base <sha>] [--dry-run]
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changeFilter, matches, workspacePaths } from "./check-ci-path-gates.mjs";
import { appPackages, importsOf } from "./import-reach.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY = "apps/mcp";
const MOBILE = "apps/mobile";
const CONVEX = "apps/convex";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Most tests a suite runs here (measured 2026-11-27 on four cores: 200 gateway unit files took 121 s, so the
 * gateway cap is 100), after the branch's own changed tests (which
 * always run and are not counted). Each cap bounds the local wall time a
 * precheck can take. A change that reaches more tests than a cap usually
 * touches a widely shared module, so the nearest tests run here and the rest
 * are left to CI, which runs the full suites and proves them there.
 */
export const CAPS = { gateway: 100, mobile: 150, convex: 60 };

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Repository files that differ from `base` (the working tree, so uncommitted edits count), plus untracked files. */
export function changedFiles(root, base) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  // `--no-renames`: a rename is a delete and an add, so both paths are listed.
  const edited = git("diff", "--name-only", "--no-renames", base);
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set([...edited, ...untracked])].sort(byPath);
}

/** `apps/mcp/test/unit.list` as repository paths, in the order the list gives. */
function gatewayTests(root) {
  const listPath = join(root, GATEWAY, "test/unit.list");
  const listed = readFileSync(listPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  return [...new Set(listed)].map((file) => `${GATEWAY}/${file}`);
}

/**
 * The gateway's import graph, built once. `importers` maps a node (a
 * repository file, or a workspace package claimed whole as its `dir/**`
 * pattern) to the files that import it. Every unit test is walked forward
 * once, so each file is read once however many tests share it.
 */
export function gatewayGraph(root) {
  const tests = gatewayTests(root);
  const appsByName = appPackages(root);
  const direct = new Map();
  const pending = [...tests];
  while (pending.length > 0) {
    const file = pending.pop();
    if (direct.has(file) || !existsSync(join(root, file))) continue;
    const imports = importsOf(file, root, appsByName);
    const patterns = new Set();
    for (const name of imports.packages) {
      try {
        for (const pattern of workspacePaths([name], root)) patterns.add(pattern);
      } catch {
        // A published package that is not a workspace member: nothing of ours to depend on.
      }
    }
    direct.set(file, { files: imports.files, patterns: [...patterns] });
    pending.push(...imports.files);
  }

  const importers = new Map();
  const add = (node, file) => {
    if (!importers.has(node)) importers.set(node, new Set());
    importers.get(node).add(file);
  };
  for (const [file, { files, patterns }] of direct) {
    for (const dep of files) add(dep, file);
    for (const pattern of patterns) add(pattern, file);
  }
  return { tests, importers };
}

/**
 * Walks the graph backwards from every changed file (and every package a
 * changed file sits in) and reports the unit tests that reach one. A changed
 * test is at distance 0; an importer one hop further, and so on.
 */
export function selectGateway({ root, changed, graph = gatewayGraph(root) }) {
  const distance = new Map();
  const queue = [];
  const seed = (node) => {
    if (distance.has(node)) return;
    distance.set(node, 0);
    queue.push(node);
  };
  const packageNodes = [...graph.importers.keys()].filter((node) => node.endsWith("/**"));
  for (const file of changed) {
    seed(file);
    for (const node of packageNodes) if (matches(file, node)) seed(node);
  }
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const importer of graph.importers.get(node) ?? []) {
      if (distance.has(importer)) continue;
      distance.set(importer, distance.get(node) + 1);
      queue.push(importer);
    }
  }
  const tests = graph.tests
    .filter((file) => distance.has(file) && existsSync(join(root, file)))
    .map((file) => ({ file, distance: distance.get(file) }))
    .sort((a, b) => a.distance - b.distance || byPath(a.file, b.file));
  return { tests, total: graph.tests.length };
}

/** Does any changed file fall under this suite's path list in ci.yml's change-filters? */
function reachesSuite(root, suite, changed) {
  const yamlPath = join(root, CI_WORKFLOW);
  if (!existsSync(yamlPath)) throw new Error(`${CI_WORKFLOW} is missing, so the ${suite} change filter cannot be read`);
  const filter = changeFilter(readFileSync(yamlPath, "utf8"), suite);
  return changed.filter((file) => [...filter].some((pattern) => matches(file, pattern)));
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** Repository-relative path of a file a test tool printed, absolute or relative to `cwd`. */
const toRepo = (root, cwd, printed) => relative(root, isAbsolute(printed) ? printed : join(cwd, printed)).replaceAll("\\", "/");

/**
 * The mobile tests related to the branch's changed source files, through jest's
 * own dependency walk. Only a change that touches the mobile filter's paths
 * asks jest at all; the answer is repository-relative test paths.
 */
export function selectMobile({ root, changed }) {
  if (!existsSync(join(root, MOBILE))) return { tests: [], skipped: `${MOBILE} is not in this checkout` };
  if (reachesSuite(root, "mobile", changed).length === 0) return { tests: [], skipped: "no changed file reaches it" };
  const sources = changed.filter((file) => SOURCE.test(file) && isFile(join(root, file)));
  if (sources.length === 0) return { tests: [], skipped: "only non-source files it reads changed" };
  const result = spawnSync("pnpm", ["exec", "jest", "--listTests", "--findRelatedTests", ...sources.map((file) => join(root, file))], {
    cwd: join(root, MOBILE),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`jest could not list the related tests: ${(result.stderr || "").trim() || `exit ${result.status}`}`);
  const tests = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => SOURCE.test(line))
    .map((line) => toRepo(root, join(root, MOBILE), line))
    .filter((file) => isFile(join(root, file)));
  return { tests: [...new Set(tests)].sort(byPath) };
}

/**
 * The Convex tests that import a changed module, through vitest's module graph
 * (`vitest list --changed`, which compares against the merge-base).
 */
export function selectConvex({ root, base, changed }) {
  if (!existsSync(join(root, CONVEX))) return { tests: [], skipped: `${CONVEX} is not in this checkout` };
  if (reachesSuite(root, "convex", changed).length === 0) return { tests: [], skipped: "no changed file reaches it" };
  const result = spawnSync("pnpm", ["exec", "vitest", "list", "--changed", base, "--filesOnly"], {
    cwd: join(root, CONVEX),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`vitest could not list the changed tests: ${(result.stderr || "").trim() || `exit ${result.status}`}`);
  // A Convex change that reaches no test lists nothing, which is a real answer and not a failure.
  const tests = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\.test\.ts$/.test(line))
    .map((line) => toRepo(root, join(root, CONVEX), line))
    .filter((file) => file.startsWith(`${CONVEX}/`) && isFile(join(root, file)));
  // vitest reads git's tracked changes, so a test file not yet added would be missed: the branch's own test files always count.
  const own = changed.filter((file) => file.startsWith(`${CONVEX}/`) && /\.test\.ts$/.test(file) && isFile(join(root, file)));
  return { tests: [...new Set([...tests, ...own])].sort(byPath) };
}

const tokens = (text) =>
  text
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);

/** How alike a test is to the branch's changes: shared name words, then shared leading folders. */
function similarity(file, changed) {
  const name = new Set(tokens(basename(file).replace(/\.[^.]+$/, "").replace(/\.test$/, "")));
  const dirs = file.split("/").slice(0, -1);
  let nameScore = 0;
  let dirScore = 0;
  for (const other of changed) {
    const sharedWords = new Set(tokens(other).filter((token) => name.has(token)));
    nameScore = Math.max(nameScore, sharedWords.size);
    const otherDirs = other.split("/").slice(0, -1);
    let common = 0;
    while (common < dirs.length && common < otherDirs.length && dirs[common] === otherDirs[common]) common++;
    dirScore = Math.max(dirScore, common);
  }
  return { nameScore, dirScore };
}

/**
 * Which tests run under a cap. A test the branch itself changed or added always
 * runs and is not counted against the cap. The rest are ordered nearest first:
 * import distance where known (unknown ranks last), then the most shared name
 * words with a changed file, then the most shared leading folders, then path.
 * `tests` are repository paths or `{ file, distance }`; `left` counts the
 * reached tests not run.
 */
export function rankAndCap(tests, changed, cap) {
  const best = new Map();
  for (const test of tests) {
    const { file, distance } = typeof test === "string" ? { file: test, distance: undefined } : test;
    const known = distance ?? Infinity;
    if (!best.has(file) || known < best.get(file)) best.set(file, known);
  }
  const changedSet = new Set(changed);
  const own = [...best.keys()].filter((file) => changedSet.has(file));
  const rest = [...best.keys()]
    .filter((file) => !changedSet.has(file))
    .map((file) => ({ file, distance: best.get(file), ...similarity(file, changed) }))
    .sort(
      (a, b) =>
        compare(a.distance, b.distance) ||
        b.nameScore - a.nameScore ||
        b.dirScore - a.dirScore ||
        byPath(a.file, b.file),
    );
  const kept = rest.slice(0, cap).map((test) => test.file);
  return { run: [...own, ...kept].sort(byPath), left: rest.length - kept.length };
}

/** The base to diff against: BASE_SHA when precheck set it, else the merge-base with origin/main, else main. */
function defaultBase(root) {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  try {
    return execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "main";
  }
}

/** Starts a runner with its output inherited; resolves to its exit code. */
function runInherit(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Runs the three suites one after another (each runner already uses every
 * core, and precheck runs this beside its typecheck). Prints one line per suite
 * saying what it reached and ran, and returns 1 when a suite that ran failed or
 * could not select its tests, else 0.
 */
export async function main({ root = ROOT, base, dryRun = false, log = (line) => console.log(line) } = {}) {
  const diffBase = base ?? defaultBase(root);
  const changed = changedFiles(root, diffBase);
  const failed = [];

  const report = (name, { reached, total, run, left, skipped, distances = new Map() }) => {
    if (skipped) {
      log(`precheck tests: ${name} — skipped: ${skipped}`);
      return false;
    }
    const of = total === undefined ? `${reached.length} test files reached` : `${reached.length} of ${total} test files reached`;
    const more = left > 0 ? `, ${left} more reached are left to CI` : "";
    log(`precheck tests: ${name} — ${of}, running ${run.length}${more}`);
    if (dryRun) {
      for (const file of run) {
        const hops = distances.get(file);
        log(hops === undefined ? `  ${file}` : `  ${file}  (${hops} import ${hops === 1 ? "hop" : "hops"})`);
      }
    }
    return true;
  };

  const suites = [
    {
      name: "gateway",
      cap: CAPS.gateway,
      select() {
        if (!existsSync(join(root, GATEWAY))) return { skipped: `${GATEWAY} is not in this checkout` };
        const { tests, total } = selectGateway({ root, changed });
        if (tests.length === 0) return { skipped: "no changed file reaches it" };
        return { reached: tests, total };
      },
      runner: (files) => runInherit(process.execPath, ["test/run.mjs", "unit", "--only", ...files.map((file) => file.slice(GATEWAY.length + 1))], join(root, GATEWAY)),
    },
    {
      name: "mobile",
      cap: CAPS.mobile,
      select() {
        const { tests, skipped } = selectMobile({ root, changed });
        return skipped ? { skipped } : { reached: tests };
      },
      runner: (files) => runInherit("pnpm", ["exec", "jest", "--runTestsByPath", ...files.map((file) => file.slice(MOBILE.length + 1))], join(root, MOBILE)),
    },
    {
      name: "convex",
      cap: CAPS.convex,
      select() {
        const { tests, skipped } = selectConvex({ root, base: diffBase, changed });
        return skipped ? { skipped } : { reached: tests };
      },
      runner: (files) =>
        runInherit("pnpm", ["exec", "vitest", "run", ...files.map((file) => file.slice(CONVEX.length + 1)), "--passWithNoTests"], join(root, CONVEX)),
    },
  ];

  for (const suite of suites) {
    let picked;
    try {
      picked = suite.select();
    } catch (error) {
      log(`precheck tests: ${suite.name} — could not select its tests: ${error instanceof Error ? error.message : error}`);
      failed.push(suite.name);
      continue;
    }
    if (picked.skipped) {
      report(suite.name, { skipped: picked.skipped });
      continue;
    }
    // The reached list is what the reach rules returned; the cap decides what runs here.
    const { run, left } = rankAndCap(picked.reached, changed, suite.cap);
    const distances = new Map(picked.reached.filter((test) => typeof test !== "string").map((test) => [test.file, test.distance]));
    const shown = report(suite.name, { reached: picked.reached, total: picked.total, run, left, distances });
    if (!shown || dryRun) continue;
    const started = Date.now();
    const code = await suite.runner(run);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`precheck tests: ${suite.name} ${code === 0 ? "passed" : "failed"} in ${seconds}s`);
    if (code !== 0) failed.push(suite.name);
  }

  if (failed.length) {
    log(`precheck tests: ${failed.join(", ")} failed.`);
    return 1;
  }
  return 0;
}

function parseArgs(argv) {
  const options = { root: ROOT, base: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--root" || arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} takes a value`);
      if (arg === "--root") options.root = resolve(value);
      else options.base = value;
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}; usage: [--root <dir>] [--base <sha>] [--dry-run]`);
  }
  if (!existsSync(options.root)) throw new Error(`--root ${options.root} does not exist`);
  return options;
}

// Node realpaths `argv[1]` for a symlinked launch, so compare realpaths, not strings.
function isDirectRun(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
  main(options).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`precheck tests: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    },
  );
}
