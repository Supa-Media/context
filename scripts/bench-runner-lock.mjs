#!/usr/bin/env node
/**
 * One benchmark runner sign-in at a time, with nobody dropped (2026-11-13).
 *
 * The gateway rotates the benchmark runner's refresh token on every use and
 * revokes the grant when a spent one comes back, so the workflows that sign in
 * as the runner (AI Benchmark, AI Promote, Tex replay, Tex nightly) must never
 * overlap. They shared one `concurrency` group for that, but a group holds one
 * running and ONE pending run: a third run cancels the pending one, which then
 * ran no job at all. With several agents dispatching Tex replay, replays
 * cancelled each other, and a cancelled replay never marked its commit, so the
 * pull request's required check stayed red with nothing to say why; a pending
 * nightly was cancelled the same way.
 *
 * So each of those workflows starts with a job that runs this and holds no
 * secret, and its signing-in job `needs:` it. This waits until no earlier run
 * (a lower run id) of any of them is still queued or running: first come,
 * first served, nothing cancelled. The signing-in job's secrets are read when
 * that job starts, after the earlier run has written the rotated token back,
 * which is why the wait is its own job and not a step.
 *
 *   GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID node scripts/bench-runner-lock.mjs [--max-minutes 170]
 *   node scripts/bench-runner-lock.mjs --self-test
 */
import { execFileSync } from "node:child_process";

/** The workflows that sign in as the benchmark runner. */
export const RUNNER_WORKFLOWS = ["ai-benchmark.yml", "ai-promote.yml", "tex-replay.yml", "tex-nightly.yml"];
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** The earlier runs this one waits for: active, of a runner workflow, with a lower id. */
export function aheadOf(runId, runs) {
  return runs.filter((run) => ACTIVE.has(run.status) && Number(run.id) < Number(runId)).map((run) => Number(run.id)).sort((a, b) => a - b);
}

function activeRuns(repo) {
  const runs = [];
  for (const workflow of RUNNER_WORKFLOWS) {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      const out = execFileSync("gh", ["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`, "--jq", ".workflow_runs[] | [.id, .status] | @tsv"], { encoding: "utf8" });
      for (const line of out.split("\n").filter(Boolean)) {
        const [id, state] = line.split("\t");
        runs.push({ id: Number(id), status: state });
      }
    }
  }
  return runs;
}

function selfTest() {
  const cases = [
    ["nothing earlier: go", aheadOf(10, [{ id: 10, status: "in_progress" }, { id: 12, status: "queued" }]), []],
    ["an earlier running run: wait", aheadOf(10, [{ id: 9, status: "in_progress" }]), [9]],
    ["an earlier queued run: wait", aheadOf(10, [{ id: 7, status: "queued" }, { id: 8, status: "completed" }]), [7]],
    ["a later run never holds an earlier one", aheadOf(10, [{ id: 11, status: "in_progress" }]), []],
  ];
  let failed = 0;
  for (const [name, got, want] of cases) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed += 1;
    console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) throw new Error("set GITHUB_REPOSITORY and GITHUB_RUN_ID");
    const at = process.argv.indexOf("--max-minutes");
    const maxMinutes = at === -1 ? 170 : Number(process.argv[at + 1]);
    const started = Date.now();
    for (;;) {
      const ahead = aheadOf(GITHUB_RUN_ID, activeRuns(GITHUB_REPOSITORY));
      if (ahead.length === 0) {
        console.log("bench-runner-lock: no earlier runner sign-in is active; going ahead.");
        break;
      }
      if (Date.now() - started > maxMinutes * 60_000) {
        console.error(`::error::waited ${maxMinutes} min for earlier benchmark runs (${ahead.join(", ")}); giving up rather than overlapping their sign-in.`);
        process.exit(1);
      }
      console.log(`bench-runner-lock: waiting for ${ahead.length} earlier run(s): ${ahead.join(", ")}`);
      execFileSync("sleep", ["30"]);
    }
  }
}
