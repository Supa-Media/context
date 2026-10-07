import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentFromKey, deploymentUrl, plannedChanges, syncConvexEnv } from './convex-env-sync.mjs';

// Fake values only: this repository is public.
const KEY = 'prod:happy-otter-123|fake-admin-token';
const URL_OK = 'https://happy-otter-123.convex.cloud';

test('the deployment comes from the key, and a malformed key is refused', () => {
  assert.equal(deploymentFromKey(KEY), 'happy-otter-123');
  assert.throws(() => deploymentFromKey('happy-otter-123'), /not a Convex deploy key/);
  assert.throws(() => deploymentFromKey(undefined), /not a Convex deploy key/);
});

test('the key is only ever sent to the deployment it opens', () => {
  assert.equal(deploymentUrl(URL_OK, KEY), URL_OK);
  assert.equal(deploymentUrl(`${URL_OK}/`, KEY), URL_OK);
  for (const bad of [
    'https://other-deployment-1.convex.cloud',
    'http://happy-otter-123.convex.cloud',
    'https://happy-otter-123.convex.cloud.evil.example',
    'https://happy-otter-123.convex.site',
    'https://happy-otter-123.convex.cloud/api',
  ]) {
    assert.throws(() => deploymentUrl(bad, KEY), /not https:\/\/happy-otter-123\.convex\.cloud/, bad);
  }
});

test('absent and empty values are left alone, never pushed as empty', () => {
  const { changes, skipped } = plannedChanges(['A', 'B', 'C'], { A: 'one', B: '' });
  assert.deepEqual(changes, [{ name: 'A', value: 'one' }]);
  assert.deepEqual(skipped, ['B', 'C']);
});

test('every variable goes in one request, values only in the body', async () => {
  const calls = [];
  const lines = [];
  const result = await syncConvexEnv({
    names: ['GATEWAY_SECRET', 'JWT_PRIVATE_KEY', 'UNSET'],
    values: { GATEWAY_SECRET: 'fake-gateway', JWT_PRIVATE_KEY: '-----BEGIN FAKE-----\nline\n-----END FAKE-----' },
    url: URL_OK,
    key: KEY,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '' }; },
    log: (line) => lines.push(line),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL_OK}/api/update_environment_variables`);
  assert.equal(calls[0].init.headers.authorization, `Convex ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { changes: [
    { name: 'GATEWAY_SECRET', value: 'fake-gateway' },
    { name: 'JWT_PRIVATE_KEY', value: '-----BEGIN FAKE-----\nline\n-----END FAKE-----' },
  ] });
  assert.deepEqual(result, { set: ['GATEWAY_SECRET', 'JWT_PRIVATE_KEY'], skipped: ['UNSET'] });
  // Names are logged, values never.
  const logged = lines.join('\n');
  assert.match(logged, /GATEWAY_SECRET JWT_PRIVATE_KEY/);
  assert.doesNotMatch(logged, /fake-gateway|BEGIN FAKE/);
});

test('a refused request fails the deploy', async () => {
  await assert.rejects(
    syncConvexEnv({
      names: ['A'], values: { A: 'x' }, url: URL_OK, key: KEY, log: () => {},
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'BadAdminKey' }),
    }),
    /HTTP 401/,
  );
});

test('nothing to set sends nothing', async () => {
  let called = false;
  await syncConvexEnv({ names: ['A'], values: {}, url: URL_OK, key: KEY, log: () => {}, fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
});

test('both deploys use the batched sync, not one CLI call per variable', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const staging = readFileSync(new URL('deploy-staging.yml', dir), 'utf8');
  const production = readFileSync(new URL('deploy-convex.yml', dir), 'utf8');
  assert.match(production, /node scripts\/convex-env-sync\.mjs /);
  assert.doesNotMatch(production, /npx convex env set/);
  assert.match(readFileSync(new URL('staging-env.mjs', import.meta.url), 'utf8'), /syncConvexEnv/);
  assert.match(staging, /node scripts\/staging-env\.mjs --sync/);
});
