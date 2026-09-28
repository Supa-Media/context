#!/usr/bin/env node
/**
 * How long pull-request checks, staging and production take, from the GitHub
 * Actions API.
 *
 * The faster CI/CD project set targets for median and 90th-percentile time and
 * measured its baseline by hand. This makes the same numbers a report anybody
 * can rerun: `GITHUB_REPOSITORY=owner/name node scripts/ci-performance-report.mjs`
 * (with `GH_TOKEN` for more than the anonymous rate limit), or the weekly `CI Performance` workflow, which
 * writes it to the run summary.
 *
 * For every pipeline it separates three things a single duration hides:
 *
 * - waiting: from the run being created to its first job starting, which for
 *   a deploy is mostly the concurrency lock held by the previous deploy;
 * - running: from the first job starting to the last update;
 * - reruns: runs whose latest attempt is not the first, the cost of a flake.
 *
 * A pull request's time is the span from its first workflow run being created
 * to its last one finishing, for one head commit: what a person waits for.
 *
 * It reads run and job metadata only: no logs, no secrets. The report fails
 * (exit 1) when this week's median is at least 25% slower than last week's
 * with at least five runs in each, which is a sustained regression rather
 * than one slow run.
 */

import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;
export const REGRESSION = 1.25;
export const MIN_RUNS = 5;

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const ms = (a, b) => new Date(b).getTime() - new Date(a).getTime();

export function duration(msValue) {
  if (msValue === null || msValue === undefined) return "n/a";
  const total = Math.round(msValue / 1000);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/**
 * Wait, run and total times for completed deploy runs. GitHub sets
 * `run_started_at` when the run is created, even while it is held by the
 * concurrency lock, so the wait comes from the first job's start, which is
 * only known for runs whose jobs were fetched (`firstJobAt`).
 */
export function deployTimings(runs, firstJobAt = new Map()) {
  return runs
    .filter((run) => run.status === "completed")
    .map((run) => {
      const started = firstJobAt.get(run.id);
      return {
        id: run.id,
        at: run.created_at,
        sha: run.head_sha,
        conclusion: run.conclusion,
        rerun: (run.run_attempt ?? 1) > 1,
        wait: started ? Math.max(0, ms(run.created_at, started)) : undefined,
        running: started ? Math.max(0, ms(started, run.updated_at)) : undefined,
        total: Math.max(0, ms(run.created_at, run.updated_at)),
      };
    });
}

/** One entry per pull-request head commit: first run created to last run done. */
export function pullRequestTimings(runs) {
  const bySha = new Map();
  for (const run of runs) {
    if (run.event !== "pull_request") continue;
    const entry = bySha.get(run.head_sha) ?? { sha: run.head_sha, runs: [] };
    entry.runs.push(run);
    bySha.set(run.head_sha, entry);
  }
  const timings = [];
  for (const { sha, runs: group } of bySha.values()) {
    if (group.some((run) => run.status !== "completed")) continue;
    const start = Math.min(...group.map((run) => new Date(run.created_at).getTime()));
    const end = Math.max(...group.map((run) => new Date(run.updated_at).getTime()));
    timings.push({
      sha,
      at: new Date(start).toISOString(),
      conclusion: group.every((run) => ["success", "skipped", "neutral"].includes(run.conclusion)) ? "success" : "failure",
      rerun: group.some((run) => (run.run_attempt ?? 1) > 1),
      total: end - start,
    });
  }
  return timings;
}

export function summarize(timings) {
  const successes = timings.filter((t) => t.conclusion === "success");
  const pick = (key) => successes.map((t) => t[key]).filter((v) => v !== undefined);
  return {
    runs: timings.length,
    failures: timings.filter((t) => t.conclusion !== "success" && t.conclusion !== "cancelled").length,
    reruns: timings.filter((t) => t.rerun).length,
    median: percentile(pick("total"), 50),
    p90: percentile(pick("total"), 90),
    fastest: percentile(pick("total"), 0),
    waitMedian: percentile(pick("wait"), 50),
    runningMedian: percentile(pick("running"), 50),
  };
}

/** This week's successful median against last week's, or null without enough runs. */
export function regression(timings, now = Date.now()) {
  const week = (from, to) =>
    timings
      .filter((t) => t.conclusion === "success")
      .filter((t) => {
        const at = new Date(t.at).getTime();
        return at >= now - from * DAY && at < now - to * DAY;
      })
      .map((t) => t.total);
  const current = week(7, 0);
  const previous = week(14, 7);
  if (current.length < MIN_RUNS || previous.length < MIN_RUNS) return null;
  const ratio = percentile(current, 50) / percentile(previous, 50);
  return { ratio, current: percentile(current, 50), previous: percentile(previous, 50), regressed: ratio >= REGRESSION };
}

/** The job and step that take longest at the median across the given runs' jobs. */
export function slowest(jobLists) {
  const jobs = new Map();
  const steps = new Map();
  const add = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const list of jobLists) {
    for (const job of list) {
      if (job.conclusion !== "success" || !job.started_at || !job.completed_at) continue;
      const name = job.name.replace(/\s*\(.*\)$/, "");
      add(jobs, name, ms(job.started_at, job.completed_at));
      for (const step of job.steps ?? []) {
        if (step.conclusion !== "success" || !step.started_at || !step.completed_at) continue;
        add(steps, `${name} → ${step.name}`, ms(step.started_at, step.completed_at));
      }
    }
  }
  const top = (map) =>
    [...map.entries()]
      .map(([name, values]) => ({ name, median: percentile(values, 50) }))
      .sort((a, b) => b.median - a.median)
      .slice(0, 3);
  return { jobs: top(jobs), steps: top(steps) };
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function api(env, path, params = {}) {
  const url = new URL(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`);
  url.search = new URLSearchParams(params).toString();
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  // A public repository's runs can be read without a token, within a small rate limit.
  if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

async function runs(env, params, pages = 5) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const data = await api(env, "actions/runs", { per_page: "100", page: String(page), ...params });
    all.push(...(data.workflow_runs ?? []));
    if ((data.workflow_runs ?? []).length < 100) break;
  }
  return all;
}

async function workflowRuns(env, file) {
  const data = await api(env, `actions/workflows/${file}/runs`, { per_page: "100" });
  return data.workflow_runs ?? [];
}

async function jobsFor(env, ids) {
  const lists = [];
  for (const id of ids) lists.push((await api(env, `actions/runs/${id}/jobs`, { per_page: "100" })).jobs ?? []);
  return lists;
}

function section(title, timings, jobs) {
  const s = summarize(timings);
  const lines = [`### ${title}`, ""];
  lines.push("| Runs | Fastest | Median | 90th percentile | Median wait | Median running | Failures | Reruns |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| ${s.runs} | ${duration(s.fastest)} | ${duration(s.median)} | ${duration(s.p90)} | ${duration(s.waitMedian)} | ${duration(s.runningMedian)} | ${s.failures} | ${s.reruns} |`);
  if (jobs) {
    lines.push("", "Wait and running times, and the slowest job and step at the median, are from the last ten successful runs.", "");
    for (const job of jobs.jobs) lines.push(`- Job: ${job.name}, ${duration(job.median)}`);
    for (const step of jobs.steps) lines.push(`- Step: ${step.name}, ${duration(step.median)}`);
  }
  const trend = regression(timings);
  lines.push("");
  if (trend) {
    lines.push(`This week's median ${duration(trend.current)} against last week's ${duration(trend.previous)} (${Math.round((trend.ratio - 1) * 100)}%)${trend.regressed ? ": **regressed**" : ""}.`);
  } else {
    lines.push(`Not enough runs in each of the last two weeks to compare (${MIN_RUNS} needed).`);
  }
  return { text: `${lines.join("\n")}\n`, regressed: Boolean(trend?.regressed) };
}

async function main(env) {
  const since = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
  const [pr, staging, production] = await Promise.all([
    runs(env, { event: "pull_request", created: `>=${since}` }),
    workflowRuns(env, "deploy-staging.yml"),
    workflowRuns(env, "deploy-production.yml"),
  ]);
  const deploys = [];
  for (const [title, list] of [["Staging", staging], ["Production", production]]) {
    const recent = list.filter((run) => run.status === "completed" && run.conclusion === "success").slice(0, 10);
    const jobs = await jobsFor(env, recent.map((run) => run.id));
    const firstJobAt = new Map();
    recent.forEach((run, i) => {
      const starts = jobs[i].map((job) => job.started_at).filter(Boolean).sort();
      if (starts.length) firstJobAt.set(run.id, starts[0]);
    });
    deploys.push(section(title, deployTimings(list, firstJobAt), slowest(jobs)));
  }
  const parts = [section("Pull requests, all checks", pullRequestTimings(pr)), ...deploys];
  const text = `## CI and deployment performance\n\nGenerated ${new Date().toISOString().slice(0, 16)}Z from the GitHub Actions API.\n\n${parts.map((p) => p.text).join("\n")}`;
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  if (parts.some((p) => p.regressed)) {
    console.error("A pipeline's median regressed by at least 25% week over week.");
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (!process.env.GITHUB_REPOSITORY) {
    console.error("Set GITHUB_REPOSITORY (owner/name), and GH_TOKEN for more than a few runs.");
    process.exit(1);
  }
  await main(process.env);
}
