#!/usr/bin/env node

/**
 * Decide whether one pull-request job can prove anything about the diff.
 *
 * The workflow still starts and reports a check. Only setup and test steps are
 * skipped, so a required context can never remain pending because a trigger
 * filter prevented it from existing. Pushes to main always run as a backstop.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { matches, workspacePaths } from "./check-ci-path-gates.mjs";

const ROOT_INPUTS = [
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/**",
  ".github/actions/ci-scope/**",
  "scripts/ci-change-scope.mjs",
  "scripts/check-ci-path-gates.mjs",
];

export function parseList(value = "") {
  return String(value)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Re-exported, not defined here: `check-ci-path-gates.mjs` owns it, because the
 * guard that checks a job's watched paths cover what it must has to decide
 * coverage with exactly this matcher, and a second copy is a rule nobody
 * enforces.
 */
export { matches };

export function selectChanged(changed, watched) {
  return changed.filter((file) => watched.some((pattern) => matches(file, pattern)));
}

export function watchedPaths(packages, paths, root = process.cwd()) {
  return [...new Set([...workspacePaths(packages, root), ...ROOT_INPUTS, ...paths])].sort();
}

function git(...args) {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hasCommit(sha) {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function changedFiles(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return { files: [], backstop: `${env.GITHUB_EVENT_NAME || "local"} runs the main-branch backstop` };
  }
  if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) {
    return { files: [], backstop: "the pull-request event payload is unavailable" };
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? "")) {
    return { files: [], backstop: "the pull-request base commit is unavailable" };
  }
  if (!hasCommit(base)) {
    try {
      git("fetch", "--no-tags", "--quiet", "--depth=1", "origin", base);
    } catch {
      return { files: [], backstop: `base commit ${base.slice(0, 8)} could not be fetched` };
    }
  }
  return {
    files: git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean),
    backstop: null,
  };
}

function writeOutput(name, value, env = process.env) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function writeSummary(lines, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

export function decide({ packages = [], paths = [], changed = [], backstop = null, root = process.cwd() }) {
  const watched = watchedPaths(packages, paths, root);
  const matched = backstop ? [] : selectChanged(changed, watched);
  const affected = Boolean(backstop || matched.length);
  const reason = backstop
    ? backstop
    : matched.length
      ? `${matched.length} watched path${matched.length === 1 ? "" : "s"} changed`
      : `${changed.length} changed path${changed.length === 1 ? "" : "s"}, none watched by this job`;
  return { affected, reason, matched, watched };
}

export function selfTest() {
  const root = new URL("../", import.meta.url).pathname;
  const scope = watchedPaths(["@context/mcp"], [".github/workflows/mcp.yml"], root);
  if (!scope.includes("apps/mcp/**")) throw new Error("workspace package path is missing");
  if (!scope.includes("packages/collaboration/**")) throw new Error("recursive workspace dependency is missing");
  if (!selectChanged(["apps/mcp/src/index.js"], scope).length) throw new Error("owned source did not match");
  if (selectChanged(["apps/mobile/App.tsx"], scope).length) throw new Error("unrelated source matched");
  if (!selectChanged(["pnpm-lock.yaml"], scope).length) throw new Error("lockfile did not fan out");
  const fallback = decide({ packages: [], paths: [], changed: [], backstop: "missing base", root });
  if (!fallback.affected) throw new Error("uncertain scope did not fail open");
}

async function main(env = process.env) {
  const packages = parseList(env.CI_SCOPE_PACKAGES);
  const paths = parseList(env.CI_SCOPE_PATHS);
  if (!packages.length && !paths.length) throw new Error("ci-scope needs at least one package or path");
  const diff = changedFiles(env);
  const result = decide({ packages, paths, changed: diff.files, backstop: diff.backstop });
  writeOutput("affected", String(result.affected), env);
  writeOutput("reason", result.reason.replaceAll("\n", " "), env);
  console.log(`${result.affected ? "RUN" : "SKIP"}: ${result.reason}`);
  if (result.matched.length) console.log(`Matched:\n${result.matched.map((file) => `- ${file}`).join("\n")}`);
  writeSummary([
    `### ${env.GITHUB_JOB || "CI job"} scope`,
    "",
    `${result.affected ? "Runs" : "Skips"}: ${result.reason}.`,
    ...(result.matched.length ? ["", ...result.matched.slice(0, 10).map((file) => `- \`${file}\``)] : []),
  ], env);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("CI change scope self-test passed");
  } else {
    await main();
  }
}
