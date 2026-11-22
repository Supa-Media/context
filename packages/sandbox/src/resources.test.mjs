import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { deletePreview, isPreviewResource, storageAccounts } from "./cleanup.mjs";
import { verifyGone } from "./teardown.mjs";
import { API_FAMILIES, apiFamily, OWNED, registryProblems } from "./resources.mjs";
import { accountPaths, deployedWorkers, previewKeys, problems } from "./resources-check.mjs";

const N = 7;
const ENV = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway", MANAGED_R2_ACCOUNT_ID: "storage", CONVEX_DEPLOY_KEY: "preview:team:proj|secret" };
const ACCOUNTS = { gateway: "gateway", storage: "storage" };

/**
 * A fake Cloudflare and Convex holding one leftover of one owned kind. A delete
 * removes it unless `honorDeletes` is false, which stands in for a teardown
 * step that is missing.
 */
function fakeWorld(entry, { honorDeletes = true } = {}) {
  const rows = new Map(); // "<account><listing path>" -> rows
  let convexAlive = entry.kind === "Convex preview deployment";
  if (entry.fake) {
    const leftover = entry.fake(N);
    rows.set(`/accounts/${ACCOUNTS[leftover.account]}${leftover.path}`, [leftover.row]);
  }
  const listing = (path) => {
    const bare = path.split("?")[0];
    if (/[?&]page=([2-9]|\d\d)/.test(path)) return [];
    return rows.get(bare) ?? [];
  };
  const remove = (bare) => {
    if (!honorDeletes) return;
    for (const [prefix, list] of rows) {
      if (!bare.startsWith(`${prefix}/`)) continue;
      const last = decodeURIComponent(bare.slice(prefix.length + 1));
      rows.set(prefix, list.filter((row) => ![row.id, row.uuid, row.name].includes(last)));
    }
  };
  const api = {
    request: async (method, path) => {
      const bare = path.split("?")[0];
      if (method === "GET" && bare.endsWith("/objects")) return [];
      if (method === "GET") return listing(path);
      if (method === "DELETE") remove(bare);
      return null;
    },
  };
  const runWrangler = (_env, _worker, args) => {
    const name = args[args.indexOf("--name") + 1];
    if (!honorDeletes) return;
    const scripts = `/accounts/gateway/workers/scripts`;
    const namespaces = `/accounts/gateway/workers/durable_objects/namespaces`;
    rows.set(scripts, (rows.get(scripts) ?? []).filter((row) => row.id !== name));
    // Deleting a Worker deletes the namespaces of the classes it defines.
    rows.set(namespaces, (rows.get(namespaces) ?? []).filter((row) => row.script !== name));
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/authorize_preview")) {
      return convexAlive
        ? new Response(JSON.stringify({ deploymentName: "fake-deployment-123", adminKey: "never-logged" }), { status: 200 })
        : new Response(JSON.stringify({ code: "PreviewDeploymentNotFound" }), { status: 400 });
    }
    if (url.endsWith("/delete")) {
      if (honorDeletes) convexAlive = false;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { api, runWrangler, fetchImpl };
}

test("the registry is complete: every owned kind names how it is created, torn down and reported", () => {
  assert.deepEqual(registryProblems(), []);
});

for (const entry of OWNED) {
  test(`teardown removes a leftover ${entry.kind}, and the gone-check agrees`, async () => {
    const world = fakeWorld(entry);
    const left = await deletePreview(ENV, N, { log: () => {}, ...world, tokenApi: world.api });
    assert.deepEqual(left, []);
  });

  test(`a ${entry.kind} that teardown failed to remove is reported as "${entry.label}"`, async () => {
    const world = fakeWorld(entry, { honorDeletes: false });
    const left = await verifyGone(ENV, N, { api: world.api, tokenApi: world.api, storageAccounts, isPreviewResource, fetchImpl: world.fetchImpl });
    assert.equal(left.length, 1, `verifyGone saw ${JSON.stringify(left)}`);
    assert.ok(left[0].startsWith(`${entry.label} `), left[0]);
  });
}

test("API families resolve by longest prefix, and an unlisted one is null", () => {
  assert.equal(apiFamily("tokens/verify"), "tokens/verify");
  assert.equal(apiFamily("tokens/abc"), "tokens");
  assert.equal(apiFamily("r2/buckets/pr7-ctx-a/objects/k"), "r2/buckets");
  assert.equal(apiFamily("queues"), null);
  assert.equal(apiFamily("r2/bucketsx"), null);
  for (const family of Object.keys(API_FAMILIES)) assert.equal(apiFamily(family), family);
});

test("account paths are read from template literals, across lines too", () => {
  assert.deepEqual(accountPaths("x(`/accounts/${a.b}/r2/buckets/${name}`); y(`${BASE}/accounts/${encodeURIComponent(\n id)}/ai/run/${M}`)"), ["r2/buckets", "ai/run"]);
});

test("TOML preview keys include tables and top-level keys of env.preview only", () => {
  const toml = 'name = "x"\n[env.preview]\nname = "p"\nworkers_dev = true\n[[env.preview.services]]\nbinding = "A"\nservice = "s"\n[env.preview.vars]\nX = "1"\n';
  assert.deepEqual(previewKeys(toml, "toml").sort(), ["name", "services", "vars", "workers_dev"]);
});

test("deployed Workers are read from wrangler deploy --name lines", () => {
  assert.deepEqual(deployedWorkers('wrangler deploy --env preview --name "context-mcp-pr$PR"\nx wrangler deploy --name "context-queue-pr$PR" y'), ["mcp", "queue"]);
});

/** The real files, with one replaced. */
async function withChange(rel, change) {
  const read = (path) => (path === rel ? change(readReal(path)) : readReal(path));
  return problems({ read, files: [] });
}

test("the repository passes as it is", async () => {
  assert.deepEqual(problems({ files: [] }), []);
});

test("a new binding kind in a preview config fails until it is registered", async () => {
  const found = await withChange("apps/agent/wrangler.jsonc", (text) => text.replace('"name": "context-agent-__PREVIEW__",', '"name": "context-agent-__PREVIEW__", "queues": {},'));
  assert.ok(found.some((line) => line.includes("env.preview.queues")), JSON.stringify(found));
});

test("a preview Workflow cleanup does not know fails, and one cleanup knows passes", async () => {
  const found = await withChange("apps/agent/wrangler.jsonc", (text) => text.replace('"name": "context-agent-__PREVIEW__",', '"name": "context-agent-__PREVIEW__", "workflows": [{ "name": "job-walk-__PREVIEW__", "binding": "JOB_WALK", "class_name": "JobWalk" }],'));
  assert.ok(found.some((line) => line.includes("PREVIEW_WORKFLOWS")), JSON.stringify(found));
  const known = await withChange("apps/agent/wrangler.jsonc", (text) => text.replace('"name": "context-agent-__PREVIEW__",', '"name": "context-agent-__PREVIEW__", "workflows": [{ "name": "job-run-__PREVIEW__", "binding": "JOB_RUN", "class_name": "JobRunWorkflow" }],'));
  assert.ok(!known.some((line) => line.includes("PREVIEW_WORKFLOWS")), JSON.stringify(known));
});

test("a fourth preview Worker that cleanup does not delete fails", async () => {
  const found = await withChange(".github/workflows/deploy-preview.yml", (text) => `${text}\n      - run: pnpm exec wrangler deploy --env preview --name "context-queue-pr$PR"\n`);
  assert.ok(found.some((line) => line.includes("WORKER_DIRS")), JSON.stringify(found));
});

test("code that calls an unlisted Cloudflare API family fails", () => {
  const found = problems({ files: ["apps/convex/functions/lib/fake.ts"], read: (path) => (path === "apps/convex/functions/lib/fake.ts" ? "f(`/accounts/${id}/queues`)" : readReal(path)) });
  assert.ok(found.some((line) => line.includes("/accounts/…/queues")), JSON.stringify(found));
});

function readReal(path) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}
