#!/usr/bin/env node
/**
 * What Sync Secrets writes to one GitHub Environment, and the half of it the
 * framework's script cannot do: environment VARIABLES.
 *
 * `scripts/secrets-allowlist.json` names three kinds of value:
 *
 *   - `required` / `optional`: credentials, written as GitHub Environment
 *     SECRETS by `supa-sync-1password-to-github` (@supa-media/scripts), exactly
 *     as before.
 *   - `variables.required` / `variables.optional`: public identifiers (an app
 *     origin, an EAS project id, a feature flag), written as GitHub
 *     Environment VARIABLES by this file. GitHub caps an environment at 100
 *     secrets, and production reached it on 2026-11-18; a value that grants
 *     nothing does not need a secret slot. A variable is NOT masked in a run's
 *     log, and this repository's logs are public, so only a value that is
 *     already public (shipped in the app, in an OAuth URL, in a mail header)
 *     or a plain on/off switch belongs there. Anything that grants access
 *     stays a secret.
 *   - `onlyIn`: a name synced to some environments and not others. Every other
 *     name goes to every environment the vault item has a field for.
 *
 * The framework script reads only `required` / `optional` (and `alwaysSet` /
 * `aliases`), so the workflow hands it `secret-allowlist <env>`'s output: the
 * allowlist with the variables and the other environments' names taken out.
 *
 * ## The variables sync
 *
 * The same two phases as the secrets sync: read and classify every variable
 * first, write nothing if a required one is missing or any read failed, then
 * write. `op read` exits 1 for every failure, so only 1Password's own
 * not-found wording counts as absent; anything else is a read error after
 * retries, never an absence (the framework's reason, sync-1password-to-github.sh).
 * An absent optional variable is kept, and deleted only under `--prune`.
 * Values are passed to `gh` on stdin and never printed.
 *
 * Run (the workflow does):
 *   node scripts/secrets-sync-plan.mjs secret-allowlist <env> <out.json>
 *   node scripts/secrets-sync-plan.mjs variables <env> --vault Context [--dry-run] [--prune]
 * Tests: `node --test scripts/secrets-sync-plan.test.mjs`
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWLIST_PATH = join(ROOT, "scripts/secrets-allowlist.json");
export const ENVIRONMENTS = ["staging", "production", "preview"];

export function loadAllowlist(path = ALLOWLIST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const list = (value) => (Array.isArray(value) ? value : []);

/** Every problem with the allowlist's shape. Empty means it is usable. */
export function allowlistProblems(cfg) {
  const problems = [];
  const secrets = [...list(cfg.required), ...list(cfg.optional)];
  const variables = [...list(cfg.variables?.required), ...list(cfg.variables?.optional)];
  const seen = new Set();
  for (const name of [...secrets, ...variables]) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) problems.push(`${name} is not an UPPER_SNAKE name`);
    if (seen.has(name)) problems.push(`${name} is listed twice (a name is a secret or a variable, never both)`);
    seen.add(name);
  }
  for (const [name, envs] of Object.entries(cfg.onlyIn ?? {})) {
    if (!seen.has(name)) problems.push(`onlyIn names ${name}, which the allowlist does not`);
    if (!Array.isArray(envs) || envs.length === 0) {
      problems.push(`onlyIn.${name} must list at least one environment`);
      continue;
    }
    for (const env of envs) {
      if (!ENVIRONMENTS.includes(env)) problems.push(`onlyIn.${name} names unknown environment ${env}`);
    }
  }
  return problems;
}

function assertEnvironment(env) {
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(`unknown environment "${env}" (expected ${ENVIRONMENTS.join(" or ")})`);
  }
}

const goesTo = (cfg, env) => (name) => {
  const only = cfg.onlyIn?.[name];
  return !only || only.includes(env);
};

/** The framework-shaped allowlist for one environment: secrets only. */
export function secretAllowlistFor(cfg, env) {
  assertEnvironment(env);
  const keep = goesTo(cfg, env);
  const out = {
    required: list(cfg.required).filter(keep),
    optional: list(cfg.optional).filter(keep),
  };
  if (cfg.alwaysSet) out.alwaysSet = cfg.alwaysSet;
  if (cfg.aliases) out.aliases = cfg.aliases;
  return out;
}

/** The variables one environment gets, each with whether it is required. */
export function variablesFor(cfg, env) {
  assertEnvironment(env);
  const keep = goesTo(cfg, env);
  return [
    ...list(cfg.variables?.required).filter(keep).map((name) => ({ name, required: true })),
    ...list(cfg.variables?.optional).filter(keep).map((name) => ({ name, required: false })),
  ];
}

/** 1Password's own not-found wording; anything else is an error, not an absence. */
export function isNotFound(message) {
  return /isn't an item in|does not have a field/.test(message);
}

/**
 * Read and classify every variable, then write (unless dry run).
 *
 * `io` is injected so the tests never touch 1Password or GitHub:
 *   read(ref) -> string (throws with the CLI's message on failure)
 *   listVariables(env) -> string[]
 *   setVariable(env, name, value), deleteVariable(env, name)
 *   log(line), sleep(ms)
 */
export async function syncVariables({ cfg, env, vault, dryRun, prune, io, attempts = 3 }) {
  const wanted = variablesFor(cfg, env);
  const present = new Set(await io.listVariables(env));
  const plan = [];
  const missingRequired = [];
  const readErrors = [];

  for (const { name, required } of wanted) {
    const ref = `op://${vault}/${name}/${env}`;
    let outcome;
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await io.read(ref);
        // GitHub refuses an empty variable, so an empty field is an absence.
        outcome = value === "" ? { status: "missing" } : { status: "found", value };
        break;
      } catch (error) {
        const message = String(error?.stderr ?? error?.message ?? error);
        if (isNotFound(message)) {
          outcome = { status: "missing" };
          break;
        }
        if (attempt >= attempts) {
          outcome = { status: "error", message };
          break;
        }
        await io.sleep(attempt * 3000);
      }
    }
    if (outcome.status === "error") {
      readErrors.push(name);
      io.log(`  ERROR   ${name} (could not read from 1Password)`);
    } else if (outcome.status === "found") {
      plan.push({ action: "set", name, value: outcome.value });
      io.log(`  SET     ${name}${present.has(name) ? "" : " (new)"}`);
    } else if (required) {
      missingRequired.push(name);
      io.log(`  MISSING ${name} (required)`);
    } else if (!present.has(name)) {
      io.log(`  ABSENT  ${name} (not in GitHub either)`);
    } else if (prune) {
      plan.push({ action: "delete", name });
      io.log(`  ABSENT  ${name} (will prune from GitHub)`);
    } else {
      io.log(`  KEEP    ${name} (in GitHub, missing from the vault)`);
    }
  }

  if (missingRequired.length > 0 || readErrors.length > 0) {
    if (missingRequired.length) io.log(`Missing required variables: ${missingRequired.join(", ")}`);
    if (readErrors.length) io.log(`Unreadable variables: ${readErrors.join(", ")}`);
    io.log("Nothing was written.");
    return { ok: false, plan, missingRequired, readErrors };
  }
  if (dryRun) {
    io.log(`Dry run: ${plan.length} change(s) planned for ${env}, nothing written.`);
    return { ok: true, plan, missingRequired, readErrors };
  }
  for (const step of plan) {
    if (step.action === "set") await io.setVariable(env, step.name, step.value);
    else await io.deleteVariable(env, step.name);
  }
  io.log(`Wrote ${plan.length} variable change(s) to ${env}.`);
  return { ok: true, plan, missingRequired, readErrors };
}

/** The real CLIs. Values go over stdin; nothing here prints one. */
export function cliIo(repo) {
  const gh = (args, input) =>
    execFileSync("gh", [...args, "--repo", repo], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  return {
    read: async (ref) =>
      execFileSync("op", ["read", "--no-newline", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    listVariables: async (env) =>
      gh(["variable", "list", "--env", env, "--json", "name", "-q", ".[].name"])
        .split("\n")
        .filter(Boolean),
    setVariable: async (env, name, value) => {
      gh(["variable", "set", name, "--env", env], value);
    },
    deleteVariable: async (env, name) => {
      gh(["variable", "delete", name, "--env", env]);
    },
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function main(argv) {
  const [command, env, ...rest] = argv;
  const cfg = loadAllowlist();
  const problems = allowlistProblems(cfg);
  if (problems.length > 0) {
    console.error(`scripts/secrets-allowlist.json is invalid:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  if (command === "secret-allowlist") {
    const out = rest[0];
    if (!out) throw new Error("usage: secret-allowlist <env> <out.json>");
    writeFileSync(out, `${JSON.stringify(secretAllowlistFor(cfg, env), null, 2)}\n`);
    console.log(`Wrote the ${env} secret allowlist to ${out}.`);
    return;
  }
  if (command === "variables") {
    const flag = (name) => rest.includes(name);
    const vaultAt = rest.indexOf("--vault");
    const vault = vaultAt === -1 ? "" : rest[vaultAt + 1];
    const repo = process.env.GITHUB_REPOSITORY;
    if (!vault || !repo) throw new Error("variables needs --vault and GITHUB_REPOSITORY");
    console.log(`Variables — 1Password op://${vault}/*/${env} to ${repo} (environment: ${env})`);
    const result = await syncVariables({
      cfg,
      env,
      vault,
      dryRun: flag("--dry-run"),
      prune: flag("--prune"),
      io: cliIo(repo),
    });
    if (!result.ok) process.exit(1);
    return;
  }
  throw new Error(`unknown command "${command}" (secret-allowlist | variables)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
