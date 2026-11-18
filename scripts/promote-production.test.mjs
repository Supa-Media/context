import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promote } from './promote-production.mjs';
import { parseOnBlock } from './check-workflow-triggers.mjs';
import { PRODUCTION_DEPLOY_BRANCH } from './production-release.mjs';

const TIP = 'b'.repeat(40);
const OLDER = 'a'.repeat(40);
const env = {
  EVENT_SHA: TIP,
  EVENT_WORKFLOW: 'CI',
  EVENT_EVENT: 'push',
  EVENT_BRANCH: 'main',
  EVENT_REPO: 'example/app',
  EVENT_CONCLUSION: 'success',
  GITHUB_REPOSITORY: 'example/app',
  GH_TOKEN: 'fake-test-token',
};
const green = sha => ({ head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'push', html_url: 'https://example.com/run' });

/**
 * CI and staging runs keyed by sha, the commits on main newest first, and
 * any production runs already open for a sha.
 */
function github({ commits = [TIP], ci = {}, staging = {}, production = {}, tip = TIP } = {}) {
  production.queued ??= [];
  const calls = [];
  const request = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, 'Bearer fake-test-token');
    const path = url.pathname;
    if (path.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: tip }) };
    if (path.endsWith('/commits')) {
      assert.equal(url.searchParams.get('sha'), 'main');
      return { ok: true, status: 200, json: async () => commits.map(sha => ({ sha })) };
    }
    if (path.endsWith('/ci.yml/runs')) {
      const sha = url.searchParams.get('head_sha');
      assert.equal(url.searchParams.get('event'), 'push');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: ci[sha] ?? [] }) };
    }
    if (path.endsWith('/deploy-staging.yml/runs')) {
      const sha = url.searchParams.get('head_sha');
      return { ok: true, status: 200, json: async () => ({ workflow_runs: staging[sha] ?? [] }) };
    }
    if (path.endsWith('/deploy-production.yml/runs')) {
      const sha = url.searchParams.get('head_sha');
      if (!sha) return { ok: true, status: 200, json: async () => ({ workflow_runs: production.queued ?? [] }) };
      return { ok: true, status: 200, json: async () => ({ workflow_runs: production[sha] ?? [] }) };
    }
    if (path.includes('/actions/runs/') && path.endsWith('/cancel') && init.method === 'POST') {
      calls.push({ cancel: path });
      return { ok: true, status: 202, json: async () => ({}) };
    }
    if (path.endsWith('/git/refs') && init.method === 'POST') {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: async () => ({ ref: calls.at(-1).ref }) };
    }
    if (path.endsWith('/dispatches') && init.method === 'POST') {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 204, json: async () => null };
    }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  };
  return { request, calls };
}
const quiet = { sleep: async () => {}, log: () => {} };

test('a green CI run of the tip deploys that commit without asking staging', async () => {
  const gh = github({ ci: { [TIP]: [green(TIP)] } });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, true);
  assert.equal(result.sha, TIP);
  assert.deepEqual(gh.calls, [
    { ref: `refs/heads/${PRODUCTION_DEPLOY_BRANCH}${TIP.slice(0, 12)}`, sha: TIP },
    { ref: `${PRODUCTION_DEPLOY_BRANCH}${TIP.slice(0, 12)}` },
  ]);
});

test('a skipped job inside a green CI run does not block the deploy', async () => {
  const run = { ...green(TIP), jobs: [{ name: 'ci / Test Shared Package', conclusion: 'skipped' }] };
  const gh = github({ ci: { [TIP]: [run] }, staging: { [TIP]: [green(TIP)] } });
  assert.equal((await promote(env, { ...quiet, request: gh.request })).promoted, true);
});

test('a still-pending staging run does not hold the deploy', async () => {
  const gh = github({ ci: { [TIP]: [green(TIP)] } });
  const seen = [];
  const request = async (url, init) => {
    seen.push(url.pathname);
    return gh.request(url, init);
  };
  const result = await promote(env, { ...quiet, request });
  assert.equal(result.promoted, true);
  assert.equal(result.sha, TIP);
  assert.ok(seen.every(path => !path.includes('deploy-staging')));
});

test('red CI on the tip deploys nothing when it is the only commit, and deploys the older green one', async () => {
  const red = github({ ci: { [TIP]: [{ ...green(TIP), conclusion: 'failure' }] }, staging: { [TIP]: [green(TIP)] } });
  const blocked = await promote(env, { ...quiet, request: red.request });
  assert.equal(blocked.promoted, false);
  assert.deepEqual(red.calls, []);

  const older = github({
    commits: [TIP, OLDER],
    ci: { [TIP]: [{ ...green(TIP), conclusion: 'failure' }], [OLDER]: [green(OLDER)] },
    staging: { [OLDER]: [green(OLDER)] },
  });
  const result = await promote(env, { ...quiet, request: older.request });
  assert.equal(result.promoted, true);
  assert.equal(result.sha, OLDER);
});

test('a skipped CI workflow is not a pass, so a later green commit is the one deployed', async () => {
  const gh = github({
    commits: [TIP, OLDER],
    ci: { [TIP]: [{ ...green(TIP), conclusion: 'skipped' }], [OLDER]: [green(OLDER)] },
    staging: { [OLDER]: [green(OLDER)] },
  });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.sha, OLDER);
});

test('a green CI deploys even when staging never finishes', async () => {
  const gh = github({ ci: { [TIP]: [green(TIP)] } });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, true);
  assert.equal(gh.calls.length, 2);
});

test('a commit already deploying or already in production is not deployed again', async () => {
  for (const run of [
    { head_sha: TIP, status: 'in_progress', conclusion: null },
    { head_sha: TIP, status: 'completed', conclusion: 'success' },
  ]) {
    const gh = github({
      ci: { [TIP]: [green(TIP)] },
      staging: { [TIP]: [green(TIP)] },
      production: { [TIP]: [run] },
    });
    const result = await promote(env, { ...quiet, request: gh.request });
    assert.equal(result.promoted, false);
    assert.deepEqual(gh.calls, []);
  }
});

test('a failed production run of the same commit is retried', async () => {
  const gh = github({
    ci: { [TIP]: [green(TIP)] },
    staging: { [TIP]: [green(TIP)] },
    production: { [TIP]: [{ head_sha: TIP, status: 'completed', conclusion: 'failure' }] },
  });
  assert.equal((await promote(env, { ...quiet, request: gh.request })).promoted, true);
  assert.equal(gh.calls.length, 2);
});

test('a newer green commit wins over an older one whose CI finished later', async () => {
  const gh = github({
    commits: [TIP, OLDER],
    ci: { [TIP]: [green(TIP)], [OLDER]: [green(OLDER)] },
    staging: { [TIP]: [green(TIP)], [OLDER]: [green(OLDER)] },
  });
  // The wake-up names the older commit. Selection still deploys the tip.
  const result = await promote({ ...env, EVENT_SHA: OLDER }, { ...quiet, request: gh.request });
  assert.equal(result.sha, TIP);
});

test('a queued deploy of another commit is cancelled, and one that has started is not', async () => {
  const queued = { id: 5, head_sha: OLDER, status: 'queued' };
  const waiting = { id: 6, head_sha: 'd'.repeat(40), status: 'waiting' };
  const started = { id: 7, head_sha: 'e'.repeat(40), status: 'in_progress' };
  const same = { id: 8, head_sha: TIP, status: 'queued' };
  const gh = github({
    ci: { [TIP]: [green(TIP)] },
    production: { queued: [queued, waiting, started, same] },
  });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, true);
  assert.equal(result.sha, TIP);
  assert.deepEqual(gh.calls.filter(call => call.cancel).map(call => call.cancel), [
    '/repos/example/app/actions/runs/5/cancel',
    '/repos/example/app/actions/runs/6/cancel',
  ]);
});

test('the newest commit already deploying still cancels a queued older deploy', async () => {
  const gh = github({
    ci: { [TIP]: [green(TIP)] },
    production: {
      [TIP]: [{ head_sha: TIP, status: 'in_progress', conclusion: null }],
      queued: [{ id: 11, head_sha: OLDER, status: 'pending' }],
    },
  });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, false);
  assert.deepEqual(gh.calls, [{ cancel: '/repos/example/app/actions/runs/11/cancel' }]);
});

test('a red or foreign wake-up starts nothing', async () => {
  for (const change of [
    { EVENT_CONCLUSION: 'failure' },
    { EVENT_CONCLUSION: 'skipped' },
    { EVENT_CONCLUSION: 'cancelled' },
    { EVENT_EVENT: 'pull_request' },
    { EVENT_BRANCH: 'feature' },
    { EVENT_REPO: 'other/app' },
    { EVENT_WORKFLOW: 'Deploy Staging', EVENT_EVENT: 'pull_request' },
    { EVENT_WORKFLOW: 'Deploy Staging', EVENT_EVENT: 'workflow_dispatch' },
    { EVENT_WORKFLOW: 'Deploy Staging', EVENT_EVENT: 'push' },
  ]) {
    const result = await promote({ ...env, ...change }, { ...quiet, request: () => assert.fail('must decide before any API call') });
    assert.equal(result.promoted, false);
  }
  await assert.rejects(promote({ ...env, EVENT_SHA: 'main' }, quiet), /invalid commit/);
});

test('the workflow follows CI only, and stays off when the variable says so', () => {
  const text = readFileSync(new URL('../.github/workflows/promote-production.yml', import.meta.url), 'utf8');
  assert.deepEqual([...parseOnBlock(text).keys()], ['workflow_run']);
  assert.match(text, /workflows: \["CI"\]/);
  assert.doesNotMatch(text, /Deploy Staging/);
  assert.match(text, /vars\.AUTO_DEPLOY_PRODUCTION != 'off'/);
  assert.match(text, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(text, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(text, /github\.event\.workflow_run\.name == 'CI' && github\.event\.workflow_run\.event == 'push'/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /EVENT_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(text, /run: node scripts\/promote-production\.mjs/);
  assert.doesNotMatch(text, /gh workflow run deploy-/);
});
