import { pathToFileURL } from 'node:url';

// After a green staging run from a push to main, start Deploy to Production
// for that commit, so a merge reaches production without anyone pressing it
// (decided by the owner, 2026-10-23; docs/decisions/repository-and-review.md).
//
// It promotes only when everything production itself will check is already
// true: the staging run passed, CI passed on the same commit (a pull request
// runs only the Convex tests it reaches; main runs all of them), and that
// commit is still main's tip. A newer tip gets its own staging run and its own
// promotion, so an older commit is never dispatched onto a moving main.
//
// The repository variable AUTO_DEPLOY_PRODUCTION=off turns this off; the
// workflow skips the job and Deploy to Production goes back to manual.

const API = 'https://api.github.com';
const POLL_MS = 15_000;
const CI_WAIT_MS = 25 * 60_000;

function client(env, request) {
  const headers = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return async (path, init = {}) => {
    const response = await request(new URL(`${API}/repos/${env.GITHUB_REPOSITORY}${path}`), { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} failed (HTTP ${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

/** The newest CI run for the commit's push to main, once it has finished. */
async function waitForCi(api, sha, { sleep, now, log }) {
  const deadline = now() + CI_WAIT_MS;
  for (;;) {
    const data = await api(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=20`);
    const run = data.workflow_runs?.find(r => r.head_sha === sha);
    if (run?.status === 'completed') return run;
    if (now() > deadline) throw new Error(`CI for ${sha} did not finish within ${CI_WAIT_MS / 60_000} minutes; run Deploy to Production by hand once it passes.`);
    log(run ? `CI for ${sha} is ${run.status}; waiting.` : `No CI run for ${sha} yet; waiting.`);
    await sleep(POLL_MS);
  }
}

export async function promote(env, { request = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, log = console.log } = {}) {
  const sha = env.STAGED_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Missing or invalid staged commit/repository.');
  }
  if (env.STAGED_EVENT !== 'push' || env.STAGED_BRANCH !== 'main') {
    return { promoted: false, reason: `staging ran for ${env.STAGED_EVENT} on ${env.STAGED_BRANCH}, not a push to main` };
  }
  if (env.STAGED_CONCLUSION !== 'success') return { promoted: false, reason: `staging ${env.STAGED_CONCLUSION}` };
  if (!env.GH_TOKEN) throw new Error('Missing GitHub Actions token.');
  const api = client(env, request);

  const ci = await waitForCi(api, sha, { sleep, now, log });
  if (ci.conclusion !== 'success') {
    throw new Error(`CI ${ci.conclusion} on ${sha} (${ci.html_url}); production waits until main is green.`);
  }
  const tip = (await api('/commits/main')).sha;
  if (tip !== sha) return { promoted: false, reason: `main moved on to ${tip}, whose own staging run promotes it` };

  await api('/actions/workflows/deploy-production.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
  return { promoted: true, reason: `staging and CI passed on ${sha}` };
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
