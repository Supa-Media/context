/**
 * What a pull request's preview owns, and what it only uses.
 *
 * Every kind of thing a preview creates is listed in OWNED, with where it is
 * created, the step that tears it down and the label `verifyGone` reports it
 * under when it is still there. Everything a preview touches without creating
 * anything of its own is listed in USED, with the reason it needs no teardown.
 *
 * scripts/preview-resources-check.mjs fails CI when a preview's Worker config,
 * deploy step or Cloudflare API call names a kind that is in neither list, and
 * scripts/preview-resources.test.mjs fails when an owned kind's leftover is not
 * reported by `verifyGone`. So adding something to a preview means saying here
 * how it goes away, and proving the check notices when it does not.
 */

/** Things a preview creates. `fake(n)` is one leftover as the Cloudflare listing shows it, for the test. */
export const OWNED = [
  {
    kind: "Worker",
    createdBy: "deploy-preview.yml `wrangler deploy --name context-<mcp|agent|router>-pr<N>`",
    teardown: "preview-cleanup.mjs deletePreview: `wrangler delete`",
    label: "Worker",
    fake: (n) => ({ path: "/workers/scripts", account: "gateway", row: { id: `context-agent-pr${n}` } }),
  },
  {
    kind: "Durable Object namespace",
    createdBy: "a preview Worker's `durable_objects` bindings (mcp, agent)",
    teardown: "deleted with the Worker that defines the class",
    label: "Durable Object namespace",
    fake: (n) => ({ path: "/workers/durable_objects/namespaces", account: "gateway", row: { script: `context-mcp-pr${n}`, class: "WorkspaceStore" } }),
  },
  {
    kind: "Workflow",
    createdBy: "apps/agent env.preview `workflows` (group-turn, job-run)",
    teardown: "preview-cleanup.mjs deletePreview: DELETE /workflows/<name>",
    label: "Workflow",
    fake: (n) => ({ path: "/workflows", account: "gateway", row: { name: `job-run-pr${n}` } }),
  },
  {
    kind: "R2 bucket",
    createdBy: "Convex managed provisioning (lib/cloudflare/provisioning.ts), names pr<N>-ctx-<id>",
    teardown: "preview-teardown.mjs emptyAndDeleteBucket",
    label: "R2 bucket",
    fake: (n) => ({ path: "/r2/buckets", account: "storage", row: { name: `pr${n}-ctx-abc` } }),
  },
  {
    kind: "R2 token",
    createdBy: "Convex managed provisioning, one per bucket, named `Context — <bucket>`",
    teardown: "preview-teardown.mjs revokePreviewTokens",
    label: "R2 token",
    fake: (n) => ({ path: "/tokens", account: "storage", row: { id: "t1", name: `Context — pr${n}-ctx-abc` } }),
  },
  {
    kind: "D1 database",
    createdBy: "Convex word search provisioning (lib/d1.ts), names pr<N>-context-search-<id>",
    teardown: "preview-cleanup.mjs removeStorage",
    label: "D1 database",
    fake: (n) => ({ path: "/d1/database", account: "storage", row: { name: `pr${n}-context-search-abc`, uuid: "u1" } }),
  },
  {
    kind: "Vectorize index",
    createdBy: "Convex meaning search provisioning, names pr<N>-context-meaning-<id>",
    teardown: "preview-cleanup.mjs removeStorage",
    label: "Vectorize index",
    fake: (n) => ({ path: "/vectorize/v2/indexes", account: "storage", row: { name: `pr${n}-context-meaning-abc` } }),
  },
  {
    kind: "Convex preview deployment",
    createdBy: "deploy-preview.yml `convex deploy --preview-create pr<N>`, with its data, env vars and seeded secrets",
    teardown: "preview-teardown.mjs deleteConvexPreview",
    label: "Convex preview deployment",
    fake: null,
  },
];

/** Worker config keys under `env.preview` that create nothing of the preview's own, and why. */
export const USED_BINDINGS = {
  name: "the Worker's own name, created as the Worker",
  workers_dev: "the Worker's workers.dev route, gone with the Worker",
  durable_objects: "namespaces are OWNED: Durable Object namespace",
  migrations: "describe the Worker's own Durable Object classes",
  workflows: "OWNED: Workflow",
  analytics_engine_datasets: "shared `*_preview` datasets written to, never created per pull request",
  services: "bindings to the preview's own Workers or to shared staging Workers (checked by preview-config.mjs)",
  ai: "Workers AI, a model call, nothing stored",
  images: "Cloudflare Images transforms, nothing stored",
  version_metadata: "read-only facts about the deployed version",
  vars: "plain values inside the Worker",
  triggers: "cron schedules of the Worker, gone with it",
  assets: "static files uploaded with the Worker, gone with it",
};

/**
 * Cloudflare API path families (after /accounts/<id>/) that code a preview runs
 * may call. `owned` names the OWNED kind a family creates; `used` says why it
 * creates nothing that outlives the preview. The longest matching prefix wins.
 */
export const API_FAMILIES = {
  "workers/scripts": { owned: "Worker" },
  "workers/durable_objects": { owned: "Durable Object namespace" },
  workflows: { owned: "Workflow" },
  "r2/buckets": { owned: "R2 bucket" },
  tokens: { owned: "R2 token" },
  "tokens/verify": { used: "checks the caller's own token" },
  "tokens/permission_groups": { used: "reads the permission catalogue" },
  "d1/database": { owned: "D1 database" },
  "vectorize/v2/indexes": { owned: "Vectorize index" },
  "r2/temp-access-credentials": { used: "short-lived credentials that expire on their own" },
  "analytics_engine/sql": { used: "reads shared datasets" },
  "ai/run": { used: "a model call, nothing stored" },
};

/** The API family a path (after /accounts/<id>/) belongs to, by longest registered prefix, or null. */
export function apiFamily(path) {
  const clean = String(path).replace(/^\/+/, "");
  let best = null;
  for (const family of Object.keys(API_FAMILIES)) {
    if ((clean === family || clean.startsWith(`${family}/`)) && (best === null || family.length > best.length)) best = family;
  }
  return best;
}

/** Problems with the registry itself: an owned family naming no OWNED kind, an OWNED kind with no teardown. */
export function registryProblems() {
  const kinds = new Set(OWNED.map((entry) => entry.kind));
  const problems = [];
  for (const entry of OWNED) {
    for (const field of ["createdBy", "teardown", "label"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") problems.push(`owned kind "${entry.kind}" has no ${field}`);
    }
  }
  for (const [family, rule] of Object.entries(API_FAMILIES)) {
    if (rule.owned && !kinds.has(rule.owned)) problems.push(`API family ${family} is owned by "${rule.owned}", which OWNED does not list`);
    if (!rule.owned && !(typeof rule.used === "string" && rule.used.trim())) problems.push(`API family ${family} gives no reason it needs no teardown`);
  }
  return problems;
}
