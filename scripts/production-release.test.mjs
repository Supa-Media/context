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
  assert.match(production, /web:\s+needs: \[gateway, email, transcribe, egress\]/);
});
