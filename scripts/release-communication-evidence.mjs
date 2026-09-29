#!/usr/bin/env node
/**
 * Produce facts for a human-written release update, and nothing else.
 *
 * The public devlog is written and approved outside this repository. Git
 * history by itself is not a release record: `main` reaches staging first and
 * production only after a separate manual promotion. This script therefore
 * starts from a completed `Deploy to Production` run, finds the preceding
 * successful production run, and records the first-parent commits between the
 * exact two SHAs.
 *
 * Its output is deliberately an evidence artifact, not prose and not a set of
 * roadmap states. It never edits a note, creates a GitHub Release, posts to a
 * channel, or decides which commits are worth mentioning. Those are review
 * decisions downstream of this file.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCTION_WORKFLOW = ".github/workflows/deploy-production.yml";
const PRODUCTION_WORKFLOW_ID = "deploy-production.yml";
const PRODUCTION_NAME = "Deploy to Production";
const SHA = /^[a-f0-9]{40}$/;

export function validateProductionRun(run) {
  if (run?.name !== PRODUCTION_NAME || run?.path !== PRODUCTION_WORKFLOW) {
    throw new Error("The requested run is not the production workflow.");
  }
  if (run.event !== "workflow_dispatch") {
    throw new Error("Production evidence requires a manual production promotion.");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("The production run has not completed successfully.");
  }
  if (run.head_branch !== "main") {
    throw new Error("The production run must promote main.");
  }
  if (!SHA.test(run.head_sha ?? "")) {
    throw new Error("The production run has no valid commit.");
  }
  return run;
}

export function selectPreviousProductionRun(target, runs) {
  const previous = runs
    .filter((candidate) => candidate.id !== target.id)
    .filter((candidate) => candidate.run_number < target.run_number)
    .filter((candidate) => candidate.name === PRODUCTION_NAME && candidate.path === PRODUCTION_WORKFLOW)
    .filter((candidate) => candidate.event === "workflow_dispatch")
    .filter((candidate) => candidate.status === "completed" && candidate.conclusion === "success")
    .filter((candidate) => candidate.head_branch === "main" && SHA.test(candidate.head_sha ?? ""))
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!previous) {
    throw new Error("No earlier successful production run exists; refusing to guess the release baseline.");
  }
  return previous;
}

export function parseCommitRecords(text) {
  return text
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commitSha, committedAt, subject] = record.split("\0");
      if (!SHA.test(commitSha ?? "") || !committedAt || subject === undefined) {
        throw new Error("Git returned a malformed first-parent commit record.");
      }
      const pullRequest = subject.match(/\(#(\d+)\)$/)?.[1];
      return {
        sha: commitSha,
        committedAt,
        subject,
        pullRequest: pullRequest ? Number(pullRequest) : null,
      };
    });
}

const summarizeRun = (run) => ({
  id: run.id,
  number: run.run_number,
  url: run.html_url,
  headSha: run.head_sha,
  completedAt: run.updated_at,
});

export function buildEvidence({ repository, target, previous, commits, jobs, generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    kind: "production-release-evidence",
    generatedAt,
    repository,
    publication: {
      performed: false,
      reviewRequired: true,
      note: "This artifact records production evidence. It does not edit a public note, create a GitHub Release, or post to a channel.",
    },
    productionRun: summarizeRun(target),
    previousProductionRun: summarizeRun(previous),
    interval: {
      fromExclusive: previous.head_sha,
      toInclusive: target.head_sha,
    },
    commits,
    jobs: jobs.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      url: job.html_url,
    })),
  };
}

function apiHeaders(token) {
  if (!token) throw new Error("GH_TOKEN is required to read production run evidence.");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function github(repository, token, path, params = {}) {
  const url = new URL(`https://api.github.com/repos/${repository}/${path}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

async function productionRuns(repository, token, target) {
  const runs = [];
  for (let page = 1; page <= 50; page++) {
    const data = await github(repository, token, `actions/workflows/${PRODUCTION_WORKFLOW_ID}/runs`, {
      branch: "main",
      event: "workflow_dispatch",
      per_page: "100",
      page: String(page),
    });
    const batch = data.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.some((candidate) => candidate.run_number < target.run_number && candidate.conclusion === "success")) break;
    if (batch.length < 100) break;
  }
  return runs;
}

async function jobsFor(repository, token, runId) {
  const jobs = [];
  for (let page = 1; page <= 20; page++) {
    const data = await github(repository, token, `actions/runs/${runId}/jobs`, {
      per_page: "100",
      page: String(page),
    });
    const batch = data.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) break;
  }
  return jobs;
}

function commitsBetween(previousSha, targetSha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", previousSha, targetSha], { stdio: "ignore" });
  } catch {
    throw new Error("The previous production commit is not an ancestor of the requested production commit.");
  }
  const output = execFileSync(
    "git",
    [
      "log",
      "--first-parent",
      "--reverse",
      "--format=%H%x00%cI%x00%s%x1e",
      `${previousSha}..${targetSha}`,
    ],
    { encoding: "utf8" },
  );
  return parseCommitRecords(output);
}

function releaseRunId(env) {
  if (/^\d+$/.test(env.RELEASE_RUN_ID ?? "")) return Number(env.RELEASE_RUN_ID);
  if (!env.GITHUB_EVENT_PATH) throw new Error("Set RELEASE_RUN_ID or provide a GitHub workflow event.");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  if (!Number.isInteger(event.workflow_run?.id)) {
    throw new Error("The workflow event does not name a production run.");
  }
  return event.workflow_run.id;
}

export async function main(env = process.env) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  }
  const runId = releaseRunId(env);
  const target = validateProductionRun(
    await github(env.GITHUB_REPOSITORY, env.GH_TOKEN, `actions/runs/${runId}`),
  );
  const previous = selectPreviousProductionRun(
    target,
    await productionRuns(env.GITHUB_REPOSITORY, env.GH_TOKEN, target),
  );
  const evidence = buildEvidence({
    repository: env.GITHUB_REPOSITORY,
    target,
    previous,
    commits: commitsBetween(previous.head_sha, target.head_sha),
    jobs: await jobsFor(env.GITHUB_REPOSITORY, env.GH_TOKEN, target.id),
  });

  const output = resolve(env.RELEASE_EVIDENCE_PATH ?? `artifacts/release-communication/production-${target.id}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Wrote ${evidence.commits.length} production commit record(s) to ${output}.`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Production release evidence\n\nRun [${target.id}](${target.html_url}) promoted ${target.head_sha.slice(0, 12)} after run [${previous.id}](${previous.html_url}). The artifact records ${evidence.commits.length} first-parent commit(s) and publishes nothing.\n`,
    );
  }
  return evidence;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  try {
    await main(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
