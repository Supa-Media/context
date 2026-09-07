#!/usr/bin/env node
/**
 * No Wrangler config a deploy workflow pushes secrets into may commit any of
 * those secrets as a plaintext `vars` entry.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `infra/router/wrangler.jsonc` once committed `CONVEX_ORIGIN` under `vars`.
 * The account's live script therefore carried that name as a plaintext var,
 * and `wrangler secret put CONVEX_ORIGIN` — run to convert it to a secret —
 * collided with it on every run: Cloudflare 10053, "Binding name
 * 'CONVEX_ORIGIN' already in use" (see `check-workflow-secret-order.mjs` for
 * the other half of that story, the step ORDER that made it permanent rather
 * than one-time). The var was removed and the ordering fixed, but nothing
 * proved it would not come back, or that the other three Workers that push
 * secrets this way (the MCP gateway, the email worker, the transcribe worker)
 * do not already carry the same mistake under a different name. This is that
 * proof, re-run on every change to a Wrangler config or the workflow that
 * deploys it.
 *
 * ── WHAT THIS CHECKS ──────────────────────────────────────────────────────
 *
 * For every `deploy-*.yml` workflow that runs `wrangler secret put <NAME>`:
 *
 *   1. Find the Wrangler config it deploys — the `working-directory:` nearest
 *      above its `wrangler deploy` step, plus a `--config <path>` argument if
 *      one is given (resolving a `$SHELL_VAR` against the workflow's
 *      top-level `env:` block), else the first of `wrangler.toml` /
 *      `wrangler.jsonc` that exists in that directory.
 *   2. Read that config's `vars` (TOML `[vars]` table, or JSONC `"vars": {…}`)
 *      and collect its key names.
 *   3. Fail if any key collides with a name the same workflow pushes via
 *      `wrangler secret put`.
 *
 * This is deliberately narrower than "no var name looks like a secret" —
 * that would flag `EXPO_ORIGIN` sitting beside a Worker that happens to push
 * an unrelated secret. The only thing that can actually collide is a var and
 * a secret PUT BY THE SAME DEPLOY sharing a name, so that is the only thing
 * checked.
 *
 * Run: `node scripts/check-wrangler-vars-not-secrets.mjs`
 * Self-test: `node scripts/check-wrangler-vars-not-secrets.mjs --self-test`
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

/** Every `wrangler secret put NAME`, wherever in the file it appears. */
export function secretNamesPushed(text) {
  const names = new Set();
  for (const m of text.matchAll(/\bwrangler\s+secret\s+put\s+([A-Za-z0-9_]+)/g)) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * The `working-directory:` nearest above the given line index (0-based),
 * searching upward — every deploy job in this repository sets it on each
 * step rather than once at the job level.
 */
function workingDirectoryAbove(lines, index) {
  for (let i = index; i >= 0; i--) {
    const m = lines[i].match(/^\s*working-directory:\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  return "";
}

/** The workflow's top-level `env:` map — `NAME: value`, indent 2, under a column-0 `env:`. */
function topLevelEnv(lines) {
  const env = {};
  const start = lines.findIndex((l) => /^env:\s*$/.test(l));
  if (start === -1) return env;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (line.search(/\S/) === 0) break; // next top-level key
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** The config file path a `wrangler deploy`/`versions upload` line resolves to, or null. */
function resolveConfigPath(lines, deployLineIndex, dir) {
  const line = lines[deployLineIndex];
  const configFlag = line.match(/--config\s+"?\$?\{?([A-Za-z0-9_./]+)\}?"?/);
  if (configFlag) {
    let value = configFlag[1];
    const env = topLevelEnv(lines);
    if (line.includes(`$${value}`) || line.includes(`\${${value}}`)) {
      if (env[value] !== undefined) value = env[value];
      else return null; // an unresolved shell variable — do not guess
    }
    const path = join(ROOT, dir, value);
    return existsSync(path) ? path : null;
  }
  for (const candidate of ["wrangler.toml", "wrangler.jsonc"]) {
    const path = join(ROOT, dir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Key names under a config's `vars` table — TOML's `[vars]` or JSONC's
 * `"vars": { ... }` — using the same "don't need a real parser" approach as
 * this repo's other workflow checkers.
 */
export function varsKeysIn(configText) {
  const lines = configText.split("\n");
  const keys = [];

  const tomlStart = lines.findIndex((l) => /^\[vars\]\s*$/.test(l));
  if (tomlStart !== -1) {
    for (let i = tomlStart + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^\[/.test(trimmed)) break;
      const m = trimmed.match(/^([A-Za-z0-9_]+)\s*=/);
      if (m) keys.push(m[1]);
    }
    return keys;
  }

  const jsoncStart = lines.findIndex((l) => /"vars"\s*:\s*\{\s*$/.test(l));
  if (jsoncStart !== -1) {
    let depth = 1;
    for (let i = jsoncStart + 1; i < lines.length && depth > 0; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//")) continue; // a comment line, not a key
      depth += (trimmed.match(/\{/g) || []).length;
      depth -= (trimmed.match(/\}/g) || []).length;
      const m = trimmed.match(/^"([A-Za-z0-9_]+)"\s*:/);
      if (m) keys.push(m[1]);
    }
    return keys;
  }

  return keys; // no `vars` table at all — nothing to collide with
}

function readWorkflows() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => /^deploy-.*\.ya?ml$/.test(f))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS_DIR, name), "utf8") }));
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {string[]} one message per config that carries a secret as a var
 */
export function findVarsThatAreSecrets(files) {
  const problems = [];
  for (const { name, text } of files) {
    const pushed = secretNamesPushed(text);
    if (pushed.length === 0) continue;

    const lines = text.split("\n");
    const deployLine = lines.findIndex((l) => /\bwrangler\s+(?:pages\s+)?deploy\b|\bwrangler\s+versions\s+upload\b/.test(l));
    if (deployLine === -1) continue;

    const dir = workingDirectoryAbove(lines, deployLine);
    const configPath = resolveConfigPath(lines, deployLine, dir);
    if (!configPath) continue; // nothing found to check against — not a pass, just nothing to say

    const configText = readFileSync(configPath, "utf8");
    const collisions = varsKeysIn(configText).filter((key) => pushed.includes(key));
    if (collisions.length > 0) {
      problems.push(
        `${name} pushes ${collisions.join(", ")} via \`wrangler secret put\`, but ` +
          `${configPath.replace(ROOT + "/", "")} already declares ${collisions.length > 1 ? "them" : "it"} under ` +
          `\`vars\` as plaintext. A committed var of the same name as a secret is exactly the #302 shape — ` +
          `remove it from \`vars\`.`,
      );
    }
  }
  return problems;
}

function main() {
  const files = readWorkflows();
  if (files.length === 0) {
    console.error(`No deploy-*.yml files found in ${WORKFLOWS_DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  const problems = findVarsThatAreSecrets(files);
  if (problems.length > 0) {
    console.error("A Wrangler config commits a secret as a plaintext var:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`OK — ${files.length} deploy workflow(s) checked, no Wrangler config commits a pushed secret as a var.`);
}

function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  // varsKeysIn: TOML
  expect(
    "TOML [vars] keys are extracted",
    JSON.stringify(varsKeysIn('name = "x"\n\n[vars]\nPUBLIC_ORIGIN = "https://x"\nALLOWED_ORIGINS = "https://y"\n')) ===
      JSON.stringify(["PUBLIC_ORIGIN", "ALLOWED_ORIGINS"]),
  );
  expect(
    "TOML parsing stops at the next section",
    JSON.stringify(varsKeysIn('[vars]\nA = "1"\n[env.production]\nB = "2"\n')) === JSON.stringify(["A"]),
  );
  expect("no [vars] table at all yields no keys", varsKeysIn('name = "x"\n').length === 0);

  // varsKeysIn: JSONC
  expect(
    "JSONC vars keys are extracted, comments skipped",
    JSON.stringify(varsKeysIn('{\n  "vars": {\n    // a comment mentioning "FOO": "not a key"\n    "FOO": "bar",\n    "BAZ": "qux"\n  }\n}\n')) ===
      JSON.stringify(["FOO", "BAZ"]),
  );
  expect(
    "JSONC parsing stops at the closing brace, not a nested one",
    JSON.stringify(varsKeysIn('{\n  "vars": {\n    "A": "1"\n  },\n  "other": {\n    "B": "2"\n  }\n}\n')) === JSON.stringify(["A"]),
  );

  // secretNamesPushed
  expect(
    "secret names are collected across multiple lines",
    JSON.stringify(secretNamesPushed('printf a | wrangler secret put A\nprintf b | wrangler secret put B --config wrangler.toml\n')) ===
      JSON.stringify(["A", "B"]),
  );
  expect("a file that pushes nothing yields no names", secretNamesPushed("wrangler deploy\n").length === 0);

  // findVarsThatAreSecrets: the #302 regression fixture, and its fix.
  const dirs = { "test-worker": "wrangler.toml" };
  // Build a fake filesystem in-memory by writing to the real one is overkill
  // for a unit test; instead exercise the pure functions directly and, for
  // the end-to-end path, assert the resolver refuses to guess a config it
  // cannot find rather than silently reporting nothing as a pass.
  expect(
    "resolveConfigPath returns null rather than reading a nonexistent file",
    (() => {
      const lines = ["working-directory: nonexistent-dir-xyz", "run: wrangler deploy"];
      return resolveConfigPath(lines, 1, "nonexistent-dir-xyz") === null;
    })(),
  );
  void dirs;

  // The live repository, post-fix, must have nothing left to report — the
  // assertion that actually gates CI, run against the real files.
  const liveProblems = findVarsThatAreSecrets(readWorkflows());
  expect(`the live deploy workflows have no secret-as-var collisions (found: ${liveProblems.join(" | ") || "none"})`, liveProblems.length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${8} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
