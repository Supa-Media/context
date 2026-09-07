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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

// Anchored on `pnpm exec wrangler …` rather than a bare `wrangler …` anywhere
// in the line, and for the same reason as `check-workflow-secret-order.mjs`:
// several deploy workflows' Cloudflare-preflight steps print a diagnostic
// string containing "wrangler deploy" — not a YAML comment, so
// `stripComments` alone does not remove it — well before the real deploy
// step. A bare match found that line first in deploy-mcp.yml, resolved no
// `working-directory:` above it (the false match sits outside any
// `working-directory`-scoped step), and silently gave up on checking
// apps/mcp/wrangler.toml at all — the exact config this check exists for.
// Every real invocation in this repository goes through `pnpm exec`.
const DEPLOYS_LIVE = /\bpnpm\s+exec\s+wrangler\s+(?:pages\s+)?deploy\b|\bpnpm\s+exec\s+wrangler\s+versions\s+upload\b/;

/**
 * Comments blanked to empty strings rather than removed, so every other
 * line's index — and therefore everything below that searches "the nearest
 * line above" or "the first matching line" — stays aligned with the
 * ORIGINAL file. Every deploy workflow's header narrates this exact bug in
 * prose, mentioning both `wrangler deploy` and `wrangler secret put`; reading
 * comments as code would make a checker trip over its own explanation.
 */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/**
 * Every `wrangler secret put NAME`, wherever in the file it appears.
 * Anchored on `pnpm exec wrangler …`, same reasoning as `DEPLOYS_LIVE` above:
 * every real invocation goes through `pnpm exec`, and this stays consistent
 * with it rather than relying on a captured NAME being enough on its own to
 * rule out a false match in prose.
 */
export function secretNamesPushed(text) {
  const names = new Set();
  for (const m of stripComments(text).matchAll(/\bpnpm\s+exec\s+wrangler\s+secret\s+put\s+([A-Za-z0-9_]+)/g)) {
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

    // Comments blanked (not removed — line numbers stay aligned) before
    // searching: every one of these headers narrates "wrangler deploy" and
    // "wrangler secret put" in prose, well above the real steps.
    const lines = stripComments(text).split("\n");
    const deployLine = lines.findIndex((l) => DEPLOYS_LIVE.test(l));
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
    JSON.stringify(secretNamesPushed("printf a | pnpm exec wrangler secret put A\nprintf b | pnpm exec wrangler secret put B --config wrangler.toml\n")) ===
      JSON.stringify(["A", "B"]),
  );
  expect("a file that pushes nothing yields no names", secretNamesPushed("pnpm exec wrangler deploy\n").length === 0);
  expect(
    "prose mentioning `wrangler secret put NAME` is not itself a push — every header narrates this bug by name",
    secretNamesPushed("# past: `wrangler secret put OLD_NAME` ran before deploy\npnpm exec wrangler deploy\n").length === 0,
  );

  // The actual bug this file was fixed for while writing it: every deploy
  // workflow's header narrates "wrangler deploy" in prose ABOVE the real
  // step (deploy-mcp.yml does it three times), and its Cloudflare-preflight
  // step separately prints a diagnostic STRING containing "wrangler deploy" —
  // not a YAML comment, so stripping "#" lines alone does not remove it.
  // Finding the first line that merely MENTIONS the command, instead of the
  // real one, resolved no working-directory above it and silently gave up —
  // the exact shape that let this check skip apps/mcp/wrangler.toml entirely
  // without reporting anything wrong. Both false shapes are in this fixture.
  const narratedDeploy = [
    "# See `wrangler deploy` below for why this matters.",
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: |",
    '          node -e \'console.error("wrangler deploy needs Workers Scripts: Edit")\'',
    "      - working-directory: fixture-worker",
    "        run: pnpm exec wrangler secret put X",
    "      - working-directory: fixture-worker",
    "        run: pnpm exec wrangler deploy",
  ].join("\n");
  expect(
    "neither the comment nor the diagnostic string stands in for the real deploy step",
    (() => {
      const lines = stripComments(narratedDeploy).split("\n");
      const deployLine = lines.findIndex((l) => DEPLOYS_LIVE.test(l));
      // Line 0 (the comment) and line 5 (the console.error string) must NOT
      // be picked; the real step is line 9.
      return deployLine === 9;
    })(),
  );

  // The resolver must refuse to guess a config it cannot find rather than
  // silently reporting nothing as a pass.
  expect(
    "resolveConfigPath returns null rather than reading a nonexistent file",
    (() => {
      const lines = ["working-directory: nonexistent-dir-xyz", "run: wrangler deploy"];
      return resolveConfigPath(lines, 1, "nonexistent-dir-xyz") === null;
    })(),
  );

  // The live repository, post-fix, must have nothing left to report — the
  // assertion that actually gates CI, run against the real files.
  const liveFiles = readWorkflows();
  const liveProblems = findVarsThatAreSecrets(liveFiles);
  expect(`the live deploy workflows have no secret-as-var collisions (found: ${liveProblems.join(" | ") || "none"})`, liveProblems.length === 0);

  // Sabotage-test the whole path end to end, using the REAL deploy-mcp.yml's
  // text (comments, narrated "wrangler deploy" mentions, and all) but a
  // config file written to a scratch directory rather than the tracked
  // apps/mcp/wrangler.toml — this exercises the exact bug fixed above (the
  // deploy line resolving to a comment, `dir` coming back empty, the check
  // silently giving up) without a self-test ever mutating a file this
  // repository tracks.
  const deployMcp = liveFiles.find((f) => f.name === "deploy-mcp.yml");
  // Created UNDER ROOT, and referenced by its path RELATIVE to ROOT — real
  // `working-directory:` values are always relative (e.g. "apps/mcp"), and
  // resolveConfigPath's `join(ROOT, dir, value)` does not reset to root for
  // an absolute `dir` the way `path.resolve` would, so an OS tmpdir here
  // would silently fail to resolve regardless of whether the real bug is
  // fixed — this mirrors production instead of tripping a second, unrelated
  // one.
  const scratchDir = mkdtempSync(join(ROOT, ".wrangler-vars-selftest-"));
  try {
    const scratchConfig = join(scratchDir, "wrangler.toml");
    writeFileSync(scratchConfig, '[vars]\nCONTROL_PLANE_URL = "https://example-deployment.convex.site"\n');
    const relativeDir = scratchDir.slice(ROOT.length + 1);
    const rewritten = deployMcp.text
      .replace(/working-directory:\s*apps\/mcp/g, `working-directory: ${relativeDir}`)
      .replace(/--config\s+"\$MCP_WRANGLER_CONFIG"/g, `--config wrangler.toml`);
    const sabotagedProblems = findVarsThatAreSecrets([{ name: "deploy-mcp.yml", text: rewritten }]);
    expect(
      "a CONTROL_PLANE_URL var collision is caught through deploy-mcp.yml's own text, comments and all",
      sabotagedProblems.some((p) => p.startsWith("deploy-mcp.yml") && p.includes("CONTROL_PLANE_URL")),
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${12} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
