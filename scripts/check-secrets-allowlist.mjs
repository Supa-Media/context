#!/usr/bin/env node
/**
 * The three places a secret is named must agree.
 *
 * A secret in this repo is named in up to three places, and until 2026-09-05
 * nothing checked that they matched:
 *
 *   1. `.env.example`                     — the `op://` reference local dev injects
 *   2. `scripts/secrets-allowlist.json`   — what the 1Password → GitHub sync copies
 *   3. `.github/workflows/*.yml`          — `secrets.NAME`, what a deploy reads
 *
 * The failure is silent in both directions and neither is theoretical:
 *
 *  - A workflow reads `secrets.FOO` that the allowlist never syncs. The deploy
 *    gets an empty string, and whether that is a crash or a quietly degraded
 *    deployment depends on the consumer. `ADMIN_EMAILS` was exactly this for a
 *    day: read by the control plane, set by hand, synced by nothing.
 *  - The allowlist names `BAR` that nothing consumes. Harmless until somebody
 *    prunes it and cannot tell whether it was load-bearing.
 *
 * ## What this does NOT check
 *
 * That the 1Password vault actually holds these items. Nothing in CI can see
 * the vault, and a check that pretended to would be worse than none. That is
 * what `dry-run` on the sync workflow is for, and why it defaults to true.
 *
 * Run: `node scripts/check-secrets-allowlist.mjs`
 * Self-test: `node scripts/check-secrets-allowlist.mjs --self-test`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Secrets a workflow reads that the sync deliberately does not supply.
 *
 * Each needs a reason, and "it is already set" is not one — that is the state
 * this checker exists to make visible.
 */
const NOT_SYNCED = new Map([
  [
    "GITHUB_TOKEN",
    "GitHub mints it per run. It is not ours to sync and cannot be set.",
  ],
  [
    "OP_SERVICE_ACCOUNT_TOKEN",
    "The bootstrap credential: it is what authorizes the sync, so it cannot arrive through it.",
  ],
  [
    "GH_ADMIN_TOKEN",
    "The other half of the bootstrap — the PAT that writes GitHub secrets. Same reason.",
  ],
]);

function readAllowlist() {
  const raw = readFileSync(join(ROOT, "scripts/secrets-allowlist.json"), "utf8");
  const parsed = JSON.parse(raw);
  return new Set([...(parsed.required ?? []), ...(parsed.optional ?? [])]);
}

/**
 * A workflow's YAML with its comments removed.
 *
 * These files carry long prose comments, and this checker's first run failed
 * on its own documentation: the sentence "in a workflow as `secrets.NAME`"
 * became a secret called NAME that nothing synced. A checker that reads prose
 * is a checker that fails on a sentence about itself — the same lesson
 * `structure.test.ts` records for its own body extractor.
 *
 * A `#` inside a quoted string is stripped from that line too. That direction
 * is a false *negative* on a secret named after such a `#`, which no workflow
 * here has; the alternative — reading comments — is a false positive that
 * fails CI on a documentation edit.
 */
export function withoutYamlComments(source) {
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return "";
      const hash = line.indexOf(" #");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

/** `secrets.NAME` across every workflow, with the files that read each. */
export function secretsReadByWorkflows(dir) {
  const readers = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const source = withoutYamlComments(readFileSync(join(dir, file), "utf8"));
    for (const match of source.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1];
      if (!readers.has(name)) readers.set(name, new Set());
      readers.get(name).add(file);
    }
  }
  return readers;
}

/** Every `op://<vault>/<NAME>/<field>` reference, as `{name, field}`. */
export function opReferences(source) {
  return [...source.matchAll(/op:\/\/[^/\s]+\/([^/\s]+)\/([^\s"']+)/g)].map(
    (match) => ({ name: match[1], field: match[2] }),
  );
}

function main() {
  const problems = [];
  const allowlist = readAllowlist();
  const readers = secretsReadByWorkflows(join(ROOT, ".github/workflows"));

  // 1. Anything a workflow reads is synced, or is exempt with a stated reason.
  for (const [name, files] of readers) {
    if (allowlist.has(name) || NOT_SYNCED.has(name)) continue;
    problems.push(
      `${name} is read by ${[...files].join(", ")} but nothing syncs it.\n` +
        `    Add it to scripts/secrets-allowlist.json, or to NOT_SYNCED in this\n` +
        `    file with the reason it cannot come from 1Password.`,
    );
  }

  // 2. Nothing in the allowlist is dead. A name nobody reads is a name nobody
  //    can safely remove later, because its purpose is no longer written down.
  for (const name of allowlist) {
    if (readers.has(name)) continue;
    problems.push(
      `${name} is in the allowlist but no workflow reads it.\n` +
        `    Either a consumer was removed and this should go, or a workflow\n` +
        `    that should read it does not.`,
    );
  }

  // 3. Local dev never reads a production credential. This is the one that put
  //    the live storage encryption key on laptops.
  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  for (const { name, field } of opReferences(envExample)) {
    if (field === "dev" || field === "dsn") continue;
    problems.push(
      `.env.example reads op://…/${name}/${field} — local dev must read the\n` +
        `    "dev" field. \`pnpm setup:secrets\` puts this on a laptop.`,
    );
  }

  if (problems.length > 0) {
    console.error("Secret wiring is inconsistent:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(
    `OK — ${allowlist.size} allowlisted secrets, ${readers.size} read by workflows, ` +
      `and .env.example reads only dev credentials.`,
  );
}

/**
 * Prove the checker is not vacuous.
 *
 * Every rule above is asserted to fire on input that breaks it, because a
 * checker whose regexes silently match nothing passes every repository.
 */
function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const readers = secretsReadByWorkflows(join(ROOT, ".github/workflows"));
  expect("finds secrets in real workflows", readers.size > 5);
  expect("finds a known one", readers.has("CONVEX_DEPLOY_KEY"));

  // The bug this checker hit on its own first run.
  const commented = withoutYamlComments(
    "# a note about secrets.PROSE_ONLY\njobs:\n  a: ${{ secrets.REAL_ONE }}\n",
  );
  expect("a commented-out secret is not read", !commented.includes("PROSE_ONLY"));
  expect("a real one still is", commented.includes("REAL_ONE"));
  const trailing = withoutYamlComments("  key: value # secrets.TRAILING\n");
  expect("a trailing comment is stripped too", !trailing.includes("TRAILING"));

  const refs = opReferences(
    'A=op://Context/RESEND_API_KEY/production\nB=op://Context/OTHER/dev\n',
  );
  expect("parses two op refs", refs.length === 2);
  expect("reads the name", refs[0].name === "RESEND_API_KEY");
  expect("reads the field", refs[0].field === "production");
  expect("reads the second field", refs[1].field === "dev");
  expect("finds nothing in empty text", opReferences("").length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${9} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
