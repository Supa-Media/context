import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentFromKey, deploymentUrl, plannedChanges, syncConvexEnv } from './convex-env-sync.mjs';

// Fake values only: this repository is public.
const KEY = 'prod:example-deployment|fake-admin-token';
const URL_OK = 'https://example-deployment.convex.cloud';

test('the deployment comes from the key, and a malformed key is refused', () => {
  assert.equal(deploymentFromKey(KEY), 'example-deployment');
  assert.throws(() => deploymentFromKey('example-deployment'), /not a Convex deploy key/);
  assert.throws(() => deploymentFromKey(undefined), /not a Convex deploy key/);
});

test('the key is only ever sent to the deployment it opens', () => {
  assert.equal(deploymentUrl(URL_OK, KEY), URL_OK);
  assert.equal(deploymentUrl(`${URL_OK}/`, KEY), URL_OK);
  for (const bad of [
    'https://your-deployment.convex.cloud',
    'http://example-deployment.convex.cloud',
    'https://example-deployment.convex.cloud.evil.example',
    'https://example-deployment.convex.site',
    'https://example-deployment.convex.cloud/api',
  ]) {
    assert.throws(() => deploymentUrl(bad, KEY), /not https:\/\/example-deployment\.convex\.cloud/, bad);
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

/*
  A REFUSAL'S BODY REACHES A PUBLIC LOG, SO IT MUST NOT BE ABLE TO CARRY A VALUE.

  This repository is public, so its Actions logs are public, and the variables
  this script syncs include `STORAGE_SECRET_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`,
  `GATEWAY_SECRET` and the Twilio API key secret.

  What stood between those and the log was a sentence about somebody else's API:
  "the body names the problem and never echoes a value back". That may well be
  true of Convex today; it is a claim about a third party's error format, which
  can change without anyone here noticing, and the failure is silent and public.

  GitHub's own secret masking is not the backstop it looks like: it redacts
  exact matches, and the body is truncated, so a value cut across the limit
  reaches the log as a fragment the masker does not recognise.

  So the values are taken out of the body here, where they are known — the same
  argument the gateway's storage-detail redactor makes: a value we hold is
  detectable, and a shape rule is a guess. Redaction runs BEFORE the truncation
  for the reason that one does too: a half-cut secret must not survive the cut.
*/
test('a refusal cannot print a synced value, however the body is shaped', async () => {
  const SECRET = 'fake-signing-key-abcdefghijklmnopqrstuvwxyz-0123456789';
  const refusal = (body) => ({ ok: false, status: 400, text: async () => body });
  const detailOf = async (body) => {
    const error = await syncConvexEnv({
      names: ['JWT_PRIVATE_KEY'], values: { JWT_PRIVATE_KEY: SECRET },
      url: URL_OK, key: KEY, log: () => {}, fetchImpl: async () => refusal(body),
    }).then(() => null, (thrown) => thrown);
    assert.ok(error, 'expected a refusal to throw');
    return error.message;
  };

  // Echoed whole.
  const whole = await detailOf(`invalid value for JWT_PRIVATE_KEY: ${SECRET}`);
  assert.doesNotMatch(whole, /fake-signing-key/);
  assert.match(whole, /HTTP 400/);
  assert.match(whole, /invalid value for JWT_PRIVATE_KEY/, 'the diagnosis itself still reaches the log');

  // Echoed across the truncation boundary: the half that would survive a cut
  // is not an exact match, so masking elsewhere would not catch it.
  const padded = `${'x'.repeat(280)} ${SECRET}`;
  assert.doesNotMatch(await detailOf(padded), /fake-signing/);

  // A body with no value in it is unchanged, so a real diagnosis is not lost.
  assert.match(await detailOf('BadAdminKey'), /BadAdminKey/);
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
