#!/usr/bin/env node
/**
 * One benchmark runner sign-in at a time, with nobody dropped (2026-11-13).
 *
 * The gateway rotates the benchmark runner's refresh token on every use and
 * revokes the grant when a spent one comes back, so the workflows that sign in
 * as the runner (AI Benchmark, AI Promote, Tex replay, Tex nightly and the
 * Test Set seed, and a Tex Lab run on slot 0) must never overlap. A Lab run
 * that leased one of its own runner slots (scripts/lab-runner-lease.mjs) never
 * spends this grant's token and does not wait here; one that found no slot
 * connected or free falls back to this grant and this lock, as before slots.
 * The list keeps tex-lab-run.yml, so the others wait for any earlier Lab run
 * (it cannot tell a slot run from a slot-0 run; waiting is the safe side). They shared one `concurrency`
 * group for that, but a group holds one
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
 * How it reads the runs (2026-11-19): the old poll asked for each of the seven
 * workflows and each of five statuses every 30 seconds, 35 calls for each
 * waiting run. That used up the repository's GITHUB_TOKEN limit and broke
 * Promote to Production and CI. It now reads the repository's queued and
 * in-progress runs (two calls, and more pages only when a status has over 100
 * runs), keeps the runner workflows here, polls every 60 to 90 seconds, and
 * waits out a rate limit instead of failing (scripts/github-rate-limit.mjs).
 * It does not window by created date: the repository starts over 2,000 runs a
 * day, so a window would page through more than ten calls, and a re-run of an
 * older run keeps its old created date, which is the case this lock exists for
 * (the 2026-11-13 incident). "waiting" needs an environment protection rule,
 * which no runner workflow's environment has. "requested" is the instant
 * before "queued", so such a run started after this one. "pending" is a run
 * held by a `concurrency` group behind a run of the same group, which is itself
 * in progress and so is seen. Those three stay in ACTIVE for aheadOf but are
 * not fetched.
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
import { backoffMs, isGhRateLimitError, retryOnRateLimit } from "./github-rate-limit.mjs";

/** The workflows that sign in as the benchmark runner. */
export const RUNNER_WORKFLOWS = ["ai-benchmark.yml", "ai-promote.yml", "tex-replay.yml", "tex-nightly.yml", "tex-lab-run.yml", "tex-test-set-seed.yml", "bench-token-salvage.yml"];
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

/** The statuses read from the repository's runs. The others in ACTIVE are not fetched (see the header). */
export const FETCHED_STATUSES = ["in_progress", "queued"];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** GitHub run objects of the runner workflows, reduced to what the lock compares. */
export function runnerRuns(workflowRuns) {
  return workflowRuns
    .filter((run) => RUNNER_WORKFLOWS.includes(String(run.path ?? "").split("@")[0].split("/").pop()))
    .map((run) => ({ id: Number(run.id), status: run.status, started: run.run_started_at }));
}

export function ghJson(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** The runner workflows' runs that are queued or in progress, by id. Fails rather than miss one past the page limit. */
export function activeRuns(repo, gh = ghJson) {
  const byId = new Map();
  for (const status of FETCHED_STATUSES) {
    let lastPageFull = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = gh(`repos/${repo}/actions/runs?status=${status}&per_page=${PAGE_SIZE}&page=${page}`).workflow_runs ?? [];
      for (const run of runnerRuns(batch)) byId.set(run.id, run);
      lastPageFull = batch.length >= PAGE_SIZE;
      if (!lastPageFull) break;
    }
    if (lastPageFull) throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} ${status} runs; the lock cannot see them all`);
  }
  return [...byId.values()];
}

/** This run, with when its latest attempt started. */
export function thisRun(repo, runId, gh = ghJson) {
  return { id: Number(runId), started: gh(`repos/${repo}/actions/runs/${runId}`).run_started_at };
}

/** How long to wait before retrying a rate-limited call; the caller's deadline caps it. */
export function ghWaitMs(error, attempt) {
  if (!isGhRateLimitError(error)) return null;
  try {
    // The rate_limit endpoint does not count against the limit, so asking it is free.
    const reset = Number(execFileSync("gh", ["api", "rate_limit", "--jq", ".resources.core.reset"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
    if (reset > 0) return Math.max(1000, reset * 1000 - Date.now() + 1000);
  } catch {
    // No reset time: back off instead.
  }
  return backoffMs(attempt);
}

/** Between polls: 60 to 90 seconds, so a waiting run asks GitHub about once a minute. */
export function pollDelayMs(random = Math.random) {
  return 60_000 + Math.floor(random() * 30_000);
}

async function selfTest() {
  const seen = [];
  const runs = await activeRuns("example/app", (path) => {
    seen.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    const status = query.get("status");
    const page = Number(query.get("page"));
    const ci = (i) => ({ id: 1000 + i, path: ".github/workflows/ci.yml", status, run_started_at: "2026-11-19T08:00:00Z" });
    if (status === "in_progress" && page === 1) {
      return { workflow_runs: [...Array.from({ length: 99 }, (_, i) => ci(i)), { id: 20, path: ".github/workflows/tex-replay.yml", status, run_started_at: "2026-11-19T10:00:00Z" }] };
    }
    if (status === "in_progress" && page === 2) {
      return {
        workflow_runs: [
          { id: 20, path: ".github/workflows/tex-replay.yml", status, run_started_at: "2026-11-19T10:00:00Z" },
          { id: 21, path: ".github/workflows/ai-benchmark.yml@refs/heads/main", status, run_started_at: "2026-11-19T10:20:00Z" },
        ],
      };
    }
    if (status === "queued" && page === 1) {
      return {
        workflow_runs: [
          { id: 15, path: ".github/workflows/ai-promote.yml", status, run_started_at: "2026-11-19T09:00:00Z" },
          { id: 16, path: ".github/workflows/ci.yml", status, run_started_at: "2026-11-19T09:00:00Z" },
          { id: 40, path: ".github/workflows/tex-nightly.yml", status, run_started_at: "2026-11-19T11:00:00Z" },
        ],
      };
    }
    return { workflow_runs: [] };
  });
  const base = "repos/example/app/actions/runs";
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
    [
      "runnerRuns keeps a tex-replay run and drops a ci.yml run",
      runnerRuns([
        { id: 1, path: ".github/workflows/tex-replay.yml", status: "queued", run_started_at: "t" },
        { id: 2, path: ".github/workflows/ci.yml", status: "queued", run_started_at: "t" },
      ]).map((run) => run.id),
      [1],
    ],
    [
      "runnerRuns strips an @refs suffix from the path",
      runnerRuns([{ id: 3, path: ".github/workflows/tex-replay.yml@refs/heads/main", status: "in_progress", run_started_at: "t" }]).map((run) => run.id),
      [3],
    ],
    [
      "runnerRuns maps run_started_at to started",
      runnerRuns([{ id: 4, path: ".github/workflows/ai-promote.yml", status: "queued", run_started_at: "2026-11-19T09:00:00Z" }]),
      [{ id: 4, status: "queued", started: "2026-11-19T09:00:00Z" }],
    ],
    [
      "activeRuns asks only for in-progress and queued runs, pages on only when a page is full, keeps a run seen twice once",
      seen,
      [`${base}?status=in_progress&per_page=100&page=1`, `${base}?status=in_progress&per_page=100&page=2`, `${base}?status=queued&per_page=100&page=1`],
    ],
    ["a run seen on two pages is kept once", runs.filter((run) => run.id === 20).length, 1],
    [
      "the active runs, fed to aheadOf, give the earlier runs",
      aheadOf({ id: 30, started: "2026-11-19T10:30:00Z" }, runs),
      [15, 20, 21],
    ],
    ["pollDelayMs at the low end is 60 s", pollDelayMs(() => 0), 60000],
    ["pollDelayMs stays under 90 s", pollDelayMs(() => 0.999999) < 90000, true],
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
  if (process.argv.includes("--self-test")) await selfTest();
  else {
    const { GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) throw new Error("set GITHUB_REPOSITORY and GITHUB_RUN_ID");
    const checking = process.argv.includes("--check");
    const at = process.argv.indexOf("--max-minutes");
    const maxMinutes = at === -1 ? 170 : Number(process.argv[at + 1]);
    // --check refuses rather than waits, so it only rides out a rate limit for ten minutes.
    const deadline = Date.now() + (checking ? 10 : maxMinutes) * 60_000;
    const fetchWithRetry = (fn) => retryOnRateLimit(fn, { deadline, waitFor: ghWaitMs });
    // In wait mode, a rate limit that outlasts the deadline is reported as a wait that gave up.
    const waitFetch = async (fn) => {
      try {
        return await fetchWithRetry(fn);
      } catch (error) {
        if (!isGhRateLimitError(error)) throw error;
        console.error(`::error::waited ${maxMinutes} min for earlier benchmark runs; the GitHub API rate limit did not reset in time`);
        process.exit(1);
      }
    };
    if (checking) {
      const self = await fetchWithRetry(() => thisRun(GITHUB_REPOSITORY, GITHUB_RUN_ID));
      const ahead = aheadOf(self, await fetchWithRetry(() => activeRuns(GITHUB_REPOSITORY)));
      if (ahead.length > 0) {
        console.error(`::error::another benchmark run (${ahead.join(", ")}) is signed in or ahead in line; signing in beside it would spend its refresh token and lose the grant. Dispatch the workflow again, or use "Re-run all jobs", never "Re-run failed jobs".`);
        process.exit(1);
      }
      console.log("bench-runner-lock: no earlier runner sign-in is active; signing in.");
      process.exit(0);
    }
    const self = await waitFetch(() => thisRun(GITHUB_REPOSITORY, GITHUB_RUN_ID));
    for (;;) {
      const ahead = aheadOf(self, await waitFetch(() => activeRuns(GITHUB_REPOSITORY)));
      if (ahead.length === 0) {
        console.log("bench-runner-lock: no earlier runner sign-in is active; going ahead.");
        break;
      }
      if (Date.now() > deadline) {
        console.error(`::error::waited ${maxMinutes} min for earlier benchmark runs (${ahead.join(", ")}); giving up rather than overlapping their sign-in.`);
        process.exit(1);
      }
      const delay = pollDelayMs();
      console.log(`bench-runner-lock: waiting for ${ahead.length} earlier run(s): ${ahead.join(", ")}; checking again in ${Math.round(delay / 1000)} s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
