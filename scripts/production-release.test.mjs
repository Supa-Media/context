import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { requireStagingRelease } from './production-release.mjs';
import { parseOnBlock } from './check-workflow-triggers.mjs';

const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/app', GH_TOKEN: 'fake-test-token' };
const good = { head_sha: env.GITHUB_SHA, head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://example.com/run' };
const reply = runs => async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) });

test('promotion verifies the dispatch commit rather than the current main tip', async () => {
  const url = await requireStagingRelease(env, async (url, options) => {
    assert.equal(url.searchParams.get('head_sha'), env.GITHUB_SHA);
    assert.equal(url.searchParams.get('branch'), 'main');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    return { ok: true, json: async () => ({ workflow_runs: [good] }) };
  });
  assert.equal(url, good.html_url);
});

test('automatic events and non-main refs cannot promote', async () => {
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REF: 'refs/tags/main' }]) {
    await assert.rejects(requireStagingRelease({ ...env, ...change }, () => assert.fail('must reject before API access')), /manually from main/);
  }
});

test('missing, failed, pending, and other-commit staging runs block production', async () => {
  for (const runs of [[], [{ ...good, conclusion: 'failure' }], [{ ...good, status: 'in_progress' }], [{ ...good, head_sha: 'b'.repeat(40) }], [{ ...good, head_branch: 'feature' }], [{ ...good, conclusion: 'failure' }, good]]) {
    await assert.rejects(requireStagingRelease(env, reply(runs)), /not completed staging/);
  }
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
      assert.ok(production.includes(`uses: ./.github/workflows/${name}`), `${name} must be in the production action`);
    }
  }
  assert.match(production, /convex:\s+needs: validate/);
  assert.match(production, /web:\s+needs: validate/);
  assert.match(production, /uses: \.\/\.github\/workflows\/build-web\.yml/);
  assert.match(production, /router:\s+needs: \[validate, convex, gateway, email, transcribe, egress, web\]/);
  assert.match(production, /mobile-update:\s+needs: \[validate, convex, gateway, email, transcribe, egress\]/);
  // Every deploy job waits on the staging check, directly or through Convex.
  const jobs = production.split(/^  (?=[a-z-]+:$)/m).slice(2);
  assert.ok(jobs.length >= 9, 'expected every component job after validate');
  for (const job of jobs) {
    assert.match(job, /needs: (validate|\[validate,)/, `${job.split(':')[0]} must need validate`);
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

test('production decides what to deploy only after proving staging passed', () => {
  const production = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
  const proof = production.indexOf('run: node scripts/production-release.mjs');
  const plan = production.indexOf('run: node scripts/deploy-plan.mjs --target production');
  assert.ok(proof !== -1 && plan > proof, 'the staging proof must run before the plan, in the same job');
});
