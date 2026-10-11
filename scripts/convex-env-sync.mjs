// Push a list of environment variables to a Convex deployment in ONE request.
//
// `convex env set NAME` is one CLI process and one HTTP round trip per
// variable; thirty of them took ~30 seconds of every staging and production
// deploy. The CLI's own `env set` ends in the same call this makes —
// POST /api/update_environment_variables with { changes: [{ name, value }] }
// (convex/dist/cjs/cli/lib/env.js) — so batching it changes nothing but the
// count. Semantics are kept: an absent or empty value is never pushed (it is
// left as whatever the deployment holds), and nothing is ever unset.
//
// Values travel in a request body over HTTPS, never on a command line, in a
// file, or in the log; only names are printed.
import { pathToFileURL } from 'node:url';

/** The deployment name a deploy key is scoped to: `prod:<name>|<secret>`. */
export function deploymentFromKey(key) {
  const match = /^(?:prod|preview|dev):([a-z0-9-]+)\|/.exec(key ?? '');
  if (!match) throw new Error('CONVEX_DEPLOY_KEY is not a Convex deploy key.');
  return match[1];
}

/**
 * The changes to send: every named variable with a non-empty value, in order.
 * Returns the names left out so the caller can say so.
 */
export function plannedChanges(names, values) {
  const changes = [];
  const skipped = [];
  for (const name of names) {
    const value = values[name];
    if (value === undefined || value === '') skipped.push(name);
    else changes.push({ name, value });
  }
  return { changes, skipped };
}

/**
 * The deployment URL, refusing one that is not the deployment the key opens:
 * a key must never be sent to another host.
 */
export function deploymentUrl(url, key) {
  const name = deploymentFromKey(key);
  const parsed = new URL(url ?? '');
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${name}.convex.cloud` || parsed.pathname.replace(/\/$/, '') !== '') {
    throw new Error(`The Convex URL is not https://${name}.convex.cloud, the deployment CONVEX_DEPLOY_KEY opens.`);
  }
  return `https://${name}.convex.cloud`;
}

/**
 * A refusal's body, with every value this call was syncing taken out.
 *
 * The body names the problem — an invalid variable name, a bad admin key — and
 * that diagnosis is why it is printed at all. It reaches a **public** Actions
 * log, though, and the variables here include `STORAGE_SECRET_ENCRYPTION_KEY`,
 * `JWT_PRIVATE_KEY`, `GATEWAY_SECRET` and the Twilio API key secret. This used
 * to rest on "the body never echoes a value back", which is a claim about
 * somebody else's error format: true today, unannounced if it changes, and
 * public when it does.
 *
 * GitHub's secret masking is not the backstop it looks like either. It redacts
 * exact matches, and this is truncated, so a value cut across the limit arrives
 * as a fragment the masker does not recognise.
 *
 * So the values are removed here, where they are known. `split`/`join` rather
 * than a built pattern because a value is not ours to assume is regex-safe,
 * and **before** the truncation so a half-cut secret cannot survive the cut.
 * Short values are left alone: a one or two character variable is not a secret
 * and would redact half the alphabet out of the diagnosis.
 */
export function safeRefusalDetail(body, changes) {
  let detail = typeof body === 'string' ? body : '';
  for (const change of changes ?? []) {
    const value = change?.value;
    if (typeof value === 'string' && value.length >= 8) detail = detail.split(value).join('[value]');
  }
  return detail.slice(0, 300);
}

export async function syncConvexEnv({ names, values, url, key, fetchImpl = fetch, log = console.log }) {
  const base = deploymentUrl(url, key);
  const { changes, skipped } = plannedChanges(names, values);
  if (changes.length > 0) {
    const response = await fetchImpl(`${base}/api/update_environment_variables`, {
      method: 'POST',
      headers: { authorization: `Convex ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    if (!response.ok) {
      const detail = safeRefusalDetail(await response.text().catch(() => ''), changes);
      throw new Error(`Convex refused the variables (HTTP ${response.status}): ${detail}`);
    }
  }
  log(`Set on the deployment: ${changes.map((c) => c.name).join(' ') || '(none)'}`);
  if (skipped.length > 0) log(`Not present here, so left as the deployment holds them: ${skipped.join(' ')}`);
  return { set: changes.map((c) => c.name), skipped };
}

// CLI: node scripts/convex-env-sync.mjs NAME [NAME ...]
// Reads values from the environment, the deploy key from CONVEX_DEPLOY_KEY and
// the deployment URL from CONVEX_URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await syncConvexEnv({
    names: process.argv.slice(2),
    values: process.env,
    url: process.env.CONVEX_URL,
    key: process.env.CONVEX_DEPLOY_KEY,
  });
}
