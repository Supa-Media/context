import test from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_PREVIEW_KEYS } from './guards.mjs';
import {
  COPIED_KEYS,
  applyPreviewEnv,
  assertPreviewKey,
  deploymentFromUrl,
  envFileContent,
  envLine,
  outputLines,
  previewEnvValues,
} from './convex-env.mjs';

// Built at run time: scripts/check-no-identifiers.mjs rejects a committed Convex hostname, fakes included.
const CONVEX_CLOUD = ['convex', 'cloud'].join('.');
const CONVEX_SITE = ['convex', 'site'].join('.');

const KEY = 'preview:example-team:example-project|secret-value';
const env = {
  APP_ENV: 'staging',
  STAGING_CONVEX_DEPLOYMENT: 'staging-name-123',
  APP_ORIGIN: 'https://staging.context.lc',
  SITE_URL: 'https://staging.context.lc',
  STORAGE_MOVER_ORIGIN: 'https://mcp-staging.context.lc',
  GATEWAY_SECRET: 'gateway-secret-value',
  STORAGE_SECRET_ENCRYPTION_KEY: 'storage-key-value-1',
  JWT_PRIVATE_KEY: 'jwt-private-key-value',
  JWKS: '{"keys":[]}',
  ADMIN_EMAILS: 'fixture@example.com',
  LINQ_API_KEY: 'linq-live-value',
  TWILIO_API_KEY_SECRET: 'twilio-live-value',
  RESEND_API_KEY: 'resend-live-value',
  STRIPE_PRICE_ID: 'price_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  CUSTOM_DOMAINS_ZONE_ID: '0123456789abcdef0123456789abcdef',
  CUSTOM_DOMAINS_TARGET: 'saas.example.net',
  GOOGLE_PUSH_TOPIC: 'projects/x/topics/y',
  GOOGLE_PUSH_SERVICE_ACCOUNT: 'service-account-value',
  GOOGLE_OAUTH_CLIENT_ID: 'staging-real-client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'staging-real-secret',
  EMPTY_ONE: '',
  PREVIEW_NAME: 'pr42',
  PREVIEW_WORKERS_DEV: 'fixture-sub.workers.dev',
  PREVIEW_CONVEX_URL: `https://example-preview-123.${CONVEX_CLOUD}`,
};

test('preview values set the preview identity and no staging identity', () => {
  const { set } = previewEnvValues(env);
  assert.equal(set.APP_ENV, 'preview');
  assert.equal(set.PREVIEW_NAME, 'pr42');
  assert.equal(set.APP_ORIGIN, 'https://context-router-pr42.fixture-sub.workers.dev');
  assert.equal(set.SITE_URL, set.APP_ORIGIN);
  assert.equal(set.STORAGE_MOVER_ORIGIN, 'https://context-mcp-pr42.fixture-sub.workers.dev');
});

test('Google on a preview is its emulators, with a fake client, never staging\'s real one', () => {
  const { set } = previewEnvValues(env);
  assert.equal(set.EMULATORS_ORIGIN, 'https://context-emulators-pr42.fixture-sub.workers.dev');
  assert.equal(set.GOOGLE_OAUTH_CLIENT_ID, 'preview-emulated.apps.googleusercontent.com');
  assert.equal(set.MAIL_CONNECT_ENABLED, 'true');
  assert.equal(set.CALENDAR_CONNECT_ENABLED, 'true');
  for (const value of Object.values(set)) assert.doesNotMatch(String(value), /staging-real/);
});

test('preview values never include a forbidden key or the staging deployment name', () => {
  const { set } = previewEnvValues(env);
  for (const key of FORBIDDEN_PREVIEW_KEYS) assert.equal(key in set, false, `${key} must not be set`);
  assert.equal('STAGING_CONVEX_DEPLOYMENT' in set, false);
  for (const value of Object.values(set)) assert.doesNotMatch(String(value), /staging-name-123/);
});

test('preview values drop the custom domain, Google push and Stripe price names', () => {
  const { set } = previewEnvValues(env);
  for (const key of ['CUSTOM_DOMAINS_ZONE_ID', 'CUSTOM_DOMAINS_TARGET', 'GOOGLE_PUSH_TOPIC', 'GOOGLE_PUSH_SERVICE_ACCOUNT', 'STRIPE_PRICE_ID']) {
    assert.equal(key in set, false, `${key} must not be copied`);
  }
});

test('preview values copy the backend secrets it needs to run', () => {
  const { set } = previewEnvValues(env);
  assert.equal(set.GATEWAY_SECRET, 'gateway-secret-value');
  assert.equal(set.JWT_PRIVATE_KEY, 'jwt-private-key-value');
  assert.equal(set.JWKS, '{"keys":[]}');
  assert.equal('EMPTY_ONE' in set, false);
});

test('preview values list every forbidden key for removal', () => {
  const { remove } = previewEnvValues(env);
  for (const key of FORBIDDEN_PREVIEW_KEYS) assert.ok(remove.includes(key), `${key} must be removed`);
  assert.ok(remove.includes('STAGING_CONVEX_DEPLOYMENT'));
  assert.equal(new Set(remove).size, remove.length);
});

test('copied names exclude every forbidden key', () => {
  for (const key of FORBIDDEN_PREVIEW_KEYS) assert.equal(COPIED_KEYS.includes(key), false, key);
});

test('a non-preview deploy key is refused before anything runs', () => {
  assert.throws(() => assertPreviewKey('prod:example-name-123|secret'), /preview deploy key/);
  assert.throws(() => assertPreviewKey('dev:example|secret'), /preview deploy key/);
  assert.throws(() => assertPreviewKey(undefined), /preview deploy key/);
  assert.doesNotThrow(() => assertPreviewKey(KEY));
});

test('applyPreviewEnv refuses a non-preview key and never calls the CLI', () => {
  const calls = [];
  const cli = (...args) => {
    calls.push(args);
    return { status: 0 };
  };
  assert.throws(() => applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: 'prod:example-name-123|secret' }, { cli }), /preview deploy key/);
  assert.equal(calls.length, 0);
});

test('applyPreviewEnv sets from a 0600 file, then removes forbidden names, and deletes the file', () => {
  const calls = [];
  let seenFile = null;
  const cli = (args) => {
    calls.push(args);
    if (args[0] === 'env' && args[1] === 'set') seenFile = args[args.indexOf('--from-file') + 1];
    return { status: 0 };
  };
  const result = applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY, RUNNER_TEMP: '' }, { cli });
  assert.equal(result.name, 'example-preview-123');
  assert.deepEqual(calls[0].slice(0, 5), ['env', 'set', '--deployment', 'example-preview-123', '--force']);
  for (const variable of result.removed) {
    assert.ok(calls.some((args) => args[1] === 'remove' && args[args.length - 1] === variable));
  }
  assert.ok(seenFile, 'a file was passed to env set');
  assert.throws(() => applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY, PREVIEW_CONVEX_URL: 'https://a.example.com' }, { cli }), /convex\.cloud/);
});

test('a failed removal fails the whole command', () => {
  const cli = (args) => (args[1] === 'list' ? { status: 0, stdout: 'RESEND_API_KEY\n' } : { status: args[1] === 'remove' ? 1 : 0 });
  assert.throws(() => applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY }, { cli }), /convex env remove/);
});

test('the preview name, workers.dev subdomain and URL are validated', () => {
  assert.throws(() => previewEnvValues({ ...env, PREVIEW_NAME: 'pr0' }), /pr<N>/);
  assert.throws(() => previewEnvValues({ ...env, PREVIEW_NAME: 'main' }), /pr<N>/);
  assert.throws(() => previewEnvValues({ ...env, PREVIEW_WORKERS_DEV: 'evil.example.com' }), /workers\.dev/);
  assert.equal(deploymentFromUrl(`https://example-preview-123.${CONVEX_CLOUD}`), 'example-preview-123');
  assert.equal(deploymentFromUrl(`https://example-preview-123.${CONVEX_CLOUD}/`), 'example-preview-123');
  assert.throws(() => deploymentFromUrl(`http://example-preview-123.${CONVEX_CLOUD}`), /convex\.cloud/);
  assert.throws(() => deploymentFromUrl(`https://example-preview-123.${CONVEX_SITE}`), /convex\.cloud/);
  assert.throws(() => deploymentFromUrl(`https://example-preview-123.${CONVEX_CLOUD}:8443`), /convex\.cloud/);
  assert.throws(() => deploymentFromUrl('https://x.example.com/?a=1'), /convex\.cloud/);
  assert.equal(deploymentFromUrl(`https://UPPER.${CONVEX_CLOUD}`), 'upper');
});

test('outputs name the Convex URL, site and deployment', () => {
  assert.deepEqual(outputLines('example-preview-123'), [
    `convex_url=https://example-preview-123.${CONVEX_CLOUD}`,
    `convex_site=https://example-preview-123.${CONVEX_SITE}`,
    'deployment=example-preview-123',
  ]);
});

test('env file lines are dotenv-exact for ordinary, quoted and multi-line values', () => {
  assert.equal(envLine('A', 'plain-value'), "A='plain-value'");
  assert.equal(envLine('B', '{"keys":[]}'), "B='{\"keys\":[]}'");
  assert.equal(envLine('C', "it's"), 'C="it\'s"');
  assert.equal(envLine('D', '-----BEGIN KEY-----\nabc\n-----END KEY-----'), 'D="-----BEGIN KEY-----\nabc\n-----END KEY-----"');
  assert.equal(envFileContent({ A: 'x', B: 'y' }), "A='x'\nB='y'\n");
  assert.throws(() => envLine('E', 'line\nwith "quote"'), /E cannot be written/);
  assert.throws(() => envLine('F', 'back\\slash\nline'), /F cannot be written/);
  assert.throws(() => envLine('G', ' padded '), /G has surrounding whitespace/);
});

test('error messages name variables only, never a value', () => {
  try {
    envLine('SECRET_NAME', 'value with "quotes"\nand line');
    assert.fail('expected a refusal');
  } catch (error) {
    assert.doesNotMatch(error.message, /value with/);
  }
});

test('a names-only listing removes only the forbidden names the deployment holds', () => {
  const calls = [];
  const cli = (args, key, options) => {
    calls.push({ args, options });
    if (args[0] === 'env' && args[1] === 'list') return { status: 0, stdout: 'GATEWAY_SECRET\nRESEND_API_KEY\nLINQ_API_KEY\n' };
    return { status: 0 };
  };
  const result = applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY }, { cli });
  const list = calls.filter((call) => call.args[1] === 'list');
  assert.equal(list.length, 1, 'one listing, not one per name');
  assert.deepEqual(list[0].args, ['env', 'list', '--deployment', 'example-preview-123', '--names-only']);
  assert.equal(list[0].options.capture, true, 'only the listing captures stdout');
  assert.ok(calls.filter((call) => call.args[1] !== 'list').every((call) => !call.options), 'other calls capture nothing');
  const removed = calls.filter((call) => call.args[1] === 'remove').map((call) => call.args[call.args.length - 1]);
  assert.deepEqual(removed.sort(), ['LINQ_API_KEY', 'RESEND_API_KEY']);
  assert.deepEqual(result.removed.sort(), ['LINQ_API_KEY', 'RESEND_API_KEY']);
});

test('a listing that fails falls back to removing every forbidden name', () => {
  for (const listing of [{ status: 1, stdout: '' }, () => { throw new Error('spawn failed'); }]) {
    const removed = [];
    const cli = (args) => {
      if (args[1] === 'list') {
        if (typeof listing === 'function') return listing();
        return listing;
      }
      if (args[1] === 'remove') removed.push(args[args.length - 1]);
      return { status: 0 };
    };
    const result = applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY }, { cli });
    assert.deepEqual(removed.sort(), [...result.removed].sort());
    assert.ok(removed.includes('RESEND_API_KEY'));
    assert.ok(removed.includes('STAGING_CONVEX_DEPLOYMENT'));
  }
});

test('the names listing is read as names, and a value in it is never a name to remove', () => {
  const removed = [];
  const cli = (args) => {
    if (args[1] === 'list') return { status: 0, stdout: '' };
    if (args[1] === 'remove') removed.push(args[args.length - 1]);
    return { status: 0 };
  };
  applyPreviewEnv({ ...env, CONVEX_DEPLOY_KEY: KEY }, { cli });
  assert.deepEqual(removed, [], 'an empty listing means nothing is present to remove');
});

test('a copied managed account id is ignored: the preview sets its own Workers account id', () => {
  const account = 'a'.repeat(32);
  const { set } = previewEnvValues({ ...env, CLOUDFLARE_ACCOUNT_ID: account, MANAGED_R2_ACCOUNT_ID: 'b'.repeat(32) });
  assert.equal(set.MANAGED_R2_ACCOUNT_ID, account);
  assert.equal(COPIED_KEYS.includes('MANAGED_R2_ACCOUNT_ID'), false);
});

test('the preview account id is trimmed and lowercased', () => {
  const { set } = previewEnvValues({ ...env, CLOUDFLARE_ACCOUNT_ID: ` ${'A'.repeat(32)} ` });
  assert.equal(set.MANAGED_R2_ACCOUNT_ID, 'a'.repeat(32));
});

test('a preview account id on the deny list is refused, without echoing it', () => {
  const account = `${'c'.repeat(16)}${'d'.repeat(16)}`;
  assert.throws(
    () => previewEnvValues({ ...env, CLOUDFLARE_ACCOUNT_ID: account, PREVIEW_DENY_IDENTIFIERS: `${'x'.repeat(4)}, ${'d'.repeat(8)}` }),
    (error) => {
      assert.match(error.message, /names a production resource \(PREVIEW_DENY_IDENTIFIERS\)/);
      assert.doesNotMatch(error.message, /cccc|dddd/);
      return true;
    },
  );
});

test('a malformed preview account id is refused, without echoing it', () => {
  for (const bad of ['a'.repeat(31), 'g'.repeat(32), `${'a'.repeat(31)}-`, 'not an account id']) {
    assert.throws(
      () => previewEnvValues({ ...env, CLOUDFLARE_ACCOUNT_ID: bad }),
      (error) => {
        assert.equal(error.message, 'CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account id.');
        assert.doesNotMatch(error.message, /not an account/);
        return true;
      },
    );
  }
});

test('an absent preview account id sets no managed account id', () => {
  const { set } = previewEnvValues({ ...env, CLOUDFLARE_ACCOUNT_ID: undefined, MANAGED_R2_ACCOUNT_ID: 'b'.repeat(32) });
  assert.equal('MANAGED_R2_ACCOUNT_ID' in set, false);
});
