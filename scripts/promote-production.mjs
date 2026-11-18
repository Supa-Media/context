import { pathToFileURL } from 'node:url';
import { PRODUCTION_DEPLOY_BRANCH } from './production-release.mjs';

// After CI succeeds on a push to main, start Deploy to Production for the
// newest commit on main whose CI succeeded (decided by the owner, 2026-11-17;
// docs/decisions/repository-and-review.md). Staging is not consulted. A
// collapsed or still-pending staging run must not hold a release.
//
// The commit deployed is that SHA, not the branch tip at dispatch time.
// workflow_dispatch cannot take a SHA, and `ref: main` would ship whatever
// landed in the gap, including a commit CI has not passed. A `prod-deploy/`
// branch at the commit pins it. The deployment event is not used, because
// that runs the workflow file at the SHA and a same-repo branch could carry
// a modified one. Deploy to Production checks CI and that the commit is
// still on main before it changes anything.
//
// Only the CI workflow's conclusion is read. A job skipped inside a green
// run (docs-only diffs, conditional suites) does not block the release. A
// skipped CI workflow is not a success, so that commit is not deployed, and
// the next green run still is.
//
// One starter runs and one waits. Each pass picks the newest green commit,
// so a burst leaves at most one production run in progress and one queued.
// A queued deploy of any other commit is cancelled here. Concurrency on
// Deploy to Production does the same, and this does not depend on it.
// An in-progress production run is not cancelled: it may already have
// deployed. Its own first step stops instead, before it changes anything,
// when a newer commit is already green (scripts/production-release.mjs).

const API = 'https://api.github.com';
const COMMIT_LIMIT = 30;

function client(env, request) {
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return async (path, init = {}) => {
    const response = await request(new URL(`${API}/repos/${env.GITHUB_REPOSITORY}${path}`), { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed (HTTP ${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

function refuse(env) {
  if (!/^[a-f0-9]{40}$/.test(env.EVENT_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Missing or invalid commit/repository.');
  }
  if (env.EVENT_REPO !== env.GITHUB_REPOSITORY) return `event repository ${env.EVENT_REPO}`;
  if (env.EVENT_BRANCH !== 'main') return `branch ${env.EVENT_BRANCH}`;
  if (env.EVENT_CONCLUSION !== 'success') return `conclusion ${env.EVENT_CONCLUSION}`;
  if (env.EVENT_WORKFLOW !== 'CI') return `workflow ${env.EVENT_WORKFLOW}`;
  if (env.EVENT_EVENT !== 'push') return `CI ran for ${env.EVENT_EVENT}, not a push to main`;
  return null;
}

function onMain(run, sha) {
  return run?.head_sha === sha && run.head_branch === 'main';
}

async function newestRun(api, sha) {
  const params = new URLSearchParams({ branch: 'main', head_sha: sha, event: 'push', per_page: '20' });
  const data = await api(`/actions/workflows/ci.yml/runs?${params}`);
  return (data.workflow_runs ?? []).find(run => onMain(run, sha) && run.event === 'push') ?? null;
}

function succeeded(run) {
  return run?.status === 'completed' && run.conclusion === 'success';
}

// Newest commit on main whose newest CI push succeeded. A red, skipped, or
// still-running tip is skipped so an older green commit can still ship.
async function select(api) {
  const commits = await api(`/commits?sha=main&per_page=${COMMIT_LIMIT}`);
  if (!Array.isArray(commits)) throw new Error('Commit list was not a list.');
  for (const commit of commits) {
    const sha = commit.sha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) continue;
    if (succeeded(await newestRun(api, sha))) return sha;
  }
  return null;
}

const QUEUED = new Set(['queued', 'waiting', 'pending', 'requested']);

// A queued run has not deployed. Cancelling it lets the newest pin take
// the one waiting slot. An in-progress run is left alone.
async function cancelQueuedOthers(api, sha) {
  const data = await api('/actions/workflows/deploy-production.yml/runs?per_page=30');
  let cancelled = 0;
  for (const run of data.workflow_runs ?? []) {
    if (run.head_sha === sha || !QUEUED.has(run.status) || !run.id) continue;
    await api(`/actions/runs/${run.id}/cancel`, { method: 'POST' });
    cancelled += 1;
  }
  return cancelled;
}

async function dispatchDecision(api, sha) {
  const data = await api(`/actions/workflows/deploy-production.yml/runs?head_sha=${sha}&per_page=5`);
  const newest = (data.workflow_runs ?? []).find(run => run.head_sha === sha);
  if (newest && newest.status !== 'completed') return `deploy already ${newest.status} for ${sha}`;
  if (newest?.conclusion === 'success') return `production already succeeded for ${sha}`;
  return 'dispatch';
}

async function openDeployment(api, sha) {
  const branch = `${PRODUCTION_DEPLOY_BRANCH}${sha.slice(0, 12)}`;
  const ref = `refs/heads/${branch}`;
  try {
    await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref, sha }) });
  } catch (error) {
    if (!/HTTP 422/.test(error.message)) throw error;
    await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha, force: true }) });
  }
  await api('/actions/workflows/deploy-production.yml/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: branch }),
  });
}

export async function promote(env, { request = fetch, log = console.log } = {}) {
  const skipped = refuse(env);
  if (skipped) return { promoted: false, reason: skipped };
  if (!env.GH_TOKEN) throw new Error('Missing GitHub Actions token.');
  const api = client(env, request);
  const sha = await select(api);
  if (!sha) return { promoted: false, reason: 'no commit on main has a green CI run' };
  const cancelled = await cancelQueuedOthers(api, sha);
  if (cancelled) log(`Cancelled ${cancelled} queued deploy${cancelled === 1 ? '' : 's'} of an older commit.`);
  const decision = await dispatchDecision(api, sha);
  if (decision !== 'dispatch') return { promoted: false, reason: decision, sha };
  await openDeployment(api, sha);
  log(`CI passed on ${sha}.`);
  return { promoted: true, sha, reason: `CI passed on ${sha}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { promoted, reason } = await promote(process.env);
    console.log(promoted ? `Started Deploy to Production: ${reason}.` : `Not promoting: ${reason}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
