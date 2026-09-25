import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('staging gateway has its own origins, queue and presence namespace', () => {
  const config = read('apps/mcp/wrangler.toml').split('[env.staging]')[1];
  assert.ok(config, 'staging environment must exist');
  assert.match(config, /name = "context-mcp-staging"/);
  assert.match(config, /PUBLIC_ORIGIN = "https:\/\/mcp-staging.context.lc"/);
  assert.match(config, /ALLOWED_ORIGINS = "https:\/\/staging.context.lc"/);
  assert.equal((config.match(/queue = "context-gateway-jobs-staging"/g) || []).length, 2);
  assert.doesNotMatch(config, /queue = "context-gateway-jobs"|script_name/);
  assert.match(config, /\[\[env.staging.durable_objects.bindings\]\]/);
});
test('staging native builds use staging credentials', () => {
  const workflow = read('.github/workflows/deploy-mobile-native.yml');
  assert.match(workflow, /environment: \$\{\{ inputs.profile \}\}/);
});
test('staging profile sets both the gateway and sharing origin', () => {
  const eas = JSON.parse(read('apps/mobile/eas.json'));
  assert.equal(eas.build.staging.env.EXPO_PUBLIC_MCP_URL, 'https://mcp-staging.context.lc/mcp');
  assert.equal(eas.build.staging.env.EXPO_PUBLIC_SITE_ORIGIN, 'https://staging.context.lc');
});

const { validateStaging, backendKeys } = await import('./staging-env.mjs');
const valid = {
  APP_ENV: 'staging',
  STAGING_CONVEX_DEPLOYMENT: 'example-deployment',
  CONVEX_DEPLOY_KEY: 'prod:example-deployment|fake-test-key',
  EXPO_PUBLIC_CONVEX_URL: 'https://example-deployment.convex.cloud',
  CONTROL_PLANE_URL: 'https://example-deployment.convex.site',
  APP_ORIGIN: 'https://staging.context.lc',
  GATEWAY_SECRET: 'test', STORAGE_SECRET_ENCRYPTION_KEY: 'test',
  JWT_PRIVATE_KEY: 'test', JWKS: 'test', EMAIL_WORKER_SECRET: 'test',
  TRANSCRIBE_WORKER_SECRET: 'test', TRANSCRIBE_WORKER_URL: 'https://transcribe.example.invalid',
};
test('staging refuses production or mismatched secrets before deploying', () => {
  assert.doesNotThrow(() => validateStaging(valid));
  for (const changed of [
    { CONVEX_DEPLOY_KEY: 'prod:your-deployment|fake-test-key' },
    { CONTROL_PLANE_URL: 'https://your-deployment.convex.site' },
    { EXPO_PUBLIC_CONVEX_URL: 'https://your-deployment.convex.cloud' },
    { APP_ORIGIN: 'https://context.lc' },
    { STAGING_CONVEX_DEPLOYMENT: '' },
    { APP_ENV: 'production' },
    { JWT_PRIVATE_KEY: '' },
  ]) assert.throws(() => validateStaging({ ...valid, ...changed }));
});

test('staging sync supplies both backend deployment selectors', () => {
  assert.ok(backendKeys.includes('APP_ENV'));
  assert.ok(backendKeys.includes('STAGING_CONVEX_DEPLOYMENT'));
});

test('staging custom domains require a complete isolated configuration', () => {
  const isolated = { CUSTOM_DOMAINS_ZONE_ID: 'a'.repeat(32), CUSTOM_DOMAINS_TARGET: 'customers.example.net' };
  assert.doesNotThrow(() => validateStaging({ ...valid, ...isolated }));
  for (const changed of [
    { CUSTOM_DOMAINS_ZONE_ID: isolated.CUSTOM_DOMAINS_ZONE_ID },
    { CUSTOM_DOMAINS_TARGET: isolated.CUSTOM_DOMAINS_TARGET },
    { ...isolated, CUSTOM_DOMAINS_ZONE_ID: 'invalid' },
    { ...isolated, CUSTOM_DOMAINS_TARGET: 'https://customers.example.net' },
    { ...isolated, CUSTOM_DOMAINS_TARGET: 'customers.context.lc' },
    { ...isolated, CUSTOM_DOMAINS_TARGET: 'customers.staging.context.lc' },
    { ...isolated, CUSTOM_DOMAINS_TARGET: ' CUSTOMERS.CONTEXT.LC ' },
  ]) assert.throws(() => validateStaging({ ...valid, ...changed }));
});

test('staging deployment syncs its own custom domain identifiers', () => {
  const workflow = read('.github/workflows/deploy-staging.yml');
  for (const name of ['CUSTOM_DOMAINS_ZONE_ID', 'CUSTOM_DOMAINS_TARGET']) {
    assert.ok(backendKeys.includes(name));
    assert.ok(workflow.includes(`${name}: \u0024{{ secrets.${name} }}`));
  }
});
