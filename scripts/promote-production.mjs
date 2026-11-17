import { pathToFileURL } from 'node:url';
import { PRODUCTION_DEPLOY_BRANCH } from './production-release.mjs';

// After CI succeeds on a push to main, start Deploy to Production for the
// newest commit on main whose CI and staging have both succeeded (decided by
// the owner, 2026-11-17; docs/decisions/repository-and-review.md). A green
// staging run is a second wake-up, so a staging re-run still ships a commit
// whose CI already passed.
//
// The commit deployed is that SHA, not the branch tip at dispatch time.
// workflow_dispatch cannot take a SHA, and `ref: main` would ship whatever
// landed in the gap, including a commit CI has not passed. A `prod-deploy/`
// branch at the commit pins it. The deployment event is not used, because
// that runs the workflow file at the SHA and a same-repo branch could carry
// a modified one. Deploy to Production checks CI, staging and that the
// commit is still on main before it changes anything.
//
// Only the CI workflow's conclusion is read. A job skipped inside a green
// run (docs-only diffs, conditional suites) does not block the release. A
// skipped CI workflow is not a success, so that commit is not deployed, and
// the next green run still is.
//
// One starter runs and one waits. Each pass picks the newest deployable
// commit, so a burst leaves at most one production run in progress and one
// queued, for the newest green SHA. An in-progress production run is not
// cancelled.

const API = 'https://api.github.com';
const POLL_MS = 15_000;
const STAGING_WAIT_MS = 20 * 60_000;
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
  if (env.EVENT_WORKFLOW === 'CI') {
    if (env.EVENT_EVENT !== 'push') return `CI ran for ${env.EVENT_EVENT}, not a push to main`;
    return null;
  }
  if (env.EVENT_WORKFLOW === 'Deploy Staging') {
    if (env.EVENT_EVENT !== 'push' && env.EVENT_EVENT !== 'workflow_dispatch') return `staging ran for ${env.EVENT_EVENT}`;
    return null;
  }
  return `workflow ${env.EVENT_WORKFLOW}`;
}

function onMain(run, sha) {
  return run?.head_sha === sha && run.head_branch === 'main';
}

async function newestRun(api, workflow, sha, event) {
  const params = new URLSearchParams({ branch: 'main', head_sha: sha, per_page: '20' });
  if (event) params.set('event', event);
  const data = await api(`/actions/workflows/${workflow}/runs?${params}`);
  return (data.workflow_runs ?? []).find(run => onMain(run, sha) && (!event || run.event === event)) ?? null;
}

function succeeded(run) {
  return run?.status === 'completed' && run.conclusion === 'success';
}

// Newest commit on main that CI has passed. `waiting` means that commit's
// staging run has not finished; a failed or cancelled staging run is skipped
// so an older commit that did finish can still ship.
async function select(api) {
  const commits = await api(`/commits?sha=main&per_page=${COMMIT_LIMIT}`);
  if (!Array.isArray(commits)) throw new Error('Commit list was not a list.');
  for (const commit of commits) {
    const sha = commit.sha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) continue;
    const ci = await newestRun(api, 'ci.yml', sha, 'push');
    // Not proved yet, or proved red. A skipped workflow is not a pass.
    // Jobs skipped inside a successful run never appear here: the conclusion
    // is already success.
    if (!succeeded(ci)) continue;
    const staging = await newestRun(api, 'deploy-staging.yml', sha);
    if (succeeded(staging)) return { sha, staging: 'ready' };
    if (!staging || staging.status !== 'completed') return { sha, staging: 'waiting' };
  }
  return null;
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

export async function promote(env, { request = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, log = console.log } = {}) {
  const skipped = refuse(env);
  if (skipped) return { promoted: false, reason: skipped };
  if (!env.GH_TOKEN) throw new Error('Missing GitHub Actions token.');
  const api = client(env, request);
  const deadline = now() + STAGING_WAIT_MS;
  // The commit whose staging we are waiting on, and the tip at the time we
  // chose it. A new tip is scanned from scratch so a newer green commit
  // replaces the one we were waiting on.
  let watch = null;

  for (;;) {
    if (watch) {
      const tip = (await api('/commits/main')).sha;
      if (tip !== watch.tip) {
        watch = null;
        continue;
      }
      const staging = await newestRun(api, 'deploy-staging.yml', watch.sha);
      if (succeeded(staging) || staging?.status === 'completed') {
        watch = null;
        continue;
      }
    } else {
      const target = await select(api);
      if (!target) return { promoted: false, reason: 'no commit on main has passed CI with staging ready or still running' };
      if (target.staging === 'ready') {
        const decision = await dispatchDecision(api, target.sha);
        if (decision !== 'dispatch') return { promoted: false, reason: decision, sha: target.sha };
        await openDeployment(api, target.sha);
        return { promoted: true, sha: target.sha, reason: `CI and staging passed on ${target.sha}` };
      }
      watch = { sha: target.sha, tip: (await api('/commits/main')).sha };
      log(`CI is green for ${target.sha}; waiting for its staging deployment.`);
    }
    if (now() > deadline) {
      throw new Error(`Staging for ${watch.sha} did not succeed within ${STAGING_WAIT_MS / 60_000} minutes; production was not started.`);
    }
    await sleep(POLL_MS);
  }
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
