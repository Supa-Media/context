import { pathToFileURL } from 'node:url';

// The run's SHA is fixed at dispatch; never resolve a moving main branch later.
export async function requireStagingRelease(env, request = fetch) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Run Deploy to Production manually from main.');
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Missing or invalid release commit/repository.');
  }
  if (!env.GH_TOKEN) throw new Error('Missing GitHub Actions read token.');
  // Started by a merge beside staging (deploy-staging.yml), the default since
  // the owner's 2026-10-23 decision: staging and main's CI are still running,
  // by design. AUTO_DEPLOY_PRODUCTION=after-staging restores the wait below
  // for every automatic release.
  if (env.ALONGSIDE_STAGING === 'true') return 'started alongside staging';
  const run = await newestRun(env, request, 'deploy-staging.yml', 'staging deployment');
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('This commit has not completed staging successfully; finish or rerun Deploy Staging before promoting it.');
  }
  // A pull request runs only the Convex tests its change reaches
  // (scripts/convex-tests.mjs); main runs the whole suite, and this is where
  // that run stops a release. A main push always runs CI, so a missing run
  // is a failure here, not a pass.
  const ci = await newestRun(env, request, 'ci.yml', 'CI on main');
  if (!ci || ci.status !== 'completed' || ci.conclusion !== 'success') {
    throw new Error('CI has not passed on this commit on main; fix or rerun it before promoting.');
  }
  return run.html_url;
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
