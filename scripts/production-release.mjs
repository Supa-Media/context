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
  const url = new URL(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/deploy-staging.yml/runs`);
  url.search = new URLSearchParams({ branch: 'main', head_sha: env.GITHUB_SHA, per_page: '100' }).toString();
  const response = await request(url, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Unable to verify staging deployment (HTTP ${response.status}).`);
  const data = await response.json();
  // GitHub returns newest first. A failed/pending rerun must not be hidden by
  // an older successful run of the same commit.
  const run = data.workflow_runs?.find(r => r.head_sha === env.GITHUB_SHA && r.head_branch === 'main');
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('This commit has not completed staging successfully; finish or rerun Deploy Staging before promoting it.');
  }
  return run.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`Staging passed for ${process.env.GITHUB_SHA}: ${await requireStagingRelease(process.env)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
