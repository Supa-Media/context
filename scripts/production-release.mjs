import { pathToFileURL } from 'node:url';

// An automatic release is dispatched on `prod-deploy/<sha>`, a branch the
// starter creates at that exact commit. workflow_dispatch cannot take a SHA,
// and dispatching `main` would ship the tip at creation time. The deployment
// event is not used: it runs the workflow file at the SHA, so a same-repo
// branch could carry a modified one. This ref is only created for a commit
// already on main, and the file that runs is the one that commit merged.
export const PRODUCTION_DEPLOY_BRANCH = 'prod-deploy/';

// The run's commit is the one this release ships. A manual press is the tip
// of main. An automatic release is the commit the pin branch points at.
export async function requireStagingRelease(env, request = fetch) {
  const ref = env.GITHUB_REF ?? '';
  const sha = env.GITHUB_SHA ?? '';
  const pin = ref.startsWith(`refs/heads/${PRODUCTION_DEPLOY_BRANCH}`) ? ref.slice(`refs/heads/${PRODUCTION_DEPLOY_BRANCH}`.length) : '';
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && ref === 'refs/heads/main';
  const pinned = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && /^[0-9a-f]{12}$/.test(pin) && sha.startsWith(pin);
  if (!manual && !pinned) {
    throw new Error('Run Deploy to Production manually from main.');
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Missing or invalid release commit/repository.');
  }
  if (!env.GH_TOKEN) throw new Error('Missing GitHub Actions read token.');
  await assertCommitOnMain(env, request, env.GITHUB_SHA);
  // Staging is not a gate (owner, 2026-11-17): a collapsed or pending staging
  // run was holding every release. Deploy Staging still runs on its own.
  // A pull request runs only the Convex tests its change reaches
  // (scripts/convex-tests.mjs); main runs the whole suite, and this is where
  // that run stops a release. Only the workflow conclusion counts, so a job
  // skipped for a docs-only diff does not fail a green run. A missing run, a
  // failed newest run, or a run that was not a push to main is a failure: a
  // skipped workflow did not prove the commit.
  const ci = await newestRun(env, request, 'ci.yml', 'CI on main');
  if (!ci || ci.event !== 'push' || ci.status !== 'completed' || ci.conclusion !== 'success') {
    throw new Error('CI has not passed on this commit on main; fix or rerun it before promoting.');
  }
  return ci.html_url;
}

// `ahead` means main contains the commit. `identical` means it is the tip.
export async function assertCommitOnMain(env, request, sha) {
  const url = new URL(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/compare/${sha}...main`);
  const response = await request(url, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Unable to verify the commit is on main (HTTP ${response.status}).`);
  const data = await response.json();
  if (data.status === 'ahead' || data.status === 'identical') return;
  throw new Error(`Commit is not on main (${data.status ?? 'unknown'}).`);
}

async function newestRun(env, request, workflow, what) {
  const url = new URL(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs`);
  url.search = new URLSearchParams({ branch: 'main', head_sha: env.GITHUB_SHA, per_page: '100' }).toString();
  const response = await request(url, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Unable to verify ${what} (HTTP ${response.status}).`);
  const data = await response.json();
  // GitHub returns newest first. A failed/pending rerun must not be hidden by
  // an older successful run of the same commit.
  return data.workflow_runs?.find(r => r.head_sha === env.GITHUB_SHA && r.head_branch === 'main');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`Releasing ${process.env.GITHUB_SHA}: ${await requireStagingRelease(process.env)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
