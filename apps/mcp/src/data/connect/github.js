/**
 * GitHub's three datasets and how a run reads them, with a read-only installation token it mints itself
 * (`githubApp.js`). The source keeps them beside its `about.md`, in the data folder's `github/`:
 *
 * - `pull-requests.csv`: one row per pull request, keyed `<repo>#<number>`, with when it was opened, merged and
 *   deployed, and the lines it added and removed. Kept 400 days. A run reads the ones updated in the last three
 *   days, then carries the history back toward 90 days, a slice a run, by when they were opened.
 * - `deploys.csv`: one row per production deployment (an environment named production or prod), with its commit,
 *   when it started and finished, and how it ended. Kept 90 days.
 * - `workflow-runs.csv`: one row per finished Actions run on the repository's default branch, and per run dispatched
 *   on any branch (a production deploy dispatched on a branch at one commit), never a pull request's own runs. Kept
 *   30 days: a busy repository runs thousands a week.
 *
 * `deployed` is when the first production deployment that started at or after the merge finished successfully, so
 * "open to live" is `deployed - opened`. A pull request merged but not yet deployed is filled in by a later run.
 *
 * No body, comment, review, branch name of a pull request, commit message or file is read: a title and a login are
 * the most a row says. At most 10 repositories are read, in name order, when the owner picked none.
 */

import { cellText } from "../../sheets/csv.js";
import { appJson } from "./appFetch.js";
import { GITHUB_API, githubAppOf, githubHeaders, installationRepos, installationToken } from "./githubApp.js";

const NAME = "GitHub";
const DAY_MS = 86_400_000;
/** How far back a new source reads, then each run carries it to. */
export const GITHUB_DAYS = 90;
const RECENT_MS = 3 * DAY_MS;
export const MAX_REPOS = 10;
const MAX_PAGES = 10;
const PRODUCTION = ["production", "Production", "prod", "Prod"];

const text = (name) => ({ name, type: "text" });
const date = (name) => ({ name, type: "date" });
const number = (name) => ({ name, type: "number" });

export const GITHUB_SETS = Object.freeze([
  Object.freeze({
    dataset: "pull-requests",
    key: "id",
    date: "opened",
    keepDays: 400,
    columns: Object.freeze([text("id"), text("repo"), number("number"), text("title"), text("author"), date("opened"), date("merged"), date("deployed"), number("lines_added"), number("lines_removed")]),
  }),
  Object.freeze({
    dataset: "deploys",
    key: "id",
    date: "started",
    keepDays: 90,
    columns: Object.freeze([text("id"), text("repo"), text("sha"), text("environment"), date("started"), date("finished"), text("status")]),
  }),
  Object.freeze({
    dataset: "workflow-runs",
    key: "id",
    date: "started",
    keepDays: 30,
    columns: Object.freeze([text("id"), text("repo"), text("workflow"), text("branch"), date("started"), date("finished"), text("conclusion")]),
  }),
]);

export const GITHUB_SOURCE = Object.freeze({ app: "github", name: NAME, dataset: "pull-requests", key: "id", date: "opened", columns: GITHUB_SETS[0].columns, sets: GITHUB_SETS });

const iso = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
};
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const clip = (value, length) => String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, length);

const PR_FIELDS = "number title createdAt mergedAt updatedAt additions deletions author { login }";

export function pullRequestRow(repo, pr) {
  if (!pr || !Number.isInteger(pr.number)) return null;
  const opened = iso(pr.createdAt);
  if (opened === "") return null;
  return {
    id: `${repo}#${pr.number}`,
    repo,
    number: String(pr.number),
    title: clip(pr.title, 200),
    author: clip(pr.author?.login, 60),
    opened,
    merged: iso(pr.mergedAt),
    deployed: "",
    lines_added: Number.isFinite(pr.additions) ? String(pr.additions) : "",
    lines_removed: Number.isFinite(pr.deletions) ? String(pr.deletions) : "",
  };
}

export function deployRow(repo, node) {
  if (!node || !Number.isInteger(node.databaseId)) return null;
  const started = iso(node.createdAt);
  if (started === "") return null;
  const state = String(node.latestStatus?.state ?? "").toLowerCase();
  const ended = ["success", "failure", "error", "inactive"].includes(state);
  return {
    id: String(node.databaseId),
    repo,
    sha: clip(node.commitOid, 40),
    environment: clip(node.environment, 60),
    started,
    finished: ended ? iso(node.latestStatus?.createdAt) : "",
    status: clip(state, 20),
  };
}

export function workflowRunRow(repo, run) {
  if (!run || !Number.isInteger(run.id)) return null;
  const started = iso(run.run_started_at ?? run.created_at);
  if (started === "") return null;
  return {
    id: String(run.id),
    repo,
    workflow: clip(run.name, 120),
    branch: clip(run.head_branch, 120),
    started,
    finished: iso(run.updated_at),
    conclusion: clip(run.conclusion, 30),
  };
}

async function graphql(fetcher, token, query, variables) {
  const answered = await appJson(fetcher, `${GITHUB_API}/graphql`, { method: "POST", headers: { ...githubHeaders(token), "content-type": "application/json" }, body: JSON.stringify({ query, variables }) }, NAME);
  if (!answered.ok) return answered;
  if (Array.isArray(answered.body?.errors) && answered.body.errors.length > 0) return { ok: false, status: 200, said: "GitHub couldn't answer that question" };
  return { ok: true, data: answered.body?.data ?? null };
}

const parts = (repo) => {
  const [owner, name] = repo.split("/");
  return { owner, name };
};

/** Pull requests updated since `sinceMs`, newest first. */
async function recentPulls({ fetcher, token, repo, sinceMs }) {
  const query = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}} pageInfo{hasNextPage endCursor}}}}`;
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await graphql(fetcher, token, query, { ...parts(repo), after });
    if (!got.ok) return got;
    const block = got.data?.repository?.pullRequests;
    const nodes = Array.isArray(block?.nodes) ? block.nodes : [];
    for (const pr of nodes) {
      if (!(Date.parse(pr?.updatedAt) >= sinceMs)) return { ok: true, rows, more: false };
      const row = pullRequestRow(repo, pr);
      if (row !== null) rows.push(row);
    }
    if (block?.pageInfo?.hasNextPage !== true) return { ok: true, rows, more: false };
    after = block.pageInfo.endCursor;
  }
  return { ok: true, rows, more: true };
}

/** Pull requests opened from `fromMs` up to `beforeMs`, through GitHub's search: the history a run carries back. */
async function olderPulls({ fetcher, token, repo, fromMs, beforeMs }) {
  const query = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){nodes{... on PullRequest{${PR_FIELDS}}} pageInfo{hasNextPage endCursor}}}`;
  const q = `repo:${repo} is:pr created:${day(fromMs)}..${day(beforeMs)} sort:created-desc`;
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await graphql(fetcher, token, query, { q, after });
    if (!got.ok) return got;
    const nodes = Array.isArray(got.data?.search?.nodes) ? got.data.search.nodes : [];
    for (const pr of nodes) {
      const row = pullRequestRow(repo, pr);
      if (row !== null) rows.push(row);
    }
    if (got.data?.search?.pageInfo?.hasNextPage !== true) return { ok: true, rows, more: false };
    after = got.data.search.pageInfo.endCursor;
  }
  return { ok: true, rows, more: true };
}

/** Production deployments created since `sinceMs`, newest first. */
async function deployments({ fetcher, token, repo, sinceMs }) {
  const query = `query($owner:String!,$name:String!,$envs:[String!],$after:String){repository(owner:$owner,name:$name){deployments(first:100,after:$after,environments:$envs,orderBy:{field:CREATED_AT,direction:DESC}){nodes{databaseId commitOid environment createdAt latestStatus{state createdAt}} pageInfo{hasNextPage endCursor}}}}`;
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const got = await graphql(fetcher, token, query, { ...parts(repo), envs: PRODUCTION, after });
    if (!got.ok) return got;
    const block = got.data?.repository?.deployments;
    const nodes = Array.isArray(block?.nodes) ? block.nodes : [];
    for (const node of nodes) {
      if (!(Date.parse(node?.createdAt) >= sinceMs)) return { ok: true, rows, more: false };
      const row = deployRow(repo, node);
      if (row !== null) rows.push(row);
    }
    if (block?.pageInfo?.hasNextPage !== true) return { ok: true, rows, more: false };
    after = block.pageInfo.endCursor;
  }
  return { ok: true, rows, more: true };
}

/** The runs a run reads: the default branch's, and the ones dispatched on any branch. */
const RUN_PICKS = (branch) => [{ branch }, { event: "workflow_dispatch" }];

/** Finished runs picked by `pick` (a branch, or an event) created from `fromMs` (up to `beforeMs`, when given). */
async function workflowRuns({ fetcher, token, repo, pick, fromMs, beforeMs = null }) {
  const rows = [];
  const created = beforeMs === null ? `>=${new Date(fromMs).toISOString()}` : `${new Date(fromMs).toISOString()}..${new Date(beforeMs).toISOString()}`;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ ...pick, status: "completed", per_page: "100", page: String(page), created });
    const got = await appJson(fetcher, `${GITHUB_API}/repos/${repo}/actions/runs?${query}`, { headers: githubHeaders(token) }, NAME);
    if (!got.ok) return got;
    const runs = Array.isArray(got.body?.workflow_runs) ? got.body.workflow_runs : [];
    for (const run of runs) {
      const row = workflowRunRow(repo, run);
      if (row !== null) rows.push(row);
    }
    if (runs.length < 100) return { ok: true, rows, more: false };
  }
  return { ok: true, rows, more: true };
}

/**
 * `deployed` for each merged pull request that has none yet: when the first successful production deployment of
 * its repository that started at or after the merge finished. Answers the rows it filled.
 */
export function fillDeployed(pulls, deploys) {
  const byRepo = new Map();
  for (const deploy of deploys) {
    if (deploy.status !== "success" || deploy.finished === "") continue;
    const list = byRepo.get(deploy.repo) ?? [];
    list.push({ started: Date.parse(deploy.started), finished: deploy.finished });
    byRepo.set(deploy.repo, list);
  }
  for (const list of byRepo.values()) list.sort((a, b) => a.started - b.started);
  const filled = [];
  for (const pull of pulls) {
    if (pull.merged === "" || pull.deployed !== "") continue;
    const merged = Date.parse(pull.merged);
    const first = (byRepo.get(pull.repo) ?? []).find((deploy) => deploy.started >= merged);
    if (first) filled.push({ ...pull, deployed: first.finished });
  }
  return filled;
}

const cellOf = (value) => cellText(value).trim();
/** A kept sheet row as a pull request row of plain text cells. */
const pullOfSheet = (row) => Object.fromEntries(GITHUB_SETS[0].columns.map(({ name }) => [name, cellOf(row[name])]));
const deployOfSheet = (row) => Object.fromEntries(GITHUB_SETS[1].columns.map(({ name }) => [name, cellOf(row[name])]));

const failedOf = (got) => ({ ok: false, refused: got.refused === true, said: got.said ?? "GitHub didn't answer" });

/**
 * One run's reading: `{ok: true, sets: {<dataset>: {rows, more}}}` or `{ok: false, said, refused}`. `spans` are each
 * kept sheet's newest and oldest dates; `sheets` the kept rows, read so a pull request merged earlier gets its
 * `deployed` once a later deployment ships it.
 */
export async function readGithub({ kept, spans = {}, sheets = {}, now, fetcher, env }) {
  const app = githubAppOf(env);
  if (app === null) return { ok: false, refused: false, said: "This deployment has no GitHub App set up" };
  const minted = await installationToken({ app, installation: kept?.installation, fetcher, nowMs: now });
  if (!minted.ok) return failedOf(minted);
  const listed = await installationRepos({ token: minted.token, fetcher });
  if (!listed.ok) return failedOf(listed);
  const picked = Array.isArray(kept.repos) ? new Set(kept.repos) : null;
  const repos = listed.repos.filter((repo) => picked === null || picked.has(repo.name)).slice(0, MAX_REPOS);
  const floor = now - GITHUB_DAYS * DAY_MS;
  const span = (dataset) => spans[dataset] ?? { newestMs: Number.NaN, oldestMs: Number.NaN };
  const out = { "pull-requests": { rows: [], more: false }, deploys: { rows: [], more: false }, "workflow-runs": { rows: [], more: false } };
  const add = (dataset, got) => {
    out[dataset].rows.push(...got.rows);
    out[dataset].more ||= got.more;
  };
  for (const { name: repo, branch } of repos) {
    const pulls = span("pull-requests");
    const recent = await recentPulls({ fetcher, token: minted.token, repo, sinceMs: Number.isFinite(pulls.newestMs) ? Math.max(now - RECENT_MS, floor) : floor });
    if (!recent.ok) return failedOf(recent);
    add("pull-requests", recent);
    if (Number.isFinite(pulls.oldestMs) && pulls.oldestMs > floor + DAY_MS) {
      const older = await olderPulls({ fetcher, token: minted.token, repo, fromMs: floor, beforeMs: pulls.oldestMs });
      if (!older.ok) return failedOf(older);
      add("pull-requests", older);
    }
    const kept = span("deploys");
    const fullDeploys = !Number.isFinite(kept.oldestMs) || kept.oldestMs > floor + DAY_MS;
    const deploys = await deployments({ fetcher, token: minted.token, repo, sinceMs: fullDeploys ? floor : Math.max(now - RECENT_MS, floor) });
    if (!deploys.ok) return failedOf(deploys);
    add("deploys", deploys);
    const runs = span("workflow-runs");
    const runFloor = now - GITHUB_SETS[2].keepDays * DAY_MS;
    for (const pick of RUN_PICKS(branch)) {
      // Dispatched runs were not read before 2026-11-25, so the sheet's own span says nothing of them: read their
      // whole 30 days each run (a handful a day), and the default branch's from where the sheet ends.
      const dispatched = pick.event !== undefined;
      const fresh = await workflowRuns({ fetcher, token: minted.token, repo, pick, fromMs: !dispatched && Number.isFinite(runs.newestMs) ? Math.max(runs.newestMs - DAY_MS, runFloor) : runFloor });
      if (!fresh.ok) return failedOf(fresh);
      add("workflow-runs", fresh);
      if (!dispatched && Number.isFinite(runs.oldestMs) && runs.oldestMs > runFloor + 60 * 60_000) {
        const older = await workflowRuns({ fetcher, token: minted.token, repo, pick, fromMs: runFloor, beforeMs: runs.oldestMs });
        if (!older.ok) return failedOf(older);
        add("workflow-runs", older);
      }
    }
  }
  // A pull request read now, or kept from before, gets `deployed` from any deployment read now or kept.
  // A pull request read again keeps the `deployed` it already had: its deployment may be older than deploys.csv keeps.
  const keptById = new Map((sheets["pull-requests"] ?? []).map((row) => [String(row.id), row]));
  out["pull-requests"].rows = out["pull-requests"].rows.map((row) => {
    const before = keptById.get(row.id);
    return before && cellOf(before.deployed) !== "" && cellOf(before.merged) === row.merged ? { ...row, deployed: cellOf(before.deployed) } : row;
  });
  const incomingIds = new Set(out["pull-requests"].rows.map((row) => row.id));
  const keptPulls = (sheets["pull-requests"] ?? []).filter((row) => !incomingIds.has(String(row.id))).map(pullOfSheet);
  const allDeploys = [...(sheets.deploys ?? []).map(deployOfSheet), ...out.deploys.rows];
  const filledNow = new Map(fillDeployed(out["pull-requests"].rows, allDeploys).map((row) => [row.id, row]));
  out["pull-requests"].rows = out["pull-requests"].rows.map((row) => filledNow.get(row.id) ?? row);
  out["pull-requests"].rows.push(...fillDeployed(keptPulls, allDeploys));
  return { ok: true, sets: out, repos: repos.map((repo) => repo.name) };
}
