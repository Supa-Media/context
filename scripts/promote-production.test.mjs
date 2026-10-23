import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promote } from './promote-production.mjs';
import { parseOnBlock } from './check-workflow-triggers.mjs';

const SHA = 'a'.repeat(40);
const env = { STAGED_SHA: SHA, STAGED_EVENT: 'push', STAGED_BRANCH: 'main', STAGED_CONCLUSION: 'success', GITHUB_REPOSITORY: 'example/app', GH_TOKEN: 'fake-test-token' };
const greenCi = { head_sha: SHA, status: 'completed', conclusion: 'success', html_url: 'https://example.com/ci' };

/** A fake GitHub: CI runs to return in turn, main's tip, and the dispatches it received. */
function github({ ci = [[greenCi]], tip = SHA } = {}) {
  const dispatched = [];
  let polls = 0;
  const request = async (url, init = {}) => {
    assert.equal(init.headers.Authorization, 'Bearer fake-test-token');
    if (url.pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      assert.equal(url.searchParams.get('head_sha'), SHA);
      assert.equal(url.searchParams.get('event'), 'push');
      const runs = ci[Math.min(polls++, ci.length - 1)];
      return { ok: true, status: 200, json: async () => ({ workflow_runs: runs }) };
    }
    if (url.pathname.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: tip }) };
    if (url.pathname.endsWith('/actions/workflows/deploy-production.yml/dispatches')) {
      assert.equal(init.method, 'POST');
      dispatched.push(JSON.parse(init.body));
      return { ok: true, status: 204 };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { request, dispatched };
}
const quiet = { sleep: async () => {}, log: () => {} };

test('a green staging run of main, with green CI, starts production on main', async () => {
  const gh = github();
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, true);
  assert.deepEqual(gh.dispatched, [{ ref: 'main' }]);
});

test('it waits for CI on the same commit to finish before deciding', async () => {
  const gh = github({ ci: [[], [{ ...greenCi, status: 'in_progress' }], [greenCi]] });
  assert.equal((await promote(env, { ...quiet, request: gh.request })).promoted, true);
  assert.equal(gh.dispatched.length, 1);
});

test('red CI fails the promotion loudly and starts nothing', async () => {
  const gh = github({ ci: [[{ ...greenCi, conclusion: 'failure' }]] });
  await assert.rejects(promote(env, { ...quiet, request: gh.request }), /CI failure/);
  assert.deepEqual(gh.dispatched, []);
});

test('CI that never finishes gives up without promoting', async () => {
  let clock = 0;
  const gh = github({ ci: [[{ ...greenCi, status: 'queued' }]] });
  await assert.rejects(promote(env, { ...quiet, request: gh.request, now: () => (clock += 60_000) }), /did not finish/);
  assert.deepEqual(gh.dispatched, []);
});

test('an older commit is not dispatched once main has moved on', async () => {
  const gh = github({ tip: 'b'.repeat(40) });
  const result = await promote(env, { ...quiet, request: gh.request });
  assert.equal(result.promoted, false);
  assert.match(result.reason, /main moved on/);
  assert.deepEqual(gh.dispatched, []);
});

test('only a successful staging run from a push to main counts', async () => {
  for (const change of [{ STAGED_CONCLUSION: 'failure' }, { STAGED_CONCLUSION: 'cancelled' }, { STAGED_EVENT: 'workflow_dispatch' }, { STAGED_BRANCH: 'feature' }]) {
    const result = await promote({ ...env, ...change }, { ...quiet, request: () => assert.fail('must decide before any API call') });
    assert.equal(result.promoted, false);
  }
  await assert.rejects(promote({ ...env, STAGED_SHA: 'main' }, quiet), /invalid staged commit/);
});

test('the workflow follows Deploy Staging only, and one variable turns it off', () => {
  const text = readFileSync(new URL('../.github/workflows/promote-production.yml', import.meta.url), 'utf8');
  assert.deepEqual([...parseOnBlock(text).keys()], ['workflow_run']);
  assert.match(text, /workflows: \["Deploy Staging"\]/);
  assert.match(text, /if: \$\{\{ vars\.AUTO_DEPLOY_PRODUCTION != 'off' && github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.head_branch == 'main' \}\}/);
  assert.match(text, /STAGED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(text, /run: node scripts\/promote-production\.mjs/);
});
