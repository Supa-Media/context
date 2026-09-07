#!/usr/bin/env node
/**
 * No deploy workflow may run `wrangler secret put` before `wrangler deploy`.
 *
 * ── WHAT WENT WRONG (#302) ───────────────────────────────────────────────────
 *
 * `wrangler secret put` acts on whatever version of a Worker's script is
 * CURRENTLY LIVE. While `infra/router/wrangler.jsonc` still committed
 * `CONTROL_PLANE_URL` as a plaintext `vars` entry, the account's live script
 * carried it that way too. `deploy-router.yml` ran the secret push BEFORE
 * `wrangler deploy`, so every run collided with that stale var — Cloudflare
 * 10053, "Binding name 'CONVEX_ORIGIN' already in use" — forever, because the
 * one step that would have retired the var (`wrangler deploy`) never got to
 * run. Deploying first retires the var immediately; the secret push then acts
 * on a script that no longer declares it. `deploy-router.yml` and
 * `deploy-email-worker.yml` were fixed to deploy-then-secrets; `deploy-mcp.yml`
 * and `deploy-transcribe-worker.yml` carried the same secrets-then-deploy
 * shape and had simply not hit a colliding var yet — nothing here proves they
 * never will.
 *
 * ── WHAT THIS CHECKER ENFORCES ───────────────────────────────────────────────
 *
 * Within each workflow file, comments stripped, the first `wrangler secret
 * put` must not appear before the first `wrangler deploy` (or `wrangler
 * versions upload`, the other command that publishes a new live version) —
 * when a file has neither, or only one of the two, there is nothing to order
 * and it passes. This is a textual, whole-file ordering check rather than a
 * per-job/per-step parse: every deploy workflow in this repository puts both
 * commands in the same job, in the sequence they run, so line order in the
 * file already reflects execution order. A workflow that split them across
 * parallel jobs would defeat this — nothing here does.
 *
 * Comments are stripped first because every deploy workflow's header narrates
 * this exact bug in prose, mentioning both commands — a checker that read
 * comments as code would flag its own explanation.
 *
 * Run: `node scripts/check-workflow-secret-order.mjs`
 * Self-test: `node scripts/check-workflow-secret-order.mjs --self-test`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

const SECRET_PUT = /\bwrangler\s+secret\s+put\b/;
const DEPLOYS_LIVE = /\bwrangler\s+(?:pages\s+)?deploy\b|\bwrangler\s+versions\s+upload\b/;

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/**
 * @param {string} text a workflow file's full source
 * @returns {{secretPutLine: number, deployLine: number} | null} the two lines
 *   in violation, or null when the file has no ordering problem (including
 *   when it has fewer than two of the relevant commands).
 */
export function findOutOfOrderSecretPut(text) {
  const lines = stripComments(text).split("\n");
  let firstSecretPut = -1;
  let firstDeploy = -1;
  for (let i = 0; i < lines.length; i++) {
    if (firstSecretPut === -1 && SECRET_PUT.test(lines[i])) firstSecretPut = i;
    if (firstDeploy === -1 && DEPLOYS_LIVE.test(lines[i])) firstDeploy = i;
  }
  if (firstSecretPut === -1 || firstDeploy === -1) return null;
  if (firstSecretPut < firstDeploy) {
    return { secretPutLine: firstSecretPut + 1, deployLine: firstDeploy + 1 };
  }
  return null;
}

function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function main() {
  const files = readWorkflows(WORKFLOWS_DIR);

  // A floor, same reason every sibling checker has one: a wrong directory or
  // an empty checkout must not read as "nothing to report".
  if (files.length < 5) {
    console.error(`Only ${files.length} workflow files found in ${WORKFLOWS_DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  const problems = [];
  for (const { name, text } of files) {
    const hit = findOutOfOrderSecretPut(text);
    if (hit) {
      problems.push(
        `${name}: \`wrangler secret put\` at line ${hit.secretPutLine} runs before \`wrangler deploy\`/` +
          `\`wrangler versions upload\` at line ${hit.deployLine}. If the config ever declares that secret's ` +
          `name as a plaintext \`vars\` entry, the live script still carries it until the deploy step retires ` +
          `it — pushing the secret first collides with the stale var on every run (Cloudflare 10053). ` +
          `Move the secret push after the deploy step.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Deploy workflows push secrets before deploying:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`OK — ${files.length} workflow file(s) checked, none push a wrangler secret before deploying.`);
}

/** The checker, checked — samples it must flag, and samples it must not. */
function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const good = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: |",
    "          printf '%s' \"$X\" | pnpm exec wrangler secret put X",
  ].join("\n");
  expect("deploy before secret put is not flagged", findOutOfOrderSecretPut(good) === null);

  const bad = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: |",
    "          printf '%s' \"$X\" | pnpm exec wrangler secret put X",
    "      - run: pnpm exec wrangler deploy",
  ].join("\n");
  const hit = findOutOfOrderSecretPut(bad);
  expect("secret put before deploy is flagged", hit !== null);
  expect("the reported secret-put line is line 5", hit?.secretPutLine === 5);
  expect("the reported deploy line is line 6", hit?.deployLine === 6);

  // The actual #302 regression fixture: prose in the header narrates both
  // commands, in the wrong order, well before either real step. A checker
  // reading comments as code would flag this file for its own explanation.
  const narratedButFixed = [
    "# AFTER deploy, not before: wrangler secret put collided with a stale var",
    "# when it ran ahead of wrangler deploy. See #302.",
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: pnpm exec wrangler secret put X",
  ].join("\n");
  expect("prose narrating the bug is not itself flagged", findOutOfOrderSecretPut(narratedButFixed) === null);

  // A file with only one of the two commands has nothing to order.
  const deployOnly = "jobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n";
  expect("a file with no secret put is not flagged", findOutOfOrderSecretPut(deployOnly) === null);
  const secretOnly = "jobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler secret put X\n";
  expect("a file with no deploy command is not flagged", findOutOfOrderSecretPut(secretOnly) === null);

  // `wrangler versions upload` is the other command that publishes a live
  // version and must be ordered the same way.
  const versionsUpload = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler secret put X",
    "      - run: pnpm exec wrangler versions upload",
  ].join("\n");
  expect("wrangler versions upload is ordered the same as deploy", findOutOfOrderSecretPut(versionsUpload) !== null);

  // Multiple secret puts, all after deploy, is the common real shape
  // (deploy-mcp.yml pushes four secrets in one step) and must pass clean.
  const multipleSecretsAfter = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: |",
    "          printf a | pnpm exec wrangler secret put A",
    "          printf b | pnpm exec wrangler secret put B",
  ].join("\n");
  expect("multiple secret puts after deploy are not flagged", findOutOfOrderSecretPut(multipleSecretsAfter) === null);

  // The live repository, post-fix, must have nothing left to report.
  const live = readWorkflows(WORKFLOWS_DIR);
  const liveHits = live
    .map(({ name, text }) => ({ name, hit: findOutOfOrderSecretPut(text) }))
    .filter(({ hit }) => hit !== null)
    .map(({ name, hit }) => `${name}:${hit.secretPutLine}`);
  expect(`the live workflow files have no out-of-order secret puts (found: ${liveHits.join(", ") || "none"})`, liveHits.length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${9} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
