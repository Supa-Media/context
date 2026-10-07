#!/usr/bin/env node

/**
 * Decide whether one pull-request job can prove anything about the diff.
 *
 * The workflow still starts and reports a check. Only setup and test steps are
 * skipped, so a required context can never remain pending because a trigger
 * filter prevented it from existing. Pushes to main always run as a backstop.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { matches, workspacePaths } from "./check-ci-path-gates.mjs";
import { reach, reached } from "./import-reach.mjs";

const ROOT_INPUTS = [
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/**",
  ".github/actions/ci-scope/**",
  "scripts/ci-change-scope.mjs",
  "scripts/check-ci-path-gates.mjs",
  "scripts/import-reach.mjs",
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

export function changedFiles(env = process.env) {
  // A push is diffed against the commit it replaced only when the job asks
  // (`push-diff`): the editor's browser run must not run on a merge that did
  // not touch the editor (Dev2, 2026-10-07). Every other job keeps the
  // unconditional main-branch backstop.
  const pushDiff = env.GITHUB_EVENT_NAME === "push" && env.CI_SCOPE_PUSH_DIFF === "true";
  if (env.GITHUB_EVENT_NAME !== "pull_request" && !pushDiff) {
    return { files: [], backstop: `${env.GITHUB_EVENT_NAME || "local"} runs the main-branch backstop` };
  }
  if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) {
    return { files: [], backstop: "the event payload is unavailable" };
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  // A new branch or a force push reports no usable `before`; that runs.
  const base = pushDiff ? event.before : event.pull_request?.base?.sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? "") || /^0+$/.test(base)) {
    return { files: [], backstop: "the base commit is unavailable" };
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

/**
 * `entries` scopes by the files those entry points import rather than by whole
 * packages (see import-reach.mjs); `packages` and `paths` still add to it.
 */
export function decide({ packages = [], paths = [], entries = [], changed = [], backstop = null, root = process.cwd() }) {
  const watched = watchedPaths(packages, paths, root);
  const scope = entries.length ? reach(entries, root) : null;
  const matched = backstop
    ? []
    : changed.filter((file) => watched.some((pattern) => matches(file, pattern)) || (scope && reached(file, scope)));
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
  const byEntry = (file) => decide({ entries: ["apps/mcp/src/index.js"], changed: [file], root }).affected;
  if (!byEntry("apps/mcp/src/index.js")) throw new Error("an entry point did not match itself");
  if (!byEntry("apps/mcp/wrangler.toml")) throw new Error("a config beside reached code did not fail open");
  if (byEntry("apps/mcp/test/test.mjs")) throw new Error("a test nothing imports matched an entry scope");
  // The collaboration run's real scope, through the `@/` alias and relative imports.
  const collaboration = (file) =>
    decide({ entries: ["apps/mobile/app/_layout.tsx", "apps/mobile/features/e2e/collaboration/Fixture.tsx"], changed: [file], root }).affected;
  if (!collaboration("apps/mobile/features/console/files/NoteEditor.tsx")) throw new Error("the editor is outside the collaboration scope");
  if (collaboration("apps/mobile/__tests__/formBlock.test.ts")) throw new Error("an app unit test matched the collaboration scope");
  // The editor's browser run: packages and other apps are followed by file.
  const editor = (file) =>
    decide({
      entries: ["apps/mobile/features/console/files/LiveEditor.web.tsx", "apps/mobile/features/console/files/webview/entry.ts"],
      changed: [file],
      root,
    }).affected;
  if (!editor("packages/shared/src/links.ts")) throw new Error("a shared file the editor imports is outside its scope");
  if (editor("packages/shared/src/siteDesign/css.ts")) throw new Error("a shared file the editor never imports matched its scope");
  if (!editor("apps/mcp/src/forms/grammar.js")) throw new Error("gateway code the editor imports is outside its scope");
  if (editor("apps/mcp/wrangler.toml")) throw new Error("a config of an app the editor only imports from matched its scope");
  if (!editor("apps/mobile/metro.config.js")) throw new Error("a build config of the app the editor is built in did not fail open");
  if (editor("apps/mobile/public/index.html")) throw new Error("an asset nothing imports matched the editor scope");
  if (editor("apps/mobile/eslint.config.js")) throw new Error("a lint config matched the editor scope");
  // A push runs the backstop unless the job asked to diff it.
  const event = join(mkdtempSync(join(tmpdir(), "ci-scope-")), "event.json");
  const head = git("rev-parse", "HEAD");
  const push = (before, flag) => {
    writeFileSync(event, JSON.stringify({ before }));
    return changedFiles({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, CI_SCOPE_PUSH_DIFF: flag });
  };
  if (!push(head, undefined).backstop) throw new Error("a push without push-diff skipped the backstop");
  if (push(head, "true").backstop) throw new Error("a push with push-diff was not diffed");
  if (!push("0".repeat(40), "true").backstop) throw new Error("a push with no previous commit did not fail open");
}

async function main(env = process.env) {
  const packages = parseList(env.CI_SCOPE_PACKAGES);
  const paths = parseList(env.CI_SCOPE_PATHS);
  const entries = parseList(env.CI_SCOPE_ENTRIES);
  if (!packages.length && !paths.length && !entries.length) throw new Error("ci-scope needs at least one package, path or entry");
  const diff = changedFiles(env);
  const result = decide({ packages, paths, entries, changed: diff.files, backstop: diff.backstop });
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
