#!/usr/bin/env node
/**
 * The checks that fail a pull request before anything slow starts, run locally
 * before a push (CLAUDE.md). Fast repository guards, the app typecheck, and
 * the architecture check — the three that turned into fix loops after the
 * push (#3544 typecheck and architecture, #3538 and #3532 guards).
 *
 * The guard steps are the `run:` steps of `.github/workflows/fast-guards.yml`
 * (which includes `scripts/tex-diagram-check.mjs`). The Node version line is
 * the only one skipped: it records the runner, it checks nothing. The app
 * typecheck is CI's `The app typechecks` (`pnpm --dir apps/mobile typecheck`,
 * 6 GB heap). The architecture check is CI's `ci / Architecture check`
 * (`pnpm exec supa-architecture-check --base origin/main` on a pull request).
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
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARDS = join(ROOT, ".github/workflows/fast-guards.yml");

/** CI's app typecheck (`ci.yml`, job "The app typechecks"). */
export const TYPECHECK = "pnpm --dir apps/mobile typecheck";
/** CI's architecture check on a pull request (supa-framework `ci.yml`). */
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

const REQUIRED = [
  "scripts/tex-diagram-check.mjs",
  "scripts/check-tex-change-has-case.mjs",
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
  const blob = guards.join("\n");
  const missing = REQUIRED.filter((path) => !blob.includes(path));
  if (missing.length) throw new Error(`precheck dropped ${missing.join(", ")}`);
  if (!TYPECHECK.includes("apps/mobile") || !TYPECHECK.startsWith("pnpm ")) throw new Error("typecheck command drifted from CI");
  const arch = architectureCommand("origin/main");
  if (arch !== "pnpm exec supa-architecture-check --base origin/main") throw new Error("architecture command drifted from CI");
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
  console.log("ok   precheck self-test");
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
  const scripts = guardScripts(readFileSync(GUARDS, "utf8"));
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
} else if (import.meta.url === `file://${process.argv[1]}`) {
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
    runShell("typecheck", TYPECHECK, { ...env, NODE_OPTIONS: "--max-old-space-size=6144" }).then(stamp("app typecheck")),
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
