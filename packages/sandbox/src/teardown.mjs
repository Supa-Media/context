/**
 * The parts of a preview's teardown that `wrangler delete` does not do, used by
 * packages/sandbox/src/cleanup.mjs:
 *
 * - **Buckets are emptied before they are deleted.** R2 refuses to delete a
 *   bucket that holds objects, and a preview's managed buckets always hold its
 *   seeded notes, so a bare DELETE left every one of them behind.
 * - **The bucket-scoped R2 tokens are revoked.** Managed provisioning mints one
 *   account token per bucket, named `Context — <bucket>`
 *   (apps/convex/functions/lib/cloudflare/naming.ts `scopedTokenName`). Only a
 *   token whose name is exactly that, for a `pr<N>-ctx-` bucket, is touched.
 * - **The Convex preview deployment is deleted**, with its data, env vars and
 *   the integration secrets the seed stored there, instead of waiting for
 *   Convex to expire it.
 * - **`verifyGone`** lists every kind of resource a preview makes and names any
 *   that is still there, so a cleanup proves its own result.
 *
 * Durable Objects need no step of their own: deleting a Worker deletes the
 * namespaces of the classes it defines, and `verifyGone` checks that too.
 *
 * Nothing here prints a token, a key, an admin key or a response body: only
 * names, counts and HTTP statuses.
 */

/** Pages of one bucket listed and deleted before giving up: 1,000 keys a page. */
const MAX_EMPTY_ROUNDS = 200;
const DELETE_CONCURRENCY = 16;
const MAX_TOKEN_PAGES = 50;
const CONVEX_API = "https://api.convex.dev";

const TOKEN_NAME = /^Context — (pr([1-9][0-9]{0,6})-ctx-[a-z0-9]+)$/;

/** The pull request number and bucket a scoped token was minted for, or null when it is not a preview's. */
export function previewTokenOf(name) {
  const match = TOKEN_NAME.exec(typeof name === "string" ? name : "");
  return match ? { bucket: match[1], pr: match[2] } : null;
}

/**
 * Empty one bucket through the R2 REST API, a page at a time, always from the
 * start (the listing changes as objects go), then delete it. The same calls as
 * account erasure (apps/convex/functions/lib/cloudflare/erase.ts).
 */
export async function emptyAndDeleteBucket(api, account, bucket, { log = console.log } = {}) {
  const path = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}`;
  let deleted = 0;
  for (let round = 0; round < MAX_EMPTY_ROUNDS; round += 1) {
    const rows = await api.request("GET", `${path}/objects?per_page=1000`);
    if (rows === null) return { deleted, gone: true };
    const keys = (Array.isArray(rows) ? rows : (rows?.objects ?? [])).map((row) => row?.key).filter((key) => typeof key === "string");
    if (keys.length === 0) {
      await api.request("DELETE", path);
      log(`deleted R2 bucket ${bucket} (${deleted} object(s) removed first)`);
      return { deleted, gone: true };
    }
    for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
      await Promise.all(keys.slice(start, start + DELETE_CONCURRENCY).map((key) =>
        api.request("DELETE", `${path}/objects/${key.split("/").map(encodeURIComponent).join("/")}`)));
    }
    deleted += keys.length;
  }
  throw new Error(`R2 bucket ${bucket} still holds objects after ${MAX_EMPTY_ROUNDS} pages`);
}

/** Every account token, page by page. Throws past the page limit rather than act on a partial list. */
export async function listAccountTokens(api, account) {
  const out = [];
  for (let page = 1; page <= MAX_TOKEN_PAGES; page += 1) {
    const batch = await api.request("GET", `/accounts/${account}/tokens?per_page=50&page=${page}`);
    const rows = Array.isArray(batch) ? batch : [];
    out.push(...rows);
    if (rows.length < 50) return out;
  }
  throw new Error(`account tokens have more than ${MAX_TOKEN_PAGES} pages; none were revoked.`);
}

/** Revoke every scoped token minted for one of pull request `n`'s buckets (exact name only). */
export async function revokePreviewTokens(api, accounts, n, { log = console.log } = {}) {
  let revoked = 0;
  for (const account of accounts) {
    for (const token of await listAccountTokens(api, account)) {
      if (previewTokenOf(token?.name)?.pr !== String(n)) continue;
      await api.request("DELETE", `/accounts/${account}/tokens/${encodeURIComponent(token.id)}`);
      log(`revoked R2 token "${token.name}"`);
      revoked += 1;
    }
  }
  return revoked;
}

/** The team and project a preview deploy key (`preview:<team>:<project>|<secret>`) belongs to, or null. */
export function previewKeyProject(key) {
  const match = /^preview:([a-z0-9-]+):([a-z0-9-]+)\|.+$/.exec(typeof key === "string" ? key : "");
  return match ? { teamSlug: match[1], projectSlug: match[2] } : null;
}

/**
 * Find a preview deployment by its name (`pr<N>`) with the preview deploy key,
 * as `convex deploy --preview-name` does (`deployment/authorize_preview`).
 * Returns its deployment name, or null when there is none. The answer also
 * carries an admin key: it is dropped here and never logged.
 */
export async function findConvexPreview(key, previewName, { fetchImpl = fetch } = {}) {
  const project = previewKeyProject(key);
  if (!project) throw new Error("CONVEX_DEPLOY_KEY is not a preview deploy key.");
  const response = await fetchImpl(`${CONVEX_API}/api/deployment/authorize_preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Convex-Client": "npm-cli-1.45.0" },
    body: JSON.stringify({ previewName, projectSelection: { kind: "teamAndProjectSlugs", ...project } }),
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // A preview that does not exist is answered as an error with a code, not always a 404.
    if (/not.?found|NoSuchDeployment|PreviewDeploymentNotFound/i.test(String(body?.code ?? ""))) return null;
    throw new Error(`Convex could not look up preview ${previewName} (HTTP ${response.status}${body?.code ? `, ${String(body.code).slice(0, 60)}` : ""}).`);
  }
  const name = body?.deploymentName;
  if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw new Error(`Convex named no deployment for preview ${previewName}.`);
  return name;
}

/** Delete pull request `n`'s Convex preview deployment. "gone" when there is none to delete. */
export async function deleteConvexPreview(key, n, { fetchImpl = fetch, log = console.log } = {}) {
  const previewName = `pr${n}`;
  const name = await findConvexPreview(key, previewName, { fetchImpl });
  if (name === null) {
    log(`Convex preview ${previewName} was already gone`);
    return "gone";
  }
  const response = await fetchImpl(`${CONVEX_API}/v1/deployments/${name}/delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Convex-Client": "npm-cli-1.45.0" },
    body: "{}",
  });
  if (response.status === 404) {
    log(`Convex preview ${previewName} was already gone`);
    return "gone";
  }
  if (!response.ok) throw new Error(`Convex refused to delete preview ${previewName} (HTTP ${response.status}).`);
  log(`deleted Convex preview deployment ${previewName}`);
  return "deleted";
}

/**
 * Every resource of pull request `n` still present, as "<kind> <name>" lines:
 * Workers, Workflows, Durable Object namespaces, buckets, D1 databases,
 * Vectorize indexes, scoped tokens and the Convex deployment. Empty means gone.
 */
export async function verifyGone(env, n, { api, tokenApi = api, storageAccounts, isPreviewResource, fetchImpl = fetch } = {}) {
  const left = [];
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const workerNames = new Set(["mcp", "agent", "router", "emulators"].flatMap((k) => [`context-${k}-pr${n}`, `context-${k}-pr${n}-preview`]));
  const list = async (path) => {
    const result = await api.request("GET", path);
    return Array.isArray(result) ? result : (result?.workflows ?? result?.buckets ?? result?.indexes ?? result?.databases ?? []);
  };
  for (const script of await list(`/accounts/${account}/workers/scripts`)) {
    if (workerNames.has(script.id)) left.push(`Worker ${script.id}`);
  }
  for (const workflow of await list(`/accounts/${account}/workflows?per_page=100`)) {
    if (isPreviewResource(workflow.name, n)) left.push(`Workflow ${workflow.name}`);
  }
  for (const ns of await list(`/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`)) {
    if (workerNames.has(ns.script)) left.push(`Durable Object namespace ${ns.script}.${ns.class}`);
  }
  for (const acct of storageAccounts(env)) {
    for (const bucket of await list(`/accounts/${acct}/r2/buckets?per_page=1000`)) {
      if (isPreviewResource(bucket.name, n)) left.push(`R2 bucket ${bucket.name}`);
    }
    for (const db of await list(`/accounts/${acct}/d1/database?per_page=1000`)) {
      if (isPreviewResource(db.name, n)) left.push(`D1 database ${db.name}`);
    }
    for (const index of await list(`/accounts/${acct}/vectorize/v2/indexes`)) {
      if (isPreviewResource(index.name, n)) left.push(`Vectorize index ${index.name}`);
    }
    for (const token of await listAccountTokens(tokenApi, acct)) {
      if (previewTokenOf(token?.name)?.pr === String(n)) left.push(`R2 token ${token.name}`);
    }
  }
  if (env.CONVEX_DEPLOY_KEY && (await findConvexPreview(env.CONVEX_DEPLOY_KEY, `pr${n}`, { fetchImpl })) !== null) {
    left.push(`Convex preview deployment pr${n}`);
  }
  return left;
}
