#!/usr/bin/env node
/**
 * A pull request description edit used to re-run Fast repository guards and
 * Tex replay required, because both listened for `edited`. That cancelled an
 * in-progress run and spent the replay check again. Those workflows no longer
 * listen for `edited`. `.github/workflows/pr-description.yml` does, and
 * re-runs them only when the owner's skip line changed
 * (`Replay skipped on the owner's call:` in scripts/tex-replay-required.mjs).
 *
 * "No replay case:", "Tex diagram: unchanged because" and "Speed budget
 * raised:" are read from the live description on the next push. A re-run
 * started here also reads the live description, so a skip-line change picks
 * them up too.
 *
 *   node scripts/pr-description.mjs --self-test
 *   PR=<n> EVENT_BODY=... node scripts/pr-description.mjs --print-body
 *   BEFORE= AFTER= HEAD_SHA= node scripts/pr-description.mjs
 */
import { execFileSync } from "node:child_process";

import { SKIP_LINE } from "./tex-replay-required.mjs";

export const WORKFLOWS = ["fast-guards.yml", "tex-replay-check.yml"];
const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/** The owner's skip line, trimmed, or "" when the body has none. */
export function skipLine(body) {
  const line = String(body ?? "")
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text.startsWith(SKIP_LINE));
  return line ?? "";
}

/** True when a description edit changed the owner's skip line. */
export function shouldRerun(before, after) {
  return skipLine(before) !== skipLine(after);
}

/**
 * The description to grade. A re-run of an older event still carries that
 * event's body, so a pull request number reads the live one. `run` throws
 * when the live read fails, and the event body stands.
 */
export function liveBody({ pr, eventBody, run }) {
  if (!pr) return eventBody ?? "";
  try {
    return String(run() ?? "").replace(/\n$/, "");
  } catch {
    return eventBody ?? "";
  }
}

/**
 * What `--print-body` writes. A pull request reads the live description (`run`).
 * With no pull request, a preset body (local precheck sets `TEX_PR_BODY`) wins
 * over the event body, so running the workflow's step locally does not wipe it.
 */
export function printedBody({ pr, eventBody, preset, run }) {
  if (!pr && preset) return preset;
  return liveBody({ pr, eventBody, run });
}

function selfTest() {
  const line = `${SKIP_LINE} config graph lands first`;
  const cases = [
    ["prose edited around no skip line", shouldRerun("Hello", "Hello world") === false],
    ["the same skip line, prose around it changed", shouldRerun(`Intro\n${line}\n`, `Intro\n${line}\nmore`) === false],
    ["a skip line added", shouldRerun("Intro", line) === true],
    ["a skip line removed", shouldRerun(line, "Intro") === true],
    ["the reason changed", shouldRerun(line, `${SKIP_LINE} a different reason`) === true],
    ["whitespace around the same line", shouldRerun(`  ${line}  `, line) === false],
    ["an empty body", shouldRerun("", "") === false],
    ["no pull request uses the event body", liveBody({ pr: "", eventBody: "event", run: () => "live" }) === "event"],
    ["a live read wins", liveBody({ pr: "1", eventBody: "event", run: () => "live\n" }) === "live"],
    ["a failed live read keeps the event body", liveBody({ pr: "1", eventBody: "event", run: () => { throw new Error("no"); } }) === "event"],
    ["no pull request keeps a preset body", printedBody({ pr: "", eventBody: "", preset: "local", run: () => "live" }) === "local"],
    ["a pull request ignores the preset and reads live", printedBody({ pr: "1", eventBody: "event", preset: "local", run: () => "live\n" }) === "live"],
  ];
  const calls = [];
  rerun("o/r", "abc123", {
    ghRun: (args) => {
      calls.push(args.join(" "));
      if (args[1] === "list") return JSON.stringify([{ databaseId: 9, status: "completed" }]);
      return "";
    },
    sleepFor: () => {
      throw new Error("waited on a finished run");
    },
  });
  const reruns = calls.filter((line) => line.startsWith("run rerun 9"));
  cases.push(["a finished run is re-run once per workflow, without waiting", reruns.length === WORKFLOWS.length && !calls.some((line) => line.includes("in_progress"))]);
  let refused = false;
  try {
    rerun("o/r", "abc123", {
      ghRun: () => JSON.stringify([{ databaseId: 4, status: "in_progress" }]),
      sleepFor: () => {},
      waitMs: -1,
    });
  } catch (error) {
    refused = error instanceof Error && /still in_progress/.test(error.message);
  }
  cases.push(["a run that is still going is not re-run", refused]);
  let failed = 0;
  for (const [name, good] of cases) {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function sleep(seconds) {
  execFileSync("sleep", [String(seconds)]);
}

/** Re-run the latest guards and replay check on this commit, once each has finished. */
export function rerun(repo, sha, { ghRun = gh, sleepFor = sleep, waitMs = 12 * 60 * 1000 } = {}) {
  for (const workflow of WORKFLOWS) {
    const started = Date.now();
    let row = null;
    for (;;) {
      const list = JSON.parse(ghRun(["run", "list", "--repo", repo, "--workflow", workflow, "--commit", sha, "--limit", "1", "--json", "databaseId,status"]));
      row = list[0] ?? null;
      if (row && !RUNNING.has(row.status)) break;
      if (Date.now() - started > waitMs) break;
      console.log(row ? `${workflow} run ${row.databaseId} is ${row.status}; waiting to re-run it` : `${workflow} has no run on ${sha.slice(0, 7)} yet`);
      sleepFor(10);
    }
    if (!row) {
      console.log(`${workflow}: no run to re-run`);
      continue;
    }
    if (RUNNING.has(row.status)) throw new Error(`${workflow} run ${row.databaseId} was still ${row.status}`);
    ghRun(["run", "rerun", String(row.databaseId), "--repo", repo]);
    console.log(`re-ran ${workflow} run ${row.databaseId}`);
  }
}

function printBody() {
  const pr = process.env.PR || process.env.PR_NUMBER || "";
  const body = printedBody({
    pr,
    eventBody: process.env.EVENT_BODY ?? "",
    preset: process.env.TEX_PR_BODY ?? "",
    run: () => gh(["pr", "view", pr, "--repo", process.env.GITHUB_REPOSITORY, "--json", "body", "--jq", ".body"]),
  });
  process.stdout.write(body);
}

if (process.argv[1]?.endsWith("pr-description.mjs")) {
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--print-body")) printBody();
  else if (!shouldRerun(process.env.BEFORE, process.env.AFTER)) {
    console.log("pr-description: the owner's skip line did not change; not re-running.");
  } else {
    const repo = process.env.GITHUB_REPOSITORY;
    const sha = process.env.HEAD_SHA;
    if (!repo || !sha) {
      console.error("pr-description: HEAD_SHA and GITHUB_REPOSITORY are required to re-run.");
      process.exit(1);
    }
    console.log("pr-description: the owner's skip line changed; re-running the guards and the replay check.");
    rerun(repo, sha);
  }
}
