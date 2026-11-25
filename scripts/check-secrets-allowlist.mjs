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
 * Since 2026-11-18 the allowlist also names `variables`: public identifiers
 * the sync writes as GitHub Environment variables, read as `vars.NAME`, to
 * keep them out of the 100-secret cap. While production still holds the old
 * secrets, a variable's name may be read as a secret only as the fallback
 * `vars.NAME || secrets.NAME`; any other `secrets.NAME` read of it would break
 * the day that secret is deleted.
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
import { allowlistProblems, loadAllowlist } from "./secrets-sync-plan.mjs";

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
  [
    "BENCH_SECRET_WRITER_TOKEN",
    "A fine-grained GitHub token (this repository only, Environments read/write and Metadata read, expires 2027-11-18) used by the Lab run and Tex replay writer jobs to store the rotated benchmark refresh token. It is minted in GitHub, not in 1Password: putting it through the vault sync would hand the credential that writes environment secrets to the same admin path this token exists to keep off branch code. A person rotates it before it expires.",
  ],
  [
    "Sentry",
    "Local development reads the Sentry item's dsn field; no deploy workflow reads a Sentry secret today.",
  ],
  [
    "BENCH_RUNNER_REFRESH_TOKEN",
    "The benchmark runner's seed refresh token, set in GitHub directly from `pnpm ai connect` output. The gateway rotates it on first use and revokes the grant on a replay, so any vault copy is stale after the next renewal or run; syncing it would overwrite the working seed with a dead one (this revoked the grant on 2026-11-17).",
  ],
  [
    "BENCH_RUNNER_REFRESH_TOKEN_LIVE",
    "Written by ai-benchmark.yml itself: the gateway rotates the benchmark runner's refresh token on every use, and a sync from the vault would restore the retired seed (BENCH_RUNNER_REFRESH_TOKEN), which the gateway treats as a replay and answers by revoking the grant.",
  ],
  ...["GH_DATA_APP_ID", "GH_DATA_APP_SLUG", "GH_DATA_CLIENT_ID", "GH_DATA_CLIENT_SECRET", "GH_DATA_PRIVATE_KEY"].map((name) => [
    name,
    "The read-only GitHub App that workspace owners install as a data source. The owner made its private key and client secret in GitHub and set all five as repository secrets directly (2026-11-25), with the key file deleted from their computer; it is never in the vault. Only deploy-mcp.yml reads them, and the gateway answers 501 for GitHub without them.",
  ]),
  // The Lab's runner slots 1..3 (scripts/lab-runner-lease.mjs). A slot's client id and
  // refresh token come from `pnpm ai connect --lab-slot N`; tex-lab-run.yml then writes the
  // rotated refresh token back after every run. The same rule as the live token above.
  ...[1, 2, 3].flatMap((slot) => [
    [
      `LAB_RUNNER_${slot}_CLIENT_ID`,
      `Written by \`pnpm ai connect --lab-slot ${slot}\` once, by a person, straight into the production environment; never synced from the vault. It is not a secret the vault could hold for the grant, and a sync would only copy a value the grant already keeps.`,
    ],
    [
      `LAB_RUNNER_${slot}_REFRESH_TOKEN`,
      `Written by \`pnpm ai connect --lab-slot ${slot}\` and then by tex-lab-run.yml's write-token job after every run: the gateway rotates the slot's refresh token on every use, so a vault copy goes stale at the next run, and a sync would restore a spent token, which the gateway treats as a replay and answers by revoking the slot's grant.`,
    ],
  ]),
]);

/** The allowlist's secret names and variable names, as two sets. */
function readAllowlist() {
  const parsed = loadAllowlist();
  return {
    secrets: new Set([...(parsed.required ?? []), ...(parsed.optional ?? [])]),
    variables: new Set([
      ...(parsed.variables?.required ?? []),
      ...(parsed.variables?.optional ?? []),
    ]),
    problems: allowlistProblems(parsed),
  };
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

function workflowSources(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => [file, withoutYamlComments(readFileSync(join(dir, file), "utf8"))]);
}

/** `<context>.NAME` across every workflow, with the files that read each. */
function namesReadByWorkflows(dir, context) {
  const readers = new Map();
  const pattern = new RegExp(`\\b${context}\\.([A-Z][A-Z0-9_]*)`, "g");
  for (const [file, source] of workflowSources(dir)) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (!readers.has(name)) readers.set(name, new Set());
      readers.get(name).add(file);
    }
  }
  return readers;
}

/** `secrets.NAME` across every workflow, with the files that read each. */
export function secretsReadByWorkflows(dir) {
  return namesReadByWorkflows(dir, "secrets");
}

/** `vars.NAME` across every workflow, with the files that read each. */
export function varsReadByWorkflows(dir) {
  return namesReadByWorkflows(dir, "vars");
}

/**
 * The `secrets.NAME` reads in `source` that are not the transition fallback
 * `vars.NAME || secrets.NAME`. For a name the sync writes as a variable,
 * every such read is a deploy that breaks once the old secret is deleted.
 */
export function secretReadsWithoutVarFirst(source, name) {
  const all = source.match(new RegExp(`\\bsecrets\\.${name}\\b`, "g"))?.length ?? 0;
  const fallback =
    source.match(new RegExp(`\\bvars\\.${name}\\s*\\|\\|\\s*secrets\\.${name}\\b`, "g"))
      ?.length ?? 0;
  return all - fallback;
}

/**
 * Sync Secrets must write variables before secrets: during the transition a
 * deploy reads `vars.NAME || secrets.NAME`, and the order is what keeps a
 * name from being absent from both. True when the order is right.
 */
export function variablesWrittenFirst(source) {
  const code = withoutYamlComments(source);
  const variables = code.indexOf("secrets-sync-plan.mjs variables");
  const secrets = code.indexOf("supa-sync-1password-to-github");
  return variables !== -1 && secrets !== -1 && variables < secrets;
}

/** Every `op://<vault>/<NAME>/<field>` reference, as `{name, field}`. */
export function opReferences(source) {
  return [...source.matchAll(/op:\/\/[^/\s]+\/([^/\s]+)\/([^\s"']+)/g)].map(
    (match) => ({ name: match[1], field: match[2] }),
  );
}

function main() {
  const problems = [];
  const { secrets: allowlist, variables, problems: shape } = readAllowlist();
  const dir = join(ROOT, ".github/workflows");
  const readers = secretsReadByWorkflows(dir);
  const varReaders = varsReadByWorkflows(dir);
  for (const problem of shape) problems.push(`scripts/secrets-allowlist.json: ${problem}`);

  // 1. Anything a workflow reads is synced, or is exempt with a stated reason.
  for (const [name, files] of readers) {
    if (allowlist.has(name) || NOT_SYNCED.has(name) || variables.has(name)) continue;
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

  // 2b. The same for variables: each is read as `vars.NAME`, and where it is
  //     still read as a secret, only as the fallback after the variable.
  for (const name of variables) {
    if (!varReaders.has(name)) {
      problems.push(
        `${name} is an allowlisted variable but no workflow reads vars.${name}.`,
      );
    }
  }
  for (const [file, source] of workflowSources(dir)) {
    for (const name of variables) {
      if (secretReadsWithoutVarFirst(source, name) > 0) {
        problems.push(
          `${file} reads secrets.${name}, but ${name} is synced as a variable.\n` +
            `    Read \`vars.${name} || secrets.${name}\` until the old secret is deleted.`,
        );
      }
    }
  }
  if (!variablesWrittenFirst(readFileSync(join(dir, "sync-secrets.yml"), "utf8"))) {
    problems.push(
      `sync-secrets.yml must sync variables (secrets-sync-plan.mjs variables)\n` +
        `    before secrets (supa-sync-1password-to-github).`,
    );
  }

  // 3. A local `op://` reference is either synced to GitHub too, or somebody
  //    wrote down why it is laptop-only. This catches the quiet half-configured
  //    deploy: `.env.example` knew a value existed, but no workflow could ever
  //    receive it from the vault.
  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  for (const { name, field } of opReferences(envExample)) {
    if (!allowlist.has(name) && !variables.has(name) && !NOT_SYNCED.has(name)) {
      problems.push(
        `.env.example reads op://…/${name}/${field}, but the 1Password sync\n` +
          `    allowlist does not name ${name}. Add it to scripts/secrets-allowlist.json,\n` +
          `    or to NOT_SYNCED in this file with the reason it is local-only.`,
      );
    }
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
    `OK — ${allowlist.size} allowlisted secrets and ${variables.size} variables, ` +
      `${readers.size} secrets read by workflows, ` +
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
  const { secrets: allowlist, variables } = readAllowlist();
  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  const unsyncedRefs = opReferences(envExample).filter(
    ({ name }) => !allowlist.has(name) && !variables.has(name) && !NOT_SYNCED.has(name),
  );
  expect("every local op reference is allowlisted or exempt", unsyncedRefs.length === 0);

  // Variables: the fallback rule and the write order.
  expect("finds a variable in real workflows", varsReadByWorkflows(join(ROOT, ".github/workflows")).has("EAS_PROJECT_ID"));
  expect(
    "the fallback form is allowed",
    secretReadsWithoutVarFirst("A: ${{ vars.APP_ORIGIN || secrets.APP_ORIGIN }}", "APP_ORIGIN") === 0,
  );
  expect(
    "a bare secret read of a variable is caught",
    secretReadsWithoutVarFirst("A: ${{ secrets.APP_ORIGIN }}\nB: ${{ vars.APP_ORIGIN || secrets.APP_ORIGIN }}", "APP_ORIGIN") === 1,
  );
  expect(
    "a longer name is not the same name",
    secretReadsWithoutVarFirst("A: ${{ secrets.SENTRY_PROJECT_SLUG }}", "SENTRY_PROJECT") === 0,
  );
  expect(
    "variables before secrets passes",
    variablesWrittenFirst("run: node scripts/secrets-sync-plan.mjs variables x\nrun: npx supa-sync-1password-to-github"),
  );
  expect(
    "secrets before variables fails",
    !variablesWrittenFirst("run: npx supa-sync-1password-to-github\nrun: node scripts/secrets-sync-plan.mjs variables x"),
  );
  expect(
    "a commented-out variables step does not count",
    !variablesWrittenFirst("# node scripts/secrets-sync-plan.mjs variables\nrun: npx supa-sync-1password-to-github"),
  );

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${17} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
