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
 * of any of them is still queued or running: first come, first served,
 * nothing cancelled. The signing-in job's secrets are read when that job
 * starts, after the earlier run has written the rotated token back, which is
 * why the wait is its own job and not a step.
 *
 * "Earlier" is by when the run's latest attempt started, then by id, not by id
 * alone: a re-run keeps its old id, and on 2026-11-13 a re-run of an older
 * replay went ahead beside a newer one already signed in, the two rotations
 * raced and the grant was revoked. And "Re-run failed jobs" does not re-run a
 * wait-turn job that passed, so the signing-in job checks once more, as its
 * first step, with `--check`: it refuses, rather than waits (its secrets are
 * already read and may be stale), when any earlier run is still active.
 *
 *   GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID node scripts/bench-runner-lock.mjs [--max-minutes 170]
 *   GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID node scripts/bench-runner-lock.mjs --check
 *   node scripts/bench-runner-lock.mjs --self-test
 */
import { execFileSync } from "node:child_process";

/** The workflows that sign in as the benchmark runner. */
export const RUNNER_WORKFLOWS = ["ai-benchmark.yml", "ai-promote.yml", "tex-replay.yml", "tex-nightly.yml"];
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** Whether run `a` comes before run `b`: its latest attempt started first, then the lower id. */
function before(a, b) {
  const at = Date.parse(a.started ?? "") || 0;
  const bt = Date.parse(b.started ?? "") || 0;
  return at !== bt ? at < bt : Number(a.id) < Number(b.id);
}

/** The earlier runs this one waits for: active, of a runner workflow, not itself, and before it. */
export function aheadOf(self, runs) {
  const me = typeof self === "object" ? self : { id: self, started: null };
  return runs
    .filter((run) => ACTIVE.has(run.status) && Number(run.id) !== Number(me.id) && before(run, me))
    .map((run) => Number(run.id))
    .sort((a, b) => a - b);
}

function activeRuns(repo) {
  const runs = [];
  for (const workflow of RUNNER_WORKFLOWS) {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      const out = execFileSync("gh", ["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`, "--jq", ".workflow_runs[] | [.id, .status, .run_started_at] | @tsv"], { encoding: "utf8" });
      for (const line of out.split("\n").filter(Boolean)) {
        const [id, state, started] = line.split("\t");
        runs.push({ id: Number(id), status: state, started });
      }
    }
  }
  return runs;
}

/** This run, with when its latest attempt started. */
function thisRun(repo, runId) {
  const started = execFileSync("gh", ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".run_started_at"], { encoding: "utf8" }).trim();
  return { id: Number(runId), started };
}

function selfTest() {
  const cases = [
    ["nothing earlier: go", aheadOf(10, [{ id: 10, status: "in_progress" }, { id: 12, status: "queued" }]), []],
    ["an earlier running run: wait", aheadOf(10, [{ id: 9, status: "in_progress" }]), [9]],
    ["an earlier queued run: wait", aheadOf(10, [{ id: 7, status: "queued" }, { id: 8, status: "completed" }]), [7]],
    ["a later run never holds an earlier one", aheadOf(10, [{ id: 11, status: "in_progress" }]), []],
    // 2026-11-13: run 9's re-run started after run 10 had signed in; by id alone it went first.
    [
      "a re-run of an older run waits for a newer run that started before it",
      aheadOf({ id: 9, started: "2026-11-13T09:48:04Z" }, [{ id: 10, status: "in_progress", started: "2026-11-13T09:42:31Z" }]),
      [10],
    ],
    [
      "a newer run is not held by an older run's later re-run",
      aheadOf({ id: 10, started: "2026-11-13T09:42:31Z" }, [{ id: 9, status: "in_progress", started: "2026-11-13T09:48:04Z" }]),
      [],
    ],
    [
      "same start: the lower id goes first",
      aheadOf({ id: 10, started: "2026-11-13T09:42:31Z" }, [{ id: 9, status: "queued", started: "2026-11-13T09:42:31Z" }]),
      [9],
    ],
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
    const self = thisRun(GITHUB_REPOSITORY, GITHUB_RUN_ID);
    if (process.argv.includes("--check")) {
      const ahead = aheadOf(self, activeRuns(GITHUB_REPOSITORY));
      if (ahead.length > 0) {
        console.error(`::error::another benchmark run (${ahead.join(", ")}) is signed in or ahead in line; signing in beside it would spend its refresh token and lose the grant. Dispatch the workflow again, or use "Re-run all jobs", never "Re-run failed jobs".`);
        process.exit(1);
      }
      console.log("bench-runner-lock: no earlier runner sign-in is active; signing in.");
      process.exit(0);
    }
    const at = process.argv.indexOf("--max-minutes");
    const maxMinutes = at === -1 ? 170 : Number(process.argv[at + 1]);
    const started = Date.now();
    for (;;) {
      const ahead = aheadOf(self, activeRuns(GITHUB_REPOSITORY));
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
