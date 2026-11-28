#!/usr/bin/env node
/**
 * Whether a preview's pull request is still open, asked of GitHub during a
 * deploy run, so the run can stop early once the pull request has closed.
 *
 *   node packages/sandbox/src/still-open.mjs          reads GH_TOKEN, GITHUB_REPOSITORY and PR
 *
 * A closed (merged) pull request's preview is torn down by the deploy run's
 * last step anyway, so the deploy stops rather than spend minutes on it. When
 * the pull request is closed, the run sets PREVIEW_PR_CLOSED=true in GITHUB_ENV,
 * and every deploy step after the gate skips. When GitHub cannot say, the run
 * carries on: a deploy that carries on is harmless, because the cleanup sweep
 * leaves a preview that is still deploying alone.
 *
 * Exit 0 in every case except a bad PR number or a missing GITHUB_REPOSITORY.
 * Tests: `node --test packages/sandbox/src/still-open.test.mjs`.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PR_PATTERN = /^[1-9][0-9]{0,6}$/;

/** "open" or "closed" for pull request `pr`, or null when GitHub cannot say. */
export async function pullRequestState(token, repo, pr, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (typeof body?.state !== "string") return null;
    return body.state === "closed" ? "closed" : body.state === "open" ? "open" : null;
  } catch {
    return null;
  }
}

/** What the run does next for a pull request in `state`: the GITHUB_ENV line to set (or null) and the log message. */
export function gateLines(state, pr) {
  if (state === "closed") {
    return {
      env: "PREVIEW_PR_CLOSED=true",
      message: `Pull request #${pr} closed while its preview deployed: the remaining deploy steps are skipped, and the last step deletes the preview.`,
    };
  }
  if (state === "open") {
    return { env: null, message: `Pull request #${pr} is still open; deploying on.` };
  }
  return {
    env: null,
    message: `::warning::The state of pull request #${pr} could not be read; the deploy carries on.`,
  };
}

async function main(env = process.env) {
  const token = env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR ?? "";
  if (!PR_PATTERN.test(pr)) throw new Error(`PR '${pr}' cannot name a preview.`);
  if (!repo) throw new Error("still-open needs GITHUB_REPOSITORY");

  const state = await pullRequestState(token, repo, pr);
  const { env: line, message } = gateLines(state, pr);
  console.log(message);
  if (line) appendFileSync(env.GITHUB_ENV, `${line}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
