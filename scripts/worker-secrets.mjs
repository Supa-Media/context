#!/usr/bin/env node
/**
 * Print a Worker's secrets as one JSON object, for `wrangler secret bulk`.
 *
 *   node scripts/worker-secrets.mjs GATEWAY_SECRET '?BRAVE_SEARCH_API_KEY' \
 *     | pnpm exec wrangler secret bulk --config wrangler.toml
 *
 * Each argument names a secret and the environment variable that holds it:
 *
 * - `NAME` is required: unset or empty fails the step, before anything is sent.
 * - `?NAME` is optional and skipped when empty, with a notice.
 * - `!NAME` is optional and skipped when empty, with a warning (the Worker
 *   runs, but a feature people expect stays off until it is set).
 * - `TARGET=SOURCE` sends the value of `$SOURCE` as the secret `TARGET`.
 *
 * Why: a deploy used to push each secret with its own `wrangler secret put`.
 * Every one starts Wrangler and publishes a new version of the Worker, so the
 * gateway's ten took about 24 of its 70 seconds in production. One bulk call
 * is one request and one version. Values travel only through the environment
 * and this script's stdout into Wrangler's stdin, never a command line or a
 * log; only names are printed, to stderr. `scripts/check-workflow-secret-order.mjs`
 * and `scripts/check-wrangler-vars-not-secrets.mjs` read the names off the
 * line that runs this script, so it must be invoked as `scripts/worker-secrets.mjs`.
 */
import { pathToFileURL } from "node:url";

const SPEC = /^([?!]?)([A-Z][A-Z0-9_]*)(?:=([A-Z][A-Z0-9_]*))?$/;

/**
 * @param {string[]} specs
 * @param {Record<string, string | undefined>} env
 * @returns {{ secrets: Record<string, string>, skipped: { name: string, level: "notice" | "warning" }[], missing: string[] }}
 */
export function collectSecrets(specs, env) {
  if (specs.length === 0) throw new Error("worker-secrets.mjs: name at least one secret");
  const secrets = {};
  const skipped = [];
  const missing = [];
  const seen = new Set();
  for (const spec of specs) {
    const match = SPEC.exec(spec);
    if (!match) throw new Error(`worker-secrets.mjs: ${JSON.stringify(spec)} is not NAME, ?NAME, !NAME or TARGET=SOURCE`);
    const [, mark, target, source = target] = match;
    if (seen.has(target)) throw new Error(`worker-secrets.mjs: ${target} is named twice`);
    seen.add(target);
    const value = env[source];
    if (value) secrets[target] = value;
    else if (mark === "?") skipped.push({ name: target, level: "notice" });
    else if (mark === "!") skipped.push({ name: target, level: "warning" });
    else missing.push(source);
  }
  return { secrets, skipped, missing };
}

/** The secret names a workflow line passes to this script, in order. */
export function secretNamesIn(line) {
  const at = line.search(/\bscripts\/worker-secrets\.mjs\b/);
  if (at === -1) return [];
  const args = line.slice(at).split("|")[0];
  return [...args.matchAll(/(?:^|\s)['"]?[?!]?([A-Z][A-Z0-9_]*)(?:=[A-Z][A-Z0-9_]*)?['"]?(?=\s|$)/g)].map((m) => m[1]);
}

function main() {
  const { secrets, skipped, missing } = collectSecrets(process.argv.slice(2), process.env);
  if (missing.length) {
    console.error(`::error::${missing.join(", ")} must be set for this Worker; nothing was sent.`);
    process.exit(1);
  }
  for (const { name, level } of skipped) console.error(`::${level}::${name} is not set; the Worker keeps running without it.`);
  console.error(`Sending ${Object.keys(secrets).length} secret(s) in one request: ${Object.keys(secrets).join(", ") || "(none)"}.`);
  process.stdout.write(JSON.stringify(secrets));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
