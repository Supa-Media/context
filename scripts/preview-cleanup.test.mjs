import test from "node:test";
import assert from "node:assert/strict";

import { deletePreview, isPreviewResource, orphanNames, resourcePullRequest, storageAccounts, workerPullRequest } from "./preview-cleanup.mjs";

test("a resource belongs to pull request N only by its complete prefix or suffix", () => {
  assert.equal(isPreviewResource("pr1-ctx-abc", 1), true);
  assert.equal(isPreviewResource("pr12-ctx-abc", 1), false, "pr1 must not match pr12");
  assert.equal(isPreviewResource("pr12-ctx-abc", 12), true);
  assert.equal(isPreviewResource("pr1", 1), false, "a bare tag with no separator is not a resource");
  assert.equal(isPreviewResource("pr1-", 1), false, "an empty remainder is not a resource");
  assert.equal(isPreviewResource("group-turn-pr1", 1), true);
  assert.equal(isPreviewResource("group-turn-pr12", 1), false, "the suffix must end the name");
  assert.equal(isPreviewResource("group-turn-pr12", 12), true);
  assert.equal(isPreviewResource("xpr1-ctx", 1), false, "the prefix must start the name");
  assert.equal(isPreviewResource("pr1-ctx", 0), false, "0 is not a pull request number");
  assert.equal(isPreviewResource("pr1-ctx", "1 OR 1=1"), false, "a number is checked, never trusted");
  assert.equal(isPreviewResource("pr1-ctx", undefined), false);
  assert.equal(isPreviewResource(undefined, 1), false);
});

test("orphan workers are the preview scripts whose pull request is not open", () => {
  const scripts = [
    "context-mcp-pr1",
    "context-mcp-pr12",
    "context-agent-pr12",
    "context-router-pr99",
    "context-mcp-prod",
    "context-mcp-pr12-old",
    "context-mcp-pr0",
    "context-site-shots-staging",
    "other-pr5",
  ];
  assert.deepEqual(orphanNames(scripts, ["12"]), ["context-mcp-pr1", "context-router-pr99"]);
  assert.deepEqual(orphanNames(scripts, [1, 12, 99]), []);
  assert.deepEqual(orphanNames(scripts, []), ["context-mcp-pr1", "context-mcp-pr12", "context-agent-pr12", "context-router-pr99"]);
});

test("pull request numbers come from the complete name only", () => {
  assert.equal(workerPullRequest("context-agent-pr42"), "42");
  assert.equal(workerPullRequest("context-agent-pr042"), null, "leading zeros are not a preview");
  assert.equal(workerPullRequest("context-agent-pr42x"), null);
  assert.equal(resourcePullRequest("pr42-ctx-x"), "42");
  assert.equal(resourcePullRequest("ctx-pr42-x"), null);
});

test("storage is looked for in the gateway's account and the customer-data account, once each", () => {
  assert.deepEqual(storageAccounts({ CLOUDFLARE_ACCOUNT_ID: "a", MANAGED_R2_ACCOUNT_ID: "b" }), ["a", "b"]);
  assert.deepEqual(storageAccounts({ CLOUDFLARE_ACCOUNT_ID: "a", MANAGED_R2_ACCOUNT_ID: "a" }), ["a"]);
  assert.deepEqual(storageAccounts({ CLOUDFLARE_ACCOUNT_ID: "a" }), ["a"]);
});

test("deleting a preview removes its Workers in order, and tolerates one that is already gone", async () => {
  const calls = [];
  const logs = [];
  const runWrangler = (_env, worker, args) => {
    calls.push([worker, args[2]]);
    if (worker === "agent") {
      const error = new Error("wrangler failed");
      error.stderr = "Error: Worker not found (code 10007)";
      throw error;
    }
  };
  // Every Cloudflare call answers "nothing there", so only the Worker order is under test.
  const requests = [];
  const api = { request: async (method, path) => { requests.push(`${method} ${path}`); return null; } };
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" };
  await deletePreview(env, 7, { log: (line) => logs.push(line), runWrangler, api });
  assert.deepEqual(calls, [["router", "context-router-pr7"], ["agent", "context-agent-pr7"], ["mcp", "context-mcp-pr7"]]);
  assert.ok(logs.some((line) => line.includes("context-agent-pr7 was already gone")));
  assert.deepEqual(requests, ["GET /accounts/gateway/workflows", "GET /accounts/gateway/r2/buckets?per_page=1000", "GET /accounts/gateway/d1/database?per_page=1000", "GET /accounts/gateway/vectorize/v2/indexes"]);
});

test("a storage resource of another pull request is never deleted", async () => {
  const deleted = [];
  const api = {
    request: async (method, path) => {
      if (method === "DELETE") deleted.push(path);
      if (path.includes("r2/buckets")) return { buckets: [{ name: "pr1-ctx-a" }, { name: "pr12-ctx-b" }, { name: "pr1x-ctx" }] };
      if (path.includes("d1/database")) return { databases: [{ name: "pr12-search", uuid: "u12" }, { name: "pr1-search", uuid: "u1" }] };
      if (path.includes("vectorize")) return { indexes: [{ name: "pr1-vec" }, { name: "group-pr1" }] };
      return null;
    },
  };
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" };
  await deletePreview(env, 1, { log: () => {}, runWrangler: () => {}, api });
  assert.deepEqual(deleted, [
    "/accounts/gateway/r2/buckets/pr1-ctx-a",
    "/accounts/gateway/d1/database/u1",
    "/accounts/gateway/vectorize/v2/indexes/pr1-vec",
    "/accounts/gateway/vectorize/v2/indexes/group-pr1",
  ]);
});
