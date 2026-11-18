import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { requireStagingRelease } from './production-release.mjs';
import { parseOnBlock } from './check-workflow-triggers.mjs';

const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/app', GH_TOKEN: 'fake-test-token' };
const good = { head_sha: env.GITHUB_SHA, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'push', html_url: 'https://example.com/run' };
const reply = runs => async (url) => {
  if (String(url.pathname).includes('/compare/')) return { ok: true, json: async () => ({ status: 'identical' }) };
  return { ok: true, json: async () => ({ workflow_runs: runs }) };
};

test('promotion verifies the dispatch commit rather than the current main tip', async () => {
  const url = await requireStagingRelease(env, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    if (String(url.pathname).includes('/compare/')) {
      assert.match(url.pathname, new RegExp(`/compare/${env.GITHUB_SHA}\\.\\.\\.main$`));
      return { ok: true, json: async () => ({ status: 'identical' }) };
    }
    assert.equal(url.searchParams.get('head_sha'), env.GITHUB_SHA);
    assert.equal(url.searchParams.get('branch'), 'main');
    return { ok: true, json: async () => ({ workflow_runs: [good] }) };
  });
  assert.equal(url, good.html_url);
});

test('a commit whose CI on main failed, is pending or never ran cannot be promoted', async () => {
  const ci = { ...good, html_url: 'https://example.com/ci' };
  for (const runs of [[], [{ ...ci, conclusion: 'failure' }], [{ ...ci, status: 'in_progress' }], [{ ...ci, head_sha: 'b'.repeat(40) }], [{ ...ci, conclusion: 'skipped' }], [{ ...ci, event: 'pull_request' }], [{ ...ci, conclusion: 'failure' }, ci]]) {
    const request = async (url) => {
      if (String(url.pathname).includes('/compare/')) return { ok: true, json: async () => ({ status: 'identical' }) };
      return { ok: true, json: async () => ({ workflow_runs: url.pathname.endsWith('/ci.yml/runs') ? runs : [good] }) };
    };
    await assert.rejects(requireStagingRelease(env, request), /CI has not passed/);
  }
  // A green conclusion is enough. A skipped job listed beside it is not consulted.
  const asked = [];
  const newer = 'c'.repeat(40);
  await requireStagingRelease(env, async (url) => {
    asked.push(String(url.pathname).includes('/compare/') ? 'compare' : url.pathname.split('/').at(-2));
    if (String(url.pathname).includes('/compare/')) {
      return { ok: true, json: async () => ({ status: 'ahead', ahead_by: 1, commits: [{ sha: newer }] }) };
    }
    const sha = url.searchParams.get('head_sha');
    const run = sha === newer
      ? { ...good, head_sha: newer, conclusion: 'failure' }
      : { ...good, jobs: [{ name: 'ci / Test Shared Package', conclusion: 'skipped' }] };
    return { ok: true, json: async () => ({ workflow_runs: [run] }) };
  });
  assert.deepEqual(asked, ['compare', 'ci.yml', 'ci.yml']);
  assert.ok(!asked.includes('deploy-staging.yml'));
});

test('a deploy stops before it changes anything when a newer commit is already green', async () => {
  const newer = 'c'.repeat(40);
  const cancelled = [];
  const request = async (url, init = {}) => {
    if (String(url.pathname).endsWith('/cancel')) {
      cancelled.push(init.method);
      return { ok: true, status: 202, json: async () => ({}) };
    }
    if (String(url.pathname).includes('/compare/')) {
      return { ok: true, json: async () => ({ status: 'ahead', commits: [{ sha: newer }] }) };
    }
    const sha = url.searchParams.get('head_sha');
    const run = sha === newer ? { ...good, head_sha: newer } : good;
    return { ok: true, json: async () => ({ workflow_runs: [run] }) };
  };
  await assert.rejects(requireStagingRelease({ ...env, GITHUB_RUN_ID: '99' }, request), /superseded/);
  assert.deepEqual(cancelled, ['POST']);
  await assert.rejects(requireStagingRelease(env, request), /superseded/);
});

test('a newer commit whose CI is still running or red does not block this deploy', async () => {
  const newer = 'c'.repeat(40);
  for (const run of [
    { ...good, head_sha: newer, status: 'in_progress', conclusion: null },
    { ...good, head_sha: newer, conclusion: 'failure' },
    { ...good, head_sha: newer, conclusion: 'skipped' },
  ]) {
    const request = async (url) => {
      if (String(url.pathname).includes('/compare/')) {
        return { ok: true, json: async () => ({ status: 'ahead', commits: [{ sha: newer }] }) };
      }
      const sha = url.searchParams.get('head_sha');
      return { ok: true, json: async () => ({ workflow_runs: [sha === newer ? run : good] }) };
    };
    assert.equal(await requireStagingRelease(env, request), good.html_url);
  }
});

test('a pin branch deploys its commit only when the name matches and the commit is on main', async () => {
  const pin = `refs/heads/prod-deploy/${env.GITHUB_SHA.slice(0, 12)}`;
  const pinned = { ...env, GITHUB_REF: pin };
  assert.equal(await requireStagingRelease(pinned, reply([good])), good.html_url);
  await assert.rejects(requireStagingRelease(pinned, async (url) => {
    assert.match(url.pathname, /\/compare\//);
    return { ok: true, json: async () => ({ status: 'diverged' }) };
  }), /not on main/);
  await assert.rejects(requireStagingRelease({ ...pinned, GITHUB_REF: `refs/heads/prod-deploy/${'b'.repeat(12)}` }, () => assert.fail('must reject before API access')), /manually from main/);
});

test('a merge no longer starts production before CI, and nothing can skip the check', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  assert.equal(readdirSync(dir).includes('deploy-production-start.yml'), false);
  const staging = readFileSync(new URL('deploy-staging.yml', dir), 'utf8');
  assert.doesNotMatch(staging, /gh workflow run deploy-production/);
  const production = readFileSync(new URL('deploy-production.yml', dir), 'utf8');
  assert.doesNotMatch(production, /alongside_staging|ALONGSIDE_STAGING/);
  assert.doesNotMatch(production, /^ {2}deployment:/m);
  const promote = readFileSync(new URL('promote-production.yml', dir), 'utf8');
  assert.match(promote, /workflows: \["CI"\]/);
  assert.doesNotMatch(promote, /Deploy Staging/);
  assert.match(promote, /vars\.AUTO_DEPLOY_PRODUCTION != 'off'/);
  assert.doesNotMatch(promote, /gh workflow run deploy-/);
});

test('automatic events and non-main refs cannot promote', async () => {
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/main' }, { GITHUB_REF: 'refs/heads/prod-deploy/short' }]) {
    await assert.rejects(requireStagingRelease({ ...env, ...change }, () => assert.fail('must reject before API access')), /manually from main/);
  }
});

test('a release does not ask whether staging succeeded', async () => {
  const seen = [];
  await requireStagingRelease(env, async (url) => {
    seen.push(url.pathname);
    if (String(url.pathname).includes('/compare/')) return { ok: true, json: async () => ({ status: 'identical' }) };
    return { ok: true, json: async () => ({ workflow_runs: [good] }) };
  });
  assert.ok(seen.every(path => !path.includes('deploy-staging')));
  await assert.rejects(requireStagingRelease(env, async () => ({ ok: false, status: 403 })), /HTTP 403/);
});

test('only staging can deploy automatically; production services share one manual entry point', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const production = readFileSync(new URL('deploy-production.yml', dir), 'utf8');
  assert.deepEqual([...parseOnBlock(production).keys()], ['workflow_dispatch']);
  assert.match(production, /run: node scripts\/production-release\.mjs/);
  for (const name of readdirSync(dir).filter(n => /^deploy-.*\.yml$/.test(n))) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    const triggers = parseOnBlock(text);
    if (name === 'deploy-staging.yml') {
      assert.deepEqual(triggers.get('push'), { branches: ['main'] });
      continue;
    }
    for (const trigger of triggers.keys()) assert.ok(['workflow_call', 'workflow_dispatch'].includes(trigger), `${name} may not deploy on ${trigger}`);
    if (triggers.has('workflow_call')) {
      assert.deepEqual([...triggers.keys()], ['workflow_call']);
      // The desktop app is the one manual release outside production's action
      // (deploy-desktop.yml, workflow_dispatch only), and its Linux half is a
      // workflow it calls; nothing else may call a deploy workflow.
      const desktop = readFileSync(new URL('deploy-desktop.yml', dir), 'utf8');
      const caller = name === 'deploy-desktop-linux.yml' ? desktop : production;
      assert.ok(caller.includes(`uses: ./.github/workflows/${name}`), `${name} must be in the production action`);
    }
  }
  assert.match(production, /convex:\s+needs: validate/);
  assert.match(production, /web:\s+needs: validate/);
  assert.match(production, /uses: \.\/\.github\/workflows\/build-web\.yml/);
  assert.match(production, /gateway-test:\n    name: Test gateway\n    needs: validate\n/);
  assert.match(production, /with:\n      phase: test\n/);
  assert.match(production, /gateway:\n    needs: \[validate, convex, gateway-test\]\n/);
  assert.match(production, /phase: deploy\n/);
  assert.doesNotMatch(production, /tested_in_staging:\s*true/);
  assert.match(production, /router:\s+needs: \[validate, convex, gateway, email, transcribe, egress, web\]/);
  assert.match(production, /mobile-publish:\n    name: Start OTA publish\n    needs: \[validate, convex, gateway, email, transcribe, egress, mobile-bundle\]/);
  assert.match(production, /gh workflow run deploy-production-ota\.yml --repo "\$GH_REPO" --ref main/);
  assert.doesNotMatch(production, /phase: publish/);
  // The OTA bundle exports beside the backends. The upload is a later workflow,
  // so it does not hold this deploy, and it publishes that exact export.
  assert.match(production, /mobile-bundle:\s+needs: validate\n/);
  assert.match(production, /cancel-in-progress: false/);
  const bundle = readFileSync(new URL('build-mobile-ota.yml', dir), 'utf8');
  assert.match(bundle, /expo export --output-dir dist --dump-sourcemap --dump-assetmap --platform ios --platform android/);
  const ota = readFileSync(new URL('deploy-production-ota.yml', dir), 'utf8');
  assert.deepEqual([...parseOnBlock(ota).keys()], ['workflow_dispatch']);
  assert.match(ota, /cancel-in-progress: false/);
  assert.match(ota, /ref: \$\{\{ inputs\.deploy_sha \}\}/);
  assert.match(ota, /run-id: \$\{\{ inputs\.source_run_id \}\}/);
  assert.match(ota, /eas update --branch production --skip-bundler --input-dir dist/);
  const staging = readFileSync(new URL('deploy-staging.yml', dir), 'utf8');
  assert.match(staging, /ota:\n    name: Publish OTA\n    needs: \[plan, convex, workers, ota-bundle\]/);
  assert.match(staging, /ota-bundle:\n    name: Build OTA bundle\n    needs: plan\n/);
  assert.match(staging, /eas update --branch staging --skip-bundler --input-dir dist/);
  // Worker installs select by package name: `./apps/mcp...` (a bare path
  // selector) installs the directory without its workspace dependencies.
  assert.match(staging, /pnpm install --filter "\$\{\{ matrix\.worker\.package \}\}\.\.\."/);
  assert.doesNotMatch(staging, /--filter "\.\/\$\{\{ matrix\.worker\.dir/);
  // Every deploy job waits on the staging check, directly or through Convex.
  const jobs = production.slice(production.indexOf('\njobs:\n')).split(/^  (?=[a-z-]+:$)/m).slice(1);
  assert.ok(jobs.length >= 9, 'expected validate and every component job');
  for (const job of jobs) {
    const id = job.split(':')[0].trim();
    if (id === 'validate') continue;
    assert.match(job, /needs: (validate|\[validate,)/, `${id} must need validate`);
  }
});

test('web is one artifact and a failed router release restores its exact prior version', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const web = readFileSync(new URL('build-web.yml', dir), 'utf8');
  const router = readFileSync(new URL('deploy-router.yml', dir), 'utf8');
  const rollback = readFileSync(new URL('rollback-router.yml', dir), 'utf8');
  assert.match(web, /name: production-web/);
  assert.doesNotMatch(web, /eas deploy|expo\/expo-github-action/);
  assert.match(router, /name: production-web/);
  assert.match(router, /wrangler deployments status --json/);
  assert.match(router, /wrangler rollback "\$previous" --yes/);
  assert.match(router, /https:\/\/context\.lc\/console\/storage/);
  const secret = router.indexOf('wrangler secret put CONVEX_ORIGIN');
  const stable = router.indexOf('wrangler deployments status --json');
  const deploy = router.indexOf('wrangler deploy --message');
  assert.ok(stable !== -1 && deploy > stable && secret > deploy, 'capture the rollback target, deploy code and assets, then sync the secret');
  assert.match(rollback, /wrangler rollback "\$VERSION_ID" --yes/);
});

test('production decides what to deploy only after proving CI passed', () => {
  const production = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  const proof = production.indexOf('run: node scripts/production-release.mjs');
  const plan = production.indexOf('run: node scripts/deploy-plan.mjs --target production');
  assert.match(production, /name: Require a green CI run on main/);
  assert.doesNotMatch(production, /Require a successful staging deployment/);
  assert.ok(proof !== -1 && plan > proof, 'the CI proof must run before the plan, in the same job');
});

// POST /actions/runs/{id}/cancel needs actions: write. The workflow token is
// actions: read, and a job permissions block replaces it, so validate has to
// restate contents and packages. mobile-publish already dispatches the OTA
// workflow and is the only other job with actions: write.
test('validate can cancel its own run, and other jobs do not gain actions: write', () => {
  const production = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  const header = production.slice(0, production.indexOf('\njobs:\n'));
  assert.match(header, /permissions:\n  contents: read\n  packages: read\n  actions: read\n/);
  const jobs = production.slice(production.indexOf('\njobs:\n')).split(/^  (?=[a-z-]+:$)/m).slice(1);
  assert.ok(jobs.length >= 9);
  for (const job of jobs) {
    const id = job.split(':')[0].trim();
    if (id === 'validate') {
      assert.match(job, /permissions:\n      contents: read\n      packages: read\n      actions: write\n/);
      continue;
    }
    if (id === 'mobile-publish') {
      assert.match(job, /permissions:\n      actions: write\n      contents: read\n/);
      continue;
    }
    assert.doesNotMatch(job, /^\s*permissions:/m, `${id} keeps the workflow token`);
  }
});

// The Mac app's updater reads `latest-mac.yml` from the release GitHub calls
// latest. A machine-runner release has no such file, so if it takes that pointer
// every installed app says "could not check for updates" (2026-11-05).
test('a machine-runner release never becomes the release the Mac app updates from', () => {
  const text = readFileSync(new URL('../.github/workflows/release-machine-runner.yml', import.meta.url), 'utf8');
  const steps = text.split(/\n\s*- (?=uses:|name:)/).filter((step) => /softprops\/action-gh-release/.test(step));
  assert.ok(steps.length > 0, 'the release step is found');
  for (const step of steps) assert.match(step, /\n\s*make_latest:\s*false\s*\n/);
});
