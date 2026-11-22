// Sets the environment of a preview Convex deployment. Run by
// `convex deploy --cmd`, after the preview deployment exists and before the
// code is pushed:
//
//   pnpm exec convex deploy --yes --preview-name pr<N> \
//     --cmd 'node packages/sandbox/src/convex-env.mjs' \
//     --cmd-url-env-var-name PREVIEW_CONVEX_URL --preview-run functions/seed:preview
//
// A preview is a copy of the staging backend with its identity changed. It
// keeps the staging secrets it needs to run (signing keys, the storage
// encryption key) and loses everything that would reach a real person or a
// real line: the texting lines, real email, payments, and the staging
// deployment's own name. Those names are in FORBIDDEN_PREVIEW_KEYS
// (packages/sandbox/src/guards.mjs), and they are also removed from the deployment,
// because a project default can carry them.
//
// Values are written to a 0600 file in $RUNNER_TEMP (or the OS temp directory),
// handed to `convex env set --from-file`, and deleted in `finally`. Only the
// variable names are ever printed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FORBIDDEN_PREVIEW_KEYS } from './guards.mjs';
import { backendKeys } from '../../../scripts/staging-env.mjs';

const CLI = fileURLToPath(new URL('../../../node_modules/convex/bin/main.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Names this script sets itself, so a staging value for them is never copied. */
const OWN_NAMES = ['APP_ENV', 'APP_ORIGIN', 'SITE_URL', 'STORAGE_MOVER_ORIGIN', 'PREVIEW_NAME', 'MANAGED_R2_ACCOUNT_ID'];
/**
 * A preview's staff gains the fictional alpha persona (staging's list is kept: the pinned `context-lc` a preview made
 * before stays vouched for by whoever made it, `lib/personaSeed.ts`). Alpha already owns that pinned workspace there,
 * so this makes alpha the preview's Tex developer and the Lab's test chats run there for a pull request's code
 * (`packages/lab/gateway/labSandbox/preview.js`, Dev2 2026-11-22).
 */
export const PREVIEW_STAFF = 'alpha@supa.media';

/** Staging values a preview never gets: custom domains, Google push and the Stripe price. */
const NOT_COPIED = ['STAGING_CONVEX_DEPLOYMENT', 'CUSTOM_DOMAINS_ZONE_ID', 'CUSTOM_DOMAINS_TARGET', 'GOOGLE_PUSH', 'STRIPE_PRICE_ID'];

/** The staging names copied to the preview: the backend keys, less what a preview must not have. */
export const COPIED_KEYS = backendKeys.filter(
  (name) => !OWN_NAMES.includes(name) &&
    !NOT_COPIED.includes(name) &&
    !name.startsWith('GOOGLE_PUSH_') &&
    !FORBIDDEN_PREVIEW_KEYS.includes(name),
);

/** `pr<N>`, the preview name (`previewName` in apps/convex/functions/lib/previewDeployment.ts). */
export function previewNameOf(value) {
  if (!/^pr[1-9][0-9]{0,6}$/.test(value ?? '')) throw new Error('PREVIEW_NAME must be pr<N>.');
  return value;
}

/** The workers.dev subdomain part, `<sub>.workers.dev`. Never printed. */
export function workersDevOf(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,61}\.workers\.dev$/.test(value ?? '')) {
    throw new Error('PREVIEW_WORKERS_DEV must be <subdomain>.workers.dev.');
  }
  return value;
}

/**
 * The preview's own Workers account id, lowercased, or null when the environment has none. Its managed buckets
 * are created there, so a deny-listed id (a production resource) is refused here and the value is never echoed.
 */
export function previewAccountIdOf(env) {
  if (typeof env.CLOUDFLARE_ACCOUNT_ID !== 'string' || env.CLOUDFLARE_ACCOUNT_ID.trim() === '') return null;
  const value = env.CLOUDFLARE_ACCOUNT_ID.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account id.');
  const denied = String(env.PREVIEW_DENY_IDENTIFIERS ?? '').split(/[\s,]+/).filter(Boolean);
  if (denied.some((identifier) => value.includes(identifier))) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID names a production resource (PREVIEW_DENY_IDENTIFIERS).');
  }
  return value;
}

/** The Convex deployment name, from `https://<name>.convex.cloud` and nothing else. */
export function deploymentFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url ?? '');
  } catch {
    throw new Error('PREVIEW_CONVEX_URL is not a URL.');
  }
  const match = /^([a-z0-9-]+)\.convex\.cloud$/.exec(parsed.hostname);
  if (parsed.protocol !== 'https:' || !match || parsed.port !== '' || parsed.username || parsed.password ||
    parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('PREVIEW_CONVEX_URL must be https://<name>.convex.cloud.');
  }
  return match[1];
}

/** A preview deploy key. Refused before any command can use it. */
export function assertPreviewKey(key) {
  if (typeof key !== 'string' || !key.startsWith('preview:') || !key.includes('|')) {
    throw new Error('CONVEX_DEPLOY_KEY must be a preview deploy key (preview:<team>:<project>|<secret>).');
  }
}

/**
 * What the preview's deployment must hold: the copied staging values, the
 * preview's own identity, and the forbidden names to remove. A value that is
 * absent or empty is not set, the same rule `convex-env-sync.mjs` keeps.
 */
export function previewEnvValues(env) {
  const name = previewNameOf(env.PREVIEW_NAME);
  const workers = workersDevOf(env.PREVIEW_WORKERS_DEV);
  const set = {};
  for (const key of COPIED_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') set[key] = value;
  }
  const app = `https://context-router-${name}.${workers}`;
  // A preview's managed buckets live in its own Workers account, never the customer-data account, so the id is
  // derived here from CLOUDFLARE_ACCOUNT_ID and never copied from MANAGED_R2_ACCOUNT_ID.
  const accountId = previewAccountIdOf(env);
  if (accountId !== null) set.MANAGED_R2_ACCOUNT_ID = accountId;
  Object.assign(set, {
    APP_ENV: 'preview',
    PREVIEW_NAME: name,
    APP_ORIGIN: app,
    SITE_URL: app,
    STORAGE_MOVER_ORIGIN: `https://context-mcp-${name}.${workers}`,
    ADMIN_EMAILS: [...new Set([...String(set.ADMIN_EMAILS ?? '').split(/[\s,]+/).filter(Boolean), PREVIEW_STAFF])].join(','),
  });
  for (const key of Object.keys(set)) {
    if (FORBIDDEN_PREVIEW_KEYS.includes(key) || key === 'STAGING_CONVEX_DEPLOYMENT') {
      throw new Error(`Refusing to set ${key} on a preview.`);
    }
  }
  const remove = [...new Set([...FORBIDDEN_PREVIEW_KEYS, 'STAGING_CONVEX_DEPLOYMENT'])];
  return { set, remove };
}

/**
 * One `NAME=value` line in the form `convex env set --from-file` reads (dotenv).
 * Single quotes take a value as it is. A value with a line break needs double
 * quotes, which keep a line break as it is; the one thing they cannot hold is a
 * backslash or a double quote, so a value with either and a line break is
 * refused rather than written wrongly. Surrounding whitespace is refused too,
 * because the parser trims it.
 */
export function envLine(name, value) {
  if (value !== value.trim()) throw new Error(`${name} has surrounding whitespace, which cannot be set exactly.`);
  const multiline = /[\r\n]/.test(value);
  if (!multiline && !value.includes("'")) return `${name}='${value}'`;
  if (!value.includes('"') && !value.includes('\\') && !value.includes('\r')) return `${name}="${value}"`;
  throw new Error(`${name} cannot be written exactly to the deployment; set it by hand.`);
}

export function envFileContent(set) {
  return `${Object.entries(set).map(([name, value]) => envLine(name, value)).join('\n')}\n`;
}

/** The lines written to `$GITHUB_OUTPUT` (or `PREVIEW_OUTPUT`). Public values only. */
export function outputLines(name) {
  return [
    `convex_url=https://${name}.convex.cloud`,
    `convex_site=https://${name}.convex.site`,
    `deployment=${name}`,
  ];
}

/**
 * The convex CLI with a minimal environment: the deploy key and no staging secrets. Its stdout is kept
 * only when `capture` is set, for the names-only listing; everything else is discarded.
 */
function convexCli(args, key, { capture = false } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CONVEX_DEPLOY_KEY: key,
      CONVEX_DEPLOYMENT: '',
      NO_COLOR: '1',
    },
  });
}

/** Sets and removes the preview's variables. Throws on any refusal, naming the variable only. */
export function applyPreviewEnv(env, { cli = convexCli } = {}) {
  const name = deploymentFromUrl(env.PREVIEW_CONVEX_URL);
  assertPreviewKey(env.CONVEX_DEPLOY_KEY);
  const { set, remove } = previewEnvValues(env);
  const content = envFileContent(set);
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'preview-env-'));
  try {
    const file = join(dir, 'env');
    writeFileSync(file, content, { mode: 0o600 });
    chmodSync(file, 0o600);
    const setResult = cli(['env', 'set', '--deployment', name, '--force', '--from-file', file], env.CONVEX_DEPLOY_KEY);
    if (setResult.status !== 0) throw new Error(`convex env set failed (exit ${setResult.status}).`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // One names-only listing says which forbidden names exist, so only those are removed. If the listing
  // fails, every forbidden name is removed, as before. Only names are read from its output.
  const present = presentNames(cli, name, env.CONVEX_DEPLOY_KEY);
  const toRemove = present === null ? remove : remove.filter((variable) => present.has(variable));
  for (const variable of toRemove) {
    const result = cli(['env', 'remove', '--deployment', name, variable], env.CONVEX_DEPLOY_KEY);
    if (result.status !== 0) throw new Error(`convex env remove ${variable} failed (exit ${result.status}).`);
  }
  return { name, set: Object.keys(set), removed: toRemove };
}

/**
 * The variable names the deployment holds, from `env list --names-only`, or null when the listing fails.
 * Its stdout is read here and nowhere else; a value is never in this output.
 */
export function presentNames(cli, deployment, key) {
  let result;
  try {
    result = cli(['env', 'list', '--deployment', deployment, '--names-only'], key, { capture: true });
  } catch {
    return null;
  }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return new Set(result.stdout.split(/\s+/).filter(Boolean));
}

export function run(env = process.env, { cli = convexCli, log = console.log } = {}) {
  const { name, set, removed } = applyPreviewEnv(env, { cli });
  log(`Set on the preview: ${set.join(' ')}`);
  log(`Removed (only those the preview held): ${removed.join(' ') || 'none'}`);
  const target = env.PREVIEW_OUTPUT || env.GITHUB_OUTPUT;
  if (target) appendFileSync(target, `${outputLines(name).join('\n')}\n`);
  return { name };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.env);
  } catch (error) {
    console.error(`preview-convex-env: ${error.message}`);
    process.exitCode = 1;
  }
}
