#!/usr/bin/env node
/**
 * Delete what a closed pull request's preview left behind, and sweep for any
 * preview whose pull request is no longer open.
 *
 *   node scripts/preview-cleanup.mjs delete <N>   one pull request's preview
 *   node scripts/preview-cleanup.mjs sweep       every closed one, and a count
 *
 * A preview is three Workers on workers.dev (`context-router-pr<N>`,
 * `context-agent-pr<N>`, `context-mcp-pr<N>`), two Workflows (`group-turn-pr<N>`,
 * `job-run-pr<N>`), and storage its Convex deployment created, named with the
 * prefix `pr<N>-`: R2 buckets, D1 databases and Vectorize indexes. Convex
 * expires its own preview deployments; this script does not call the Convex
 * management API, because no endpoint for it is verified here.
 *
 * The matching is exact. `pr1` never matches `pr12`: a name counts only when
 * it starts with `pr<N>-` or ends with `-pr<N>` and the number is complete.
 *
 * Environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (the gateway's
 * account: Workers and Workflows), MANAGED_R2_ACCOUNT_ID (the customer-data
 * account: buckets, D1 and Vectorize, when it differs), GITHUB_REPOSITORY and
 * GH_TOKEN (sweep only). Tests: `node --test scripts/preview-cleanup.test.mjs`.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The most previews the account is sized for at once (about 45). */
export const PREVIEW_CEILING = 45;

const PREVIEW_WORKER = /^context-(mcp|agent|router)-pr([1-9][0-9]{0,6})$/;
const RESOURCE_PREFIX = /^pr([1-9][0-9]{0,6})-/;
const PREVIEW_WORKFLOWS = ["group-turn", "job-run"];
const WORKFLOW_PREVIEW = /^(group-turn|job-run)-pr([1-9][0-9]{0,6})$/;
/** Pages read from a paginated list before the sweep gives up rather than guess. */
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
/** Each Worker's checkout, where its own wrangler is installed. */
const WORKER_DIRS = { router: "infra/router", agent: "apps/agent", mcp: "apps/mcp" };
/** Deleted in this order: a Worker bound by another goes after it. */
const DELETE_ORDER = ["router", "agent", "mcp"];
const API = "https://api.cloudflare.com/client/v4";

/** Whether a name is one of pull request `n`'s resources, by exact prefix or suffix. */
export function isPreviewResource(name, n) {
  const number = String(n);
  if (!/^[1-9][0-9]{0,6}$/.test(number) || typeof name !== "string") return false;
  const tag = `pr${number}`;
  const prefixed = name.startsWith(`${tag}-`) && name.length > tag.length + 1;
  const suffixed = name.endsWith(`-${tag}`) && name.length > tag.length + 1;
  return prefixed || suffixed;
}

/** The pull request number a storage resource name (`pr<N>-...`) belongs to, or null. */
export function resourcePullRequest(name) {
  const match = RESOURCE_PREFIX.exec(name);
  return match ? match[1] : null;
}

/** The pull request number of a preview Worker script (`context-<kind>-pr<N>`), or null. */
export function workerPullRequest(name) {
  const match = PREVIEW_WORKER.exec(name);
  return match ? match[2] : null;
}

/** The pull request number a preview Workflow (`group-turn-pr<N>`, `job-run-pr<N>`) belongs to, or null. */
export function workflowPullRequest(name) {
  const match = WORKFLOW_PREVIEW.exec(name);
  return match ? match[2] : null;
}

/**
 * Every item of a paginated Cloudflare list. Pages are read until one brings
 * nothing new, so a list that ignores `page` still ends. Past MAX_PAGES it
 * throws, so a truncated list is never used.
 */
async function listAll(api, path, key) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = items(await api.request("GET", `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`), key);
    const fresh = batch.filter((item) => {
      const id = JSON.stringify(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (fresh.length === 0) return out;
    out.push(...fresh);
  }
  throw new Error(`${path.split("?")[0]} has more than ${MAX_PAGES} pages; nothing was swept.`);
}

/**
 * The preview Worker scripts whose pull request is not open. `openPrs` is a
 * list of pull request numbers; a name that is not exactly a preview is never returned.
 */
export function orphanNames(scripts, openPrs) {
  const open = new Set(openPrs.map(String));
  return scripts.filter((name) => {
    const number = workerPullRequest(name);
    return number !== null && !open.has(number);
  });
}

/**
 * The Cloudflare client for one token. A 404 resolves to null, which callers
 * treat as already gone. Tests pass their own `api` with the same `request`.
 */
export function cloudflareApi(token) {
  return { request: (method, path) => cloudflareRequest(token, method, path) };
}

async function cloudflareRequest(token, method, path) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`${method} ${path.split("?")[0]} failed: ${message}`);
  }
  return body.result ?? null;
}

/** Cloudflare returns some lists as a bare array and others wrapped under a key. */
const items = (result, key) => (Array.isArray(result) ? result : (result?.[key] ?? []));

/** Every account a preview's storage may live in, once each. */
export function storageAccounts(env) {
  return [...new Set([env.CLOUDFLARE_ACCOUNT_ID, env.MANAGED_R2_ACCOUNT_ID].filter(Boolean))];
}

/** Every storage resource name in every account, as `{ kind, account, name, id }`. */
async function listStorage(api, env) {
  const cf = (method, path) => api.request(method, path);
  const out = [];
  for (const account of storageAccounts(env)) {
    for (const bucket of items(await cf("GET", `/accounts/${account}/r2/buckets?per_page=1000`), "buckets")) {
      out.push({ kind: "R2 bucket", account, name: bucket.name, id: bucket.name });
    }
    for (const db of items(await cf("GET", `/accounts/${account}/d1/database?per_page=1000`), "databases")) {
      out.push({ kind: "D1 database", account, name: db.name, id: db.uuid ?? db.id });
    }
    for (const index of items(await cf("GET", `/accounts/${account}/vectorize/v2/indexes`), "indexes")) {
      out.push({ kind: "Vectorize index", account, name: index.name, id: index.name });
    }
  }
  return out;
}

/** Remove one storage resource; a failure is reported and the caller carries on. */
async function removeStorage(api, item, log) {
  const path = { "R2 bucket": `/accounts/${item.account}/r2/buckets/${item.id}`,
    "D1 database": `/accounts/${item.account}/d1/database/${item.id}`,
    "Vectorize index": `/accounts/${item.account}/vectorize/v2/indexes/${item.id}` }[item.kind];
  try {
    await api.request("DELETE", path);
    log(`deleted ${item.kind} ${item.name}`);
  } catch (error) {
    // A bucket that still holds objects is refused by R2; it is named here so it can be emptied.
    log(`::warning::could not delete ${item.kind} ${item.name}: ${error.message}`);
  }
}

/**
 * Run wrangler from a Worker's own checkout. Errors carry stderr, so a Worker
 * that is already gone can be told apart from a real failure.
 */
export function wrangler(env, worker, args) {
  execFileSync("pnpm", ["--dir", WORKER_DIRS[worker], "exec", "wrangler", ...args], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID },
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
  });
}

/** Delete one pull request's preview: Workers, Workflows, then storage. */
export async function deletePreview(env, n, { log = console.log, runWrangler = wrangler, api = cloudflareApi(env.CLOUDFLARE_API_TOKEN) } = {}) {
  const gone = /not found|10007|does not exist/i;
  for (const worker of DELETE_ORDER) {
    const name = `context-${worker}-pr${n}`;
    try {
      runWrangler(env, worker, ["delete", "--name", name, "--force"]);
      log(`deleted Worker ${name}`);
    } catch (error) {
      if (!gone.test(String(error.stderr ?? error.message))) throw error;
      log(`Worker ${name} was already gone`);
    }
  }
  const workflowNames = new Set(PREVIEW_WORKFLOWS.map((base) => `${base}-pr${n}`));
  for (const workflow of await listAll(api, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workflows`, "workflows")) {
    if (!workflowNames.has(workflow.name)) continue;
    try {
      await api.request("DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workflows/${workflow.name}`);
      log(`deleted Workflow ${workflow.name}`);
    } catch (error) {
      log(`::warning::could not delete Workflow ${workflow.name}: ${error.message}`);
    }
  }
  for (const item of (await listStorage(api, env)).filter((s) => isPreviewResource(s.name, n))) {
    await removeStorage(api, item, log);
  }
  log(`pull request #${n}: preview cleanup finished.`);
}

/**
 * Find every preview left behind, ask GitHub which pull requests are open, and
 * delete the previews of the rest. Live previews are counted against the ceiling.
 */
export async function sweep(env, { log = console.log, runWrangler = wrangler, openPullRequests, api = cloudflareApi(env.CLOUDFLARE_API_TOKEN) } = {}) {
  const scripts = (await listAll(api, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`, "result"))
    .map((script) => script.id);
  // Throws when the list is truncated or fails: nothing below runs, so nothing is deleted.
  const open = new Set(await openPullRequests());
  const storage = await listStorage(api, env);
  const storageNumbers = storage.map((item) => resourcePullRequest(item.name)).filter(Boolean);
  // A Workflow whose Worker was deleted is still a preview of its pull request.
  const workflowNumbers = (await listAll(api, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workflows`, "workflows"))
    .map((workflow) => workflowPullRequest(workflow.name))
    .filter(Boolean);
  const previews = new Set([...scripts.map(workerPullRequest).filter(Boolean), ...storageNumbers, ...workflowNumbers]);
  // Worker scripts decide by `orphanNames`; storage and Workflow names by their pattern.
  const closed = new Set([
    ...orphanNames(scripts, [...open]).map(workerPullRequest),
    ...storageNumbers,
    ...workflowNumbers,
  ].filter((n) => !open.has(n)));
  for (const n of [...closed].sort((a, b) => Number(a) - Number(b))) {
    log(`pull request #${n} is not open; deleting its preview`);
    await deletePreview(env, n, { log, runWrangler, api });
  }
  const live = [...previews].filter((n) => open.has(n)).length;
  log(`${live} live preview(s) of about ${PREVIEW_CEILING}; ${closed.size} closed preview(s) cleaned up.`);
  if (live >= PREVIEW_CEILING) log(`::warning::Live previews are at the ceiling of ${PREVIEW_CEILING}.`);
  return { live, closed: [...closed] };
}

/**
 * Every open pull request number, read page by page until a short page. Any
 * failure or a page that is not a list throws: a partial list would make live
 * previews look closed.
 */
export async function openPullRequestNumbers(token, repo, { fetchImpl = fetch } = {}) {
  const numbers = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      },
    );
    if (!response.ok) throw new Error(`Could not list open pull requests (HTTP ${response.status}, page ${page}).`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`Could not list open pull requests (page ${page} is not a list).`);
    for (const pr of batch) numbers.push(String(pr.number));
    if (batch.length < PAGE_SIZE) return numbers;
  }
  throw new Error(`Open pull requests have more than ${MAX_PAGES} pages; nothing was swept.`);
}

async function main(argv) {
  const env = process.env;
  const [command, value] = argv;
  if (command === "delete") {
    if (!/^[1-9][0-9]{0,6}$/.test(value ?? "")) throw new Error("usage: preview-cleanup.mjs delete <pull request number>");
    await deletePreview(env, value);
    return;
  }
  if (command === "sweep") {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("sweep needs GITHUB_REPOSITORY");
    await sweep(env, { openPullRequests: () => openPullRequestNumbers(env.GH_TOKEN, repo) });
    return;
  }
  throw new Error(`unknown command "${command}" (delete <N> | sweep)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
