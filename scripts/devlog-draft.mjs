#!/usr/bin/env node
/**
 * The Monday devlog draft: a starting point for the owner, never a post.
 *
 * Production, not merges, defines shipped. This finds the successful manual
 * `Deploy to Production` runs that completed in the past seven days, takes
 * the first-parent commits between the last production head before the
 * window and the newest one in it, and writes one week in the devlog's
 * exact format to the job summary and an artifact. In progress, exploring
 * and declined are copied from the latest published week for the owner to
 * edit.
 *
 * It writes no note, creates no release and posts nowhere; the owner copies
 * what they keep into `website/devlog.md` and publishes it themselves. See
 * `docs/decisions/release-communication.md`.
 */

import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildDraft, draftWindow, readPublishedDevlog, renderDraftSummary } from "./devlog-copy.mjs";
import {
  commitsBetween as gitCommitsBetween,
  github,
  selectPreviousProductionRun,
  validateProductionRun,
} from "./release-communication-evidence.mjs";

function isProduction(run) {
  try {
    validateProductionRun(run);
    return true;
  } catch {
    return false;
  }
}

/**
 * The production runs that completed inside the window, oldest first, and
 * the baseline: the newest successful production run before the oldest of
 * them. An empty week has no runs and no interval.
 */
export function selectWeekRuns(runs, { start, end }) {
  const production = runs.filter(isProduction);
  const inWindow = production
    .filter((run) => {
      const completed = Date.parse(run.updated_at);
      return completed > start.getTime() && completed <= end.getTime();
    })
    .sort((a, b) => a.run_number - b.run_number);
  if (inWindow.length === 0) return { runs: [], interval: null };
  const newest = inWindow[inWindow.length - 1];
  const baseline = selectPreviousProductionRun(inWindow[0], production);
  return { runs: inWindow, interval: { from: baseline.head_sha, to: newest.head_sha } };
}

async function productionRunsSince(repository, token, start) {
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const data = await github(repository, token, "actions/workflows/deploy-production.yml/runs", {
      branch: "main",
      event: "workflow_dispatch",
      status: "success",
      per_page: "100",
      page: String(page),
    });
    const batch = data.workflow_runs ?? [];
    runs.push(...batch);
    // Newest first: one successful run older than the window is the baseline.
    if (batch.some((run) => Date.parse(run.updated_at) <= start.getTime() && isProduction(run))) break;
    if (batch.length < 100) break;
  }
  return runs;
}

export async function main({
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
  listRuns = productionRunsSince,
  commitsBetween = gitCommitsBetween,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  }
  const window = draftWindow(env.DEVLOG_WINDOW_END ? new Date(env.DEVLOG_WINDOW_END) : now);
  if (Number.isNaN(window.end.getTime())) throw new Error("DEVLOG_WINDOW_END is not a date.");

  const selected = selectWeekRuns(await listRuns(env.GITHUB_REPOSITORY, env.GH_TOKEN, window.start), window);
  const commits = selected.interval ? commitsBetween(selected.interval.from, selected.interval.to) : [];

  let published = null;
  let readError = null;
  try {
    published = await readPublishedDevlog(env.DEVLOG_CONVEX_URL, fetchImpl);
  } catch (error) {
    readError = error.message;
  }

  const draft = buildDraft({ published, readError, dates: window.dates, commits });
  const summary = renderDraftSummary({ draft, runs: selected.runs, interval: selected.interval });

  const output = resolve(env.DEVLOG_DRAFT_PATH ?? "artifacts/devlog/draft-week.md");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, draft.markdown);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(`Drafted week ${draft.number}: ${draft.shipped.length} shipped line(s). Nothing was published.`);
  if (draft.note) console.log(draft.note);
  return { draft, summary };
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
