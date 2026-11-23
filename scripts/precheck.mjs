#!/usr/bin/env node
/**
 * The checks that fail a pull request before anything slow starts, run locally
 * before a push (CLAUDE.md). Fast repository guards, the app typecheck, and
 * the architecture check — the three that turned into fix loops after the
 * push (#3544 typecheck and architecture, #3538 and #3532 guards).
 *
 * The guard steps are the `run:` steps of `.github/workflows/fast-guards.yml`
 * (which includes `scripts/tex-diagram-check.mjs`). The Node version line is
 * the only one skipped: it records the runner, it checks nothing. A line that
 * is only `git fetch` of `"$BASE_SHA"` (optional flags, then `origin`, then
 * the ref, nothing chained after it) becomes `:`. CI's checkout is shallow
 * and needs that fetch, but precheck already has the merge-base, and
 * `git fetch --depth` on a full clone writes `.git/shallow` and cuts history
 * there. Deleting the line would leave an empty `then`, which bash rejects.
 * A `git fetch` of `$BASE_SHA` with another command on the same line fails
 * `--self-test`: replacing the whole line would drop that command, and
 * leaving the fetch would shallow the clone.
 * The app typecheck is CI's `mobile-typecheck` job (`pnpm typecheck`
 * in `apps/mobile`, 6 GB heap). The architecture check is CI's
 * `architecture-check: true` on the supa-framework workflow; the command
 * below is that workflow's pull-request step, which does not live in this
 * repository.
 *
 * Needs `pnpm install` already. `BASE_SHA` is the merge-base with origin/main
 * (else main), so the diff guards see this branch's change. `TEX_PR_BODY`,
 * when set, is the pull request description the exemption lines are read
 * from; otherwise `gh pr view` is tried, and an empty description refuses an
 * exemption rather than inventing one.
 *
 *   pnpm precheck
 *   node scripts/precheck.mjs --self-test
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertChainedBaseFetchRefused } from "./precheck-fetch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARDS = join(ROOT, ".github/workflows/fast-guards.yml");
const CI = join(ROOT, ".github/workflows/ci.yml");

/**
 * CI's app typecheck, as a single command. `mobile-typecheck` runs
 * `pnpm typecheck` with `working-directory: apps/mobile` and
 * `NODE_OPTIONS=--max-old-space-size=6144`. The self-test reads that job
 * from `ci.yml`; this string is the same command from the repository root.
 */
export const TYPECHECK = "pnpm --dir apps/mobile typecheck";
export const TYPECHECK_HEAP = "--max-old-space-size=6144";
/**
 * Local run of the architecture check CI turns on with `architecture-check: true`.
 * The argv lives in `Supa-Media/supa-framework/.github/workflows/ci.yml`
 * (`pnpm exec supa-architecture-check --base origin/<base ref>` on a pull
 * request, and the same command without `--base` on a push). This repository
 * only passes the boolean, so the self-test asserts that input and does not
 * compare this string to itself.
 */
export function architectureCommand(baseRef) {
  return `pnpm exec supa-architecture-check --base ${baseRef}`;
}

/** YAML `|` strips the block's common indent; a heredoc terminator has to land in column 0. */
function dedent(lines) {
  const widths = lines.filter((line) => line.trim() !== "").map((line) => line.match(/^ */)?.[0].length ?? 0);
  const strip = widths.length ? Math.min(...widths) : 0;
  return lines.map((line) => line.slice(strip)).join("\n").trim();
}

/**
 * `run:` bodies in a workflow file, in order. A `|` block and a one-line
 * `run:` both count. Comments do not. Block bodies are dedented the way YAML
 * `|` does, so a heredoc terminator stays in column 0.
 * @param {string} text
 * @returns {string[]}
 */
export function runScripts(text) {
  const lines = text.split("\n");
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^(\s*)-?\s*run:\s*\|\s*$/);
    if (block) {
      const indent = block[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() !== "" && lines[j].search(/\S/) <= indent) break;
        body.push(lines[j]);
      }
      const script = dedent(body);
      if (script) scripts.push(script);
      i = j - 1;
      continue;
    }
    const one = lines[i].match(/^\s*-?\s*run:\s*(\S.*)$/);
    if (one && !one[1].startsWith("|")) scripts.push(one[1].trim());
  }
  return scripts;
}

/** Guard steps precheck runs: every `run:` except the runner's `node --version`. */
export function guardScripts(text) {
  return runScripts(text).filter((body) => body !== "node --version");
}

/**
 * `git fetch` of `$BASE_SHA`, `${BASE_SHA}`, or either one in quotes, with
 * nothing after the ref. Flags are `--name` or `--name=value` only.
 * A chained command used to match too, and the whole line became `:`.
 */
const BARE_BASE_FETCH =
  /^\s*git fetch(?:\s+--[A-Za-z0-9][\w-]*(?:=[^\s"'|&;]+)?)*\s+origin\s+(?:"\$\{BASE_SHA\}"|'\$\{BASE_SHA\}'|"\$BASE_SHA"|'\$BASE_SHA'|\$\{BASE_SHA\}|\$BASE_SHA)\s*$/;

/** The old check: any line that starts with `git fetch` and mentions `$BASE_SHA`. */
function isLooseBaseFetch(line) {
  return /^\s*git fetch\b/.test(line) && /\$\{?BASE_SHA\}?/.test(line);
}

/** A `git fetch` of `$BASE_SHA` that shares its line with another command. */
function isEmbeddedBaseShaFetch(line) {
  if (/^\s*#/.test(line) || /^\s*git fetch\b/.test(line)) return false;
  return /\bgit fetch\b/.test(line) && /\$\{?BASE_SHA\}?/.test(line);
}

/** A bare shallow fetch of the base commit. CI needs it; a full clone already has that commit. */
export function isShallowBaseFetch(line) {
  return BARE_BASE_FETCH.test(line);
}

/**
 * The same line with the fetch replaced by `:`. Deleting it leaves `then` /
 * `fi` with an empty list, which bash rejects, so the step would fail closed
 * for a reason that is not the guard.
 */
function neutralizeShallowFetch(line) {
  if (!isShallowBaseFetch(line)) return line;
  return `${line.match(/^\s*/)[0]}:`;
}

/** Guard bodies with those fetches turned into `:`, and every other line left as it was. */
export function scriptsToRun(text) {
  return guardScripts(text).map((body) => body.split("\n").map(neutralizeShallowFetch).join("\n"));
}

/**
 * Node realpaths and percent-encodes `import.meta.url`. `argv[1]` is the path
 * as invoked, so a symlink or a space makes `` `file://${argv}` `` compare
 * unequal and the script exits 0 without running.
 */
export function isDirectRun(moduleUrl, argvPath) {
  if (argvPath == null || argvPath === "") return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

function jobSource(yaml, name) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function stepBlocks(job) {
  const lines = job.split("\n");
  const steps = [];
  let current = null;
  for (const line of lines) {
    if (/^ {6}- /.test(line)) {
      if (current) steps.push(current.join("\n"));
      current = [line];
    } else if (current) current.push(line);
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/**
 * `mobile-typecheck` still runs `pnpm typecheck` in `apps/mobile` with a 6 GB
 * heap, and the `ci` job still passes `architecture-check: true` to
 * supa-framework. The architecture command's argv is not in this repository.
 */
export function assertCi(yaml) {
  const job = jobSource(yaml, "mobile-typecheck");
  if (!job) throw new Error("ci.yml has no mobile-typecheck job");
  const step = stepBlocks(job).find((block) => {
    const lines = block.split("\n").map((line) => line.trim());
    return lines.includes("working-directory: apps/mobile") && lines.includes(`NODE_OPTIONS: ${TYPECHECK_HEAP}`) && lines.includes("run: pnpm typecheck");
  });
  if (!step) {
    throw new Error("mobile-typecheck no longer runs pnpm typecheck in apps/mobile with --max-old-space-size=6144");
  }
  const ci = jobSource(yaml, "ci");
  if (!ci || !ci.includes("uses: Supa-Media/supa-framework/.github/workflows/ci.yml@main")) {
    throw new Error("ci.yml no longer calls Supa-Media/supa-framework/.github/workflows/ci.yml");
  }
  if (!/^ {6}architecture-check: true\s*$/m.test(ci)) throw new Error("ci.yml no longer sets architecture-check: true");
}

const REQUIRED = [
  "scripts/tex-diagram-check.mjs",
  "scripts/tex-wire-check.mjs",
  "scripts/check-tex-change-has-case.mjs",
  "scripts/check-lab-docs-updated.mjs",
  "scripts/check-speed-budget.mjs",
  "scripts/public-privacy.test.mjs",
  "scripts/check-secrets-allowlist.mjs",
];

/** Throws when the parsed steps would no longer be the workflow's guards. */
export function assertGuards(workflowText) {
  const runs = runScripts(workflowText);
  const guards = guardScripts(workflowText);
  if (!runs.includes("node --version")) throw new Error("the Node version step is how the parser proves it saw the file");
  if (guards.some((body) => body === "node --version")) throw new Error("precheck re-runs the Node version line");
  if (guards.length + 1 !== runs.length) throw new Error("precheck skips something other than the Node version line");
  const dropped = runs.filter((body) => !guards.includes(body));
  if (dropped.length !== 1 || dropped[0] !== "node --version") throw new Error("precheck skips something other than the Node version line");
  refuseUnsafeBaseFetches(guards);
  const executed = scriptsToRun(workflowText);
  if (executed.length !== guards.length) throw new Error("precheck dropped a guard while removing the shallow fetch");
  for (let i = 0; i < guards.length; i++) {
    const problem = editBeyondFetch(guards[i], executed[i]);
    if (problem) throw new Error(`precheck edits a guard other than replacing git fetch of $BASE_SHA with ":": ${problem}`);
  }
  if (executed.some((body) => body.split("\n").some(isShallowBaseFetch))) {
    throw new Error('precheck still runs git fetch of "$BASE_SHA"');
  }
  const blob = executed.join("\n");
  const missing = REQUIRED.filter((path) => !blob.includes(path));
  if (missing.length) throw new Error(`precheck dropped ${missing.join(", ")}`);
}

/**
 * A fetch of `$BASE_SHA` that is not bare fails here. Replacing that line
 * with `:` would drop whatever is chained after the fetch, and leaving the
 * fetch in place would shallow a full clone. The loose check is what used
 * to match; it stays so a bare-only `isShallowBaseFetch` is what refuses
 * the line. Widening `isShallowBaseFetch` back to the loose check lets the
 * line through again.
 */
function refuseUnsafeBaseFetches(bodies) {
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const unsafe = (isLooseBaseFetch(line) && !isShallowBaseFetch(line)) || isEmbeddedBaseShaFetch(line);
      if (!unsafe) continue;
      throw new Error(
        `precheck refuses a git fetch of $BASE_SHA that is not only that fetch; replacing the line would discard the rest of it, and running the fetch would shallow the clone: ${line.trim()}`,
      );
    }
  }
}

/** Null when `executed` is `original` with only shallow `$BASE_SHA` fetches replaced by `:`. */
function editBeyondFetch(original, executed) {
  const source = original.split("\n");
  const result = executed.split("\n");
  if (source.length !== result.length) return `line count ${source.length} -> ${result.length}`;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === result[i]) continue;
    const indent = source[i].match(/^\s*/)[0];
    if (isShallowBaseFetch(source[i]) && result[i] === `${indent}:`) continue;
    return source[i];
  }
  return null;
}

function selfTest() {
  const fixture = [
    "# scripts/not-a-step.mjs is a comment, not a step",
    "jobs:",
    "  guards:",
    "    steps:",
    "      - run: node --version",
    "      - run: node scripts/tex-diagram-check.mjs --self-test",
    "      - name: Two",
    "        run: |",
    "          node scripts/check-speed-budget.mjs --self-test",
    "          node scripts/check-speed-budget.mjs",
  ].join("\n");
  const got = guardScripts(fixture);
  if (got.length !== 2) throw new Error(`fixture parsed ${got.length} steps, expected 2`);
  if (got.some((body) => body.includes("not-a-step"))) throw new Error("a comment was parsed as a step");
  if (!got[1].includes("check-speed-budget.mjs --self-test")) throw new Error("a block body was dropped");
  if (/^ /m.test(got[1])) throw new Error("a block body kept its YAML indent");
  let dropped = false;
  try {
    assertGuards(fixture);
  } catch (error) {
    dropped = error instanceof Error && /dropped/.test(error.message);
  }
  if (!dropped) throw new Error("a workflow missing the guard scripts passed");
  assertGuards(readFileSync(GUARDS, "utf8"));
  assertShallowFetchStripped();
  assertChainedBaseFetchRefused(assertGuards, scriptsToRun);
  assertDirectInvocation();
  assertCiDrift();
  const guards = readFileSync(GUARDS, "utf8");
  if (!guards.includes("node scripts/precheck.mjs --self-test")) {
    throw new Error("fast-guards.yml does not run precheck --self-test");
  }
  console.log("ok   precheck self-test");
}

const FETCH_FIXTURE = [
  "jobs:",
  "  guards:",
  "    steps:",
  "      - run: node --version",
  "      - name: Case",
  "        run: |",
  "          git fetch origin main",
  "          node scripts/check-tex-change-has-case.mjs --self-test",
  "          if [ -n \"$BASE_SHA\" ]; then",
  "            git fetch --no-tags --depth=1 origin \"$BASE_SHA\"",
  "            git fetch --depth=1 origin '$BASE_SHA'",
  "            git fetch --depth=1 origin \"${BASE_SHA}\"",
  "            git fetch --depth=1 origin '${BASE_SHA}'",
  "            git fetch origin ${BASE_SHA}",
  "            git fetch origin $BASE_SHA",
  "            git fetch origin \"$BASE_SHA\"",
  "          fi",
  "          node scripts/check-tex-change-has-case.mjs",
].join("\n");

const NEUTRALIZED_FETCHES = [
  'git fetch --no-tags --depth=1 origin "$BASE_SHA"',
  "git fetch --depth=1 origin '$BASE_SHA'",
  'git fetch --depth=1 origin "${BASE_SHA}"',
  "git fetch --depth=1 origin '${BASE_SHA}'",
  "git fetch origin ${BASE_SHA}",
  "git fetch origin $BASE_SHA",
  'git fetch origin "$BASE_SHA"',
];

function assertShallowFetchStripped() {
  const body = scriptsToRun(FETCH_FIXTURE)[0];
  for (const fetch of NEUTRALIZED_FETCHES) {
    if (body.includes(fetch)) throw new Error(`shallow fetch of "$BASE_SHA" still runs: ${fetch}`);
  }
  const colons = body.split("\n").filter((line) => /^\s*:\s*$/.test(line));
  if (colons.length !== NEUTRALIZED_FETCHES.length) {
    throw new Error(`expected ${NEUTRALIZED_FETCHES.length} neutralized fetches, found ${colons.length}`);
  }
  if (!body.includes("git fetch origin main")) throw new Error("a fetch of something other than $BASE_SHA was dropped");
  if (!body.includes('if [ -n "$BASE_SHA" ]; then')) throw new Error("the fetch's if was dropped");
  execFileSync("bash", ["-n"], { input: body });
  if (!/^fi$/m.test(body)) throw new Error("the fetch's fi was dropped");
  if (!body.includes("node scripts/check-tex-change-has-case.mjs --self-test")) throw new Error("the command before the fetch was dropped");
  if (!body.includes("node scripts/check-tex-change-has-case.mjs\n") && !body.endsWith("node scripts/check-tex-change-has-case.mjs")) {
    throw new Error("the command after the fetch was dropped");
  }
  const workflow = readFileSync(GUARDS, "utf8");
  const original = guardScripts(workflow);
  const executed = scriptsToRun(workflow);
  let fetches = 0;
  for (let i = 0; i < original.length; i++) {
    const sourceLines = original[i].split("\n");
    const resultLines = executed[i].split("\n");
    if (sourceLines.length !== resultLines.length) throw new Error("neutralizing a fetch changed a step's line count");
    for (let j = 0; j < sourceLines.length; j++) {
      const source = sourceLines[j];
      const result = resultLines[j];
      if (!source.includes("git fetch") || !source.includes("BASE_SHA")) {
        if (source !== result) throw new Error(`neutralizing a bare fetch changed another line: ${source.trim()}`);
        continue;
      }
      fetches += 1;
      if (!isShallowBaseFetch(source)) throw new Error(`a workflow fetch of $BASE_SHA is not bare: ${source.trim()}`);
      const indent = source.match(/^\s*/)[0];
      if (result !== `${indent}:`) throw new Error(`a bare fetch was not neutralized: ${source.trim()} -> ${JSON.stringify(result)}`);
    }
  }
  if (fetches !== 4) throw new Error(`expected four BASE_SHA fetches in fast-guards.yml, found ${fetches}`);
  assertGuardPhaseLeavesHistory(executed.filter((step, index) => original[index].includes('"$BASE_SHA"')));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFullClone(root) {
  mkdirSync(root, { recursive: true });
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore" });
  git(seed, ["config", "user.email", "precheck@example.com"]);
  git(seed, ["config", "user.name", "precheck"]);
  git(seed, ["config", "commit.gpgsign", "false"]);
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(seed, "f.txt"), `${i}\n`);
    git(seed, ["add", "f.txt"]);
    git(seed, ["commit", "-q", "-m", `c${i}`]);
  }
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, ["config", "user.email", "precheck@example.com"]);
  git(clone, ["config", "user.name", "precheck"]);
  git(clone, ["config", "commit.gpgsign", "false"]);
  git(clone, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(clone, "f.txt"), "feature\n");
  git(clone, ["add", "f.txt"]);
  git(clone, ["commit", "-q", "-m", "feature"]);
  return clone;
}

/** The fetch lines precheck would run, in a throwaway full clone. Node commands become `true` so only the shell runs. */
function assertGuardPhaseLeavesHistory(bodies) {
  const root = mkdtempSync(join(tmpdir(), "precheck-shallow-"));
  try {
    const control = makeFullClone(join(root, "before"));
    const base = git(control, ["merge-base", "HEAD", "origin/main"]);
    const before = Number(git(control, ["rev-list", "--count", "HEAD"]));
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { cwd: control, stdio: "ignore" });
    if (!existsSync(join(control, ".git", "shallow"))) {
      throw new Error("git fetch --depth=1 did not write .git/shallow; the guard test would pass for the wrong reason");
    }
    const cut = Number(git(control, ["rev-list", "--count", "HEAD"]));
    if (cut >= before) throw new Error(`git fetch --depth=1 left history at ${cut} commits`);

    const clone = makeFullClone(join(root, "after"));
    const count = Number(git(clone, ["rev-list", "--count", "HEAD"]));
    const sha = git(clone, ["merge-base", "HEAD", "origin/main"]);
    for (const body of bodies) {
      const command = body.replace(/^\s*node\b.*$/gm, "true");
      execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
        cwd: clone,
        env: { ...process.env, BASE_SHA: sha },
      });
    }
    if (existsSync(join(clone, ".git", "shallow"))) throw new Error("guard phase wrote .git/shallow");
    const after = Number(git(clone, ["rev-list", "--count", "HEAD"]));
    if (after !== count) throw new Error(`guard phase cut history from ${count} commits to ${after}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDirectInvocation() {
  if (isDirectRun(import.meta.url, undefined)) throw new Error("a missing argv path counted as the main module");
  if (isDirectRun(import.meta.url, "")) throw new Error("an empty argv path counted as the main module");
  const own = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const legacy = "import.meta.url === `" + "file://${process.argv[1]}`";
  if (own.includes(legacy)) throw new Error("precheck still compares import.meta.url to an unencoded argv path");
  if (!own.includes("isDirectRun(import.meta.url, process.argv[1])")) {
    throw new Error("the main-module check does not resolve the invoked path");
  }
  const parent = mkdtempSync(join(tmpdir(), "precheck-main-"));
  try {
    const spaced = join(parent, "path with space");
    const realDir = join(spaced, "real");
    mkdirSync(realDir, { recursive: true });
    const href = pathToFileURL(fileURLToPath(import.meta.url)).href;
    writeFileSync(
      join(realDir, "entry.mjs"),
      [
        `import { isDirectRun } from ${JSON.stringify(href)};`,
        "const old = import.meta.url === `" + "file://${process.argv[1]}`;",
        "if (old) process.exit(2);",
        "if (!isDirectRun(import.meta.url, process.argv[1])) process.exit(3);",
        "if (isDirectRun(import.meta.url, undefined)) process.exit(4);",
      ].join("\n"),
    );
    const link = join(spaced, "link");
    symlinkSync(realDir, link);
    try {
      execFileSync(process.execPath, [join(link, "entry.mjs")], { stdio: "pipe" });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      if (status === 2) throw new Error("the old main-module check passed; this path does not reproduce the bug");
      if (status === 3) throw new Error("a symlinked path with a space was not treated as the main module");
      if (status === 4) throw new Error("a missing argv path counted as the main module");
      throw error;
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function assertCiDrift() {
  const drifted = [
    "jobs:",
    "  mobile-typecheck:",
    "    steps:",
    "      - name: Typecheck the app",
    "        working-directory: apps/web",
    "        env:",
    "          NODE_OPTIONS: --max-old-space-size=4096",
    "        run: pnpm typecheck:watch",
    "  ci:",
    "    uses: Supa-Media/supa-framework/.github/workflows/ci.yml@main",
    "    with:",
    "      architecture-check: false",
  ].join("\n");
  let caught = false;
  try {
    assertCi(drifted);
  } catch (error) {
    caught = error instanceof Error && /mobile-typecheck|architecture-check/.test(error.message);
  }
  if (!caught) throw new Error("a drifted mobile-typecheck passed");
  const architectureOff = [
    "jobs:",
    "  mobile-typecheck:",
    "    steps:",
    "      - name: Typecheck the app",
    "        working-directory: apps/mobile",
    "        env:",
    "          NODE_OPTIONS: --max-old-space-size=6144",
    "        run: pnpm typecheck",
    "  ci:",
    "    uses: Supa-Media/supa-framework/.github/workflows/ci.yml@main",
    "    with:",
    "      architecture-check: false",
  ].join("\n");
  caught = false;
  try {
    assertCi(architectureOff);
  } catch (error) {
    caught = error instanceof Error && /architecture-check/.test(error.message);
  }
  if (!caught) throw new Error("ci.yml with architecture-check turned off passed");
  const sound = [
    "jobs:",
    "  mobile-typecheck:",
    "    steps:",
    "      - name: Typecheck the app",
    "        working-directory: apps/mobile",
    "        env:",
    "          NODE_OPTIONS: --max-old-space-size=6144",
    "        run: pnpm typecheck",
    "  ci:",
    "    uses: Supa-Media/supa-framework/.github/workflows/ci.yml@main",
    "    with:",
    "      architecture-check: true",
  ].join("\n");
  assertCi(sound);
  assertCi(readFileSync(CI, "utf8"));
}

function baseRef() {
  for (const ref of ["origin/main", "main"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT, stdio: "ignore" });
      return ref;
    } catch {
      /* try the next name */
    }
  }
  return null;
}

function description() {
  if (process.env.TEX_PR_BODY != null && process.env.TEX_PR_BODY !== "") return process.env.TEX_PR_BODY;
  try {
    return execFileSync("gh", ["pr", "view", "--json", "body", "--jq", ".body"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\n$/, "");
  } catch {
    return "";
  }
}

function runShell(name, command, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", command], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const emit = (stream, target) => {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) target.write(`[${name}] ${line}\n`);
      });
      stream.on("end", () => {
        if (pending) target.write(`[${name}] ${pending}\n`);
      });
    };
    emit(child.stdout, process.stdout);
    emit(child.stderr, process.stderr);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function runGuards(env) {
  const scripts = scriptsToRun(readFileSync(GUARDS, "utf8"));
  for (let i = 0; i < scripts.length; i++) {
    const code = await runShell(`guards ${i + 1}/${scripts.length}`, scripts[i], env);
    if (code !== 0) return code;
  }
  return 0;
}

if (process.argv.includes("--self-test")) {
  try {
    selfTest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else if (isDirectRun(import.meta.url, process.argv[1])) {
  const ref = baseRef();
  if (!ref) {
    console.error("precheck: no origin/main or main to diff against.");
    process.exit(1);
  }
  const base = execFileSync("git", ["merge-base", "HEAD", ref], { cwd: ROOT, encoding: "utf8" }).trim();
  const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
  const env = {
    ...process.env,
    BASE_SHA: base,
    TEX_PR_BODY: description(),
    RUNNER_TEMP: runnerTemp,
  };
  const installed = existsSync(join(ROOT, "node_modules/.bin/supa-architecture-check")) && existsSync(join(ROOT, "apps/mobile/node_modules"));
  if (!installed) {
    console.error("precheck: run pnpm install first (the typecheck and the architecture check need it).");
    process.exit(1);
  }
  const started = Date.now();
  const stamp = (name) => (code) => ({ name, code, ms: Date.now() - started });
  const [guards, typecheck, architecture] = await Promise.all([
    runGuards(env).then(stamp("fast guards")),
    runShell("typecheck", TYPECHECK, { ...env, NODE_OPTIONS: TYPECHECK_HEAP }).then(stamp("app typecheck")),
    runShell("architecture", architectureCommand(ref), env).then(stamp("architecture check")),
  ]);
  const groups = [guards, typecheck, architecture];
  for (const group of groups) {
    console.log(`precheck: ${group.name} ${group.code === 0 ? "passed" : "failed"} in ${(group.ms / 1000).toFixed(1)}s`);
  }
  const failed = groups.filter((group) => group.code !== 0);
  if (failed.length) {
    console.error(`precheck: ${failed.map((group) => group.name).join(", ")} failed.`);
    process.exit(1);
  }
  console.log(`precheck: passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
