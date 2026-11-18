#!/usr/bin/env node
/**
 * The Lab's runner slots: a Lab run takes one of three bench logins, so
 * several Lab runs can go at once (the shared benchmark runner grant is
 * one-at-a-time, see bench-runner-lock.mjs; a Lab run does not use it).
 *
 * Each slot N in 1..3 is its own OAuth grant of the bench test account,
 * made by `pnpm ai connect --lab-slot N`, and kept as two production
 * secrets: LAB_RUNNER_<N>_CLIENT_ID and LAB_RUNNER_<N>_REFRESH_TOKEN. A slot
 * is connected when both are set. The refresh token rotates on every use,
 * so tex-lab-run.yml writes it back after each run; this script never reads
 * a value, only whether one is there.
 *
 * The pool itself is a Convex table (`labRunnerLeases`, functions/labRunnerSlots.ts).
 * `acquire` polls it until a connected slot is free for this run, then writes
 * `slot=` and `attempt=` to $GITHUB_OUTPUT and nothing else. `release` frees it.
 *
 *   node scripts/lab-runner-lease.mjs acquire [--max-minutes 170]
 *   node scripts/lab-runner-lease.mjs release
 *   node scripts/lab-runner-lease.mjs --self-test
 *
 * Environment: GITHUB_REPOSITORY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GH_TOKEN
 * CONVEX_DEPLOY_KEY RUN_ID (the Convex Lab run id), the six LAB_RUNNER_* secrets
 * (acquire only), and RUNNER_TEMP for the `why` file. Nothing here prints a
 * secret: the messages name slots and counts, and the tests assert it.
 */
import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

/** The slot numbers. The same names are in scripts/secrets-allowlist.json's NOT_SYNCED list in check-secrets-allowlist.mjs. */
export const LAB_SLOTS = [1, 2, 3];
/** The Lab's workflow file: its runs are the holders the pool checks are still alive. */
export const LAB_WORKFLOW = "tex-lab-run.yml";
const ACTIVE = ["queued", "in_progress", "waiting", "requested", "pending"];
const POLL_MS = 30 * 1000;
const DEFAULT_MAX_MINUTES = 170;
const ACQUIRE_FN = "functions/labRunnerSlots:acquire";
const RELEASE_FN = "functions/labRunnerSlots:release";

export function clientIdName(slot) {
  return `LAB_RUNNER_${slot}_CLIENT_ID`;
}

export function refreshTokenName(slot) {
  return `LAB_RUNNER_${slot}_REFRESH_TOKEN`;
}

/**
 * The slots whose two secrets are both set. Returns numbers only: a value
 * never leaves this function, so a caller cannot log one by accident.
 */
export function connectedSlots(env = process.env) {
  const set = (name) => typeof env[name] === "string" && env[name].trim() !== "";
  return LAB_SLOTS.filter((slot) => set(clientIdName(slot)) && set(refreshTokenName(slot)));
}

/**
 * Run one Convex function with its JSON arguments, as tex-lab-run.yml does:
 * `npx convex run <fn> '<json>'` from the repository root. stderr is dropped:
 * it is the deploy tool's prose, and a failure is reported by its exit code.
 */
export async function convexRun(fn, args, env = process.env) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("npx", ["convex", "run", fn, JSON.stringify(args)], {
      cwd: REPO_ROOT,
      env: { ...env, CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY ?? "" },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`convex run ${fn} failed (exit ${error.code ?? "?"})`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`convex run ${fn} printed no JSON`);
  }
}

/** The GitHub run ids of the Lab workflow that are still queued or running. */
export async function activeLabRuns(repo, ghToken, env = process.env) {
  const ids = new Set();
  for (const status of ACTIVE) {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/actions/workflows/${LAB_WORKFLOW}/runs?status=${status}&per_page=100`, "--jq", ".workflow_runs[].id"],
      { encoding: "utf8", env: { ...env, GH_TOKEN: ghToken } },
    );
    for (const line of stdout.split("\n")) if (/^\d+$/.test(line.trim())) ids.add(line.trim());
  }
  return [...ids];
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a connected Lab slot and take it. Resolves to `{ code, slot?, why? }`;
 * the caller writes the files and sets the exit code. Every dependency is
 * injected so the loop runs without network: `listActive()` gives the active
 * Lab run ids, `callConvex(fn, args)` the parsed answer, `sleep(ms)`, `now()`.
 */
export async function acquireSlot({
  env,
  listActive,
  callConvex,
  sleep = sleepFor,
  now = Date.now,
  maxMinutes = DEFAULT_MAX_MINUTES,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const connected = connectedSlots(env);
  if (connected.length === 0) {
    return { code: 1, why: "no Lab runner slot is connected: run `pnpm ai connect --lab-slot 1` signed in as the bench test account (it writes both secrets)" };
  }
  const ghRunId = env.GITHUB_RUN_ID ?? "";
  const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "");
  const labRunId = env.RUN_ID ?? "";
  if (!/^\d{1,20}$/.test(ghRunId) || !Number.isInteger(attempt) || attempt < 1 || !labRunId) {
    return { code: 1, why: "the run's GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT or RUN_ID is missing" };
  }
  const started = now();
  for (;;) {
    const reply = await callConvex(ACQUIRE_FN, {
      ghRunId,
      attempt,
      labRunId,
      connected,
      active: await listActive(),
    });
    if (Number.isInteger(reply?.slot)) {
      log(`Leased Lab runner slot ${reply.slot}`);
      return { code: 0, slot: reply.slot, attempt };
    }
    const waiting = Number(reply?.waiting);
    const free = Number(reply?.free);
    if (!Number.isInteger(waiting) || !Number.isInteger(free)) {
      return { code: 1, why: "the Lab runner pool gave an answer this script does not understand" };
    }
    if (now() - started >= maxMinutes * 60_000) {
      return { code: 1, why: `waited ${maxMinutes} min for a Lab runner slot (${waiting} ahead, ${free} free); the run was not started` };
    }
    log(`Waiting for a Lab runner slot: ${waiting} ahead, ${free} free`);
    await sleep(POLL_MS);
  }
}

/** Free this run's slot. Resolves to `{ code, released }`. */
export async function releaseSlot({ env, callConvex, log = (line) => process.stdout.write(`${line}\n`) }) {
  const ghRunId = env.GITHUB_RUN_ID ?? "";
  const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "");
  if (!/^\d{1,20}$/.test(ghRunId) || !Number.isInteger(attempt) || attempt < 1) {
    return { code: 1, released: false, why: "GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT is missing" };
  }
  const reply = await callConvex(RELEASE_FN, { ghRunId, attempt });
  log(reply?.released === true ? "Released the Lab runner slot" : "No Lab runner slot was held by this run");
  return { code: 0, released: reply?.released === true };
}

/**
 * The command line: wires the real network calls and files into the functions
 * above. Every dependency is injectable, so the tests drive the same entry
 * point and read the real output and why files.
 */
export async function runCommand(argv, {
  env = process.env,
  listActive,
  callConvex = (fn, args) => convexRun(fn, args, env),
  sleep,
  now,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const [command, ...rest] = argv;
  const whyFile = join(env.RUNNER_TEMP || tmpdir(), "why");
  const fail = async (why) => {
    await writeFile(whyFile, `${why}\n`);
    log(`::error::${why}`);
    return 1;
  };
  if (command === "release") {
    const result = await releaseSlot({ env, callConvex, log });
    if (result.code !== 0) return fail(result.why);
    return 0;
  }
  if (command !== "acquire") {
    process.stderr.write("usage: node scripts/lab-runner-lease.mjs acquire [--max-minutes 170] | release\n");
    return 2;
  }
  const at = rest.indexOf("--max-minutes");
  const maxMinutes = at === -1 ? DEFAULT_MAX_MINUTES : Number(rest[at + 1]);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    process.stderr.write("--max-minutes takes a positive number\n");
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail("GITHUB_REPOSITORY is not set");
  const result = await acquireSlot({
    env,
    maxMinutes,
    listActive: listActive ?? (() => activeLabRuns(repo, env.GH_TOKEN ?? "", env)),
    callConvex,
    sleep,
    now,
    log,
  });
  if (result.code !== 0) return fail(result.why);
  if (!env.GITHUB_OUTPUT) return fail("GITHUB_OUTPUT is not set, so the slot cannot be handed to the next job");
  await appendFile(env.GITHUB_OUTPUT, `slot=${result.slot}\nattempt=${result.attempt}\n`);
  return 0;
}

/* ------------------------------- self-test ------------------------------- */

async function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };
  const FAKE = "fake-secret-value-7f3a";
  const ok = { LAB_RUNNER_1_CLIENT_ID: "c1", LAB_RUNNER_1_REFRESH_TOKEN: FAKE };
  expect("one slot with both secrets is connected", JSON.stringify(connectedSlots(ok)) === "[1]");
  expect("a slot with only its client id is not", connectedSlots({ LAB_RUNNER_2_CLIENT_ID: "c" }).length === 0);
  const r = await acquireSlot({
    env: { ...ok, GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1", RUN_ID: "k1" },
    listActive: async () => [],
    callConvex: async () => ({ slot: 1 }),
    log: () => {},
  });
  expect("a connected slot is leased", r.code === 0 && r.slot === 1);
  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Self-test passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--self-test")) await selfTest();
  else process.exitCode = await runCommand(process.argv.slice(2));
}
