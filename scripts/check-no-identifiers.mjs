#!/usr/bin/env node
/**
 * No account identifier belongs in this public, MIT-licensed repository.
 *
 * CLAUDE.md is explicit and does not carve out an exception for "it is
 * technically public information anyway": "Assume every line is read by an
 * attacker. No secrets, no internal hostnames, no account identifiers... not
 * in code, tests, fixtures, comments, commit messages, or docs." Three
 * account identifiers sat in this tree until 2026-09-07 regardless — an Apple
 * Developer Team ID in `apps/mobile/eas.json`, an EAS project id in
 * `apps/mobile/app.config.js`, and a Convex deployment hostname in half a
 * dozen files — none of them a cryptographic secret, all of them naming a
 * specific account an attacker could target or correlate. This is the guard
 * that stops the next one from landing the same way: silently, in a file
 * nobody thought to grep.
 *
 * Three rules, one per identifier shape:
 *
 *   1. A 10-character uppercase-alphanumeric string next to `appleTeamId` or
 *      `teamId` — the shape of an Apple Developer Team ID.
 *   2. A UUID under `extra.eas.projectId` in `apps/mobile/app.config.js` —
 *      the shape of an EAS project id. Scoped to that one file because that is
 *      the only place this repository's build tooling reads it from; a UUID
 *      elsewhere is somebody else's business (and would be indistinguishable
 *      from any other UUID in a test fixture).
 *   3. A `*.convex.cloud` / `*.convex.site` hostname anywhere in the tracked
 *      tree, except `.env.example` (which holds no values, only `op://`
 *      references and blanks) and a short allowlist of placeholder
 *      subdomains already in use in tests and CI (`YOUR-DEPLOYMENT`,
 *      `example-deployment`) that are obviously fake rather than a
 *      forgotten real one.
 *
 * Scans `git ls-files` — the tracked, public tree — rather than walking the
 * filesystem, so node_modules, build output and anything .gitignore already
 * excludes need no separate exclusion list here.
 *
 * Run: `node scripts/check-no-identifiers.mjs`
 * Self-test: `node scripts/check-no-identifiers.mjs --self-test`
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every path `git` tracks, relative to the repo root. Binary-safe enough:
 * this only ever reads text files it finds a match in. */
function trackedFiles() {
  const res = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr || res.status}`);
  }
  return res.stdout.split("\0").filter(Boolean);
}

const TEAM_ID_RE = /\b(?:appleTeamId|teamId)\b["']?\s*[:=]\s*["']?([A-Z0-9]{10})["']?/g;

/** A v4-ish UUID, loosely — this checks shape, not RFC 4122 version bits, so
 * it catches a real EAS project id and a hand-typed test fixture alike. */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const CONVEX_HOST_RE = /([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\.convex\.(?:cloud|site)/g;

/** Subdomains already in use as obvious fakes — a placeholder in a doc's
 * comment, or a fixture in a test — never a real deployment's name. */
const CONVEX_HOST_ALLOWLIST = new Set(["your-deployment", "example-deployment"]);

/**
 * Rule 1: an Apple Developer Team ID committed beside its key.
 *
 * Scoped to the key names rather than to "any 10-char uppercase-alphanumeric
 * string", which would flag unrelated ids (a Convex document id, a random
 * test fixture) by the dozen. The key is the signal.
 */
export function findAppleTeamIds(path, text) {
  const found = [];
  for (const match of text.matchAll(TEAM_ID_RE)) {
    found.push({ path, value: match[1] });
  }
  return found;
}

/** Rule 2: a UUID committed in apps/mobile/app.config.js, where this
 * repository's own tooling reads `extra.eas.projectId` from. */
export function findEasProjectIdLiterals(path, text) {
  if (path !== "apps/mobile/app.config.js") return [];
  return [...text.matchAll(UUID_RE)].map((match) => ({ path, value: match[0] }));
}

/** Rule 3: a real-looking Convex deployment hostname anywhere but
 * `.env.example` and the documented placeholder allowlist. */
export function findConvexHosts(path, text) {
  if (path === ".env.example") return [];
  const found = [];
  for (const match of text.matchAll(CONVEX_HOST_RE)) {
    const subdomain = match[1].toLowerCase();
    if (CONVEX_HOST_ALLOWLIST.has(subdomain)) continue;
    found.push({ path, value: match[0] });
  }
  return found;
}

/**
 * This file's own path, relative to the repo root — its self-test fixtures
 * are, on purpose, exactly the strings the three rules exist to catch. The
 * same lesson `check-secrets-allowlist.mjs` records for its own body
 * extractor: a checker that reads its own source is a checker that fails on
 * a sentence about itself.
 */
const SELF = "scripts/check-no-identifiers.mjs";

function main() {
  const problems = [];
  for (const path of trackedFiles()) {
    if (path === SELF) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // binary or unreadable — nothing this checker can scan anyway
    }
    // A NUL byte is the cheap tell for "this isn't text"; skip rather than
    // false-positive on bytes that happen to look like ASCII in between.
    if (text.includes("\0")) continue;

    for (const { path: p, value } of findAppleTeamIds(path, text)) {
      problems.push(
        `${p}: an Apple Developer Team ID ("${value}") sits beside appleTeamId/teamId.\n` +
          `    Remove it and read EXPO_APPLE_TEAM_ID / the APPLE_TEAM_ID secret instead.`,
      );
    }
    for (const { path: p, value } of findEasProjectIdLiterals(path, text)) {
      problems.push(
        `${p}: a UUID ("${value}") is committed where extra.eas.projectId is built.\n` +
          `    Read it from process.env.EAS_PROJECT_ID instead — see resolveEasProjectId.`,
      );
    }
    for (const { path: p, value } of findConvexHosts(path, text)) {
      problems.push(
        `${p}: a Convex deployment hostname ("${value}") is committed.\n` +
          `    Read it from the CONTROL_PLANE_URL / EXPO_PUBLIC_CONVEX_URL secret instead,\n` +
          `    or use one of the allowlisted placeholders if this is a fixture.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Account identifiers found in the tracked tree:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log("OK — no Apple team id, EAS project id, or Convex hostname in the tracked tree.");
}

/**
 * Prove the checker is not vacuous, the same discipline
 * `check-secrets-allowlist.mjs` documents: a regex that silently matches
 * nothing passes every repository it is pointed at.
 */
function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  // Rule 1.
  expect(
    "catches a JSON appleTeamId",
    findAppleTeamIds("eas.json", '"appleTeamId": "ABCD123456"').length === 1,
  );
  expect(
    "catches a bare teamId assignment",
    findAppleTeamIds("x.yml", "teamId: WXYZ987654").length === 1,
  );
  expect(
    "does not fire on the key name alone",
    findAppleTeamIds("docs.md", "set `ios.appleTeamId` in app.config.js").length === 0,
  );
  expect(
    "does not fire on the env var name",
    findAppleTeamIds("x.yml", "EXPO_APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}").length === 0,
  );

  // Rule 2.
  expect(
    "catches a UUID in app.config.js",
    findEasProjectIdLiterals(
      "apps/mobile/app.config.js",
      'const PROJECT_ID = "cf13cf3d-0868-4463-b045-d7c805ea0bf7";',
    ).length === 1,
  );
  expect(
    "ignores the same UUID in any other file",
    findEasProjectIdLiterals("apps/mobile/other.js", 'const x = "cf13cf3d-0868-4463-b045-d7c805ea0bf7";')
      .length === 0,
  );
  expect(
    "does not fire on the placeholder",
    findEasProjectIdLiterals("apps/mobile/app.config.js", 'return "YOUR_EAS_PROJECT_ID";').length === 0,
  );

  // Rule 3.
  expect(
    "catches a real-looking convex.cloud host",
    findConvexHosts("apps/mobile/eas.json", "https://clean-ptarmigan-116.convex.cloud").length === 1,
  );
  expect(
    "catches a real-looking convex.site host",
    findConvexHosts("infra/router/wrangler.jsonc", "https://clean-ptarmigan-116.convex.site").length === 1,
  );
  expect(
    "allows the .env.example file outright",
    findConvexHosts(".env.example", "https://clean-ptarmigan-116.convex.cloud").length === 0,
  );
  expect(
    "allows the YOUR-DEPLOYMENT placeholder",
    findConvexHosts("health-check.yml", "https://YOUR-DEPLOYMENT.convex.cloud").length === 0,
  );
  expect(
    "allows the example-deployment placeholder",
    findConvexHosts("worker.test.ts", "https://example-deployment.convex.site").length === 0,
  );

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${12} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
