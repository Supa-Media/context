import test from "node:test";
import assert from "node:assert/strict";

import {
  deletePreview,
  isPreviewResource,
  openPullRequestNumbers,
  orphanNames,
  resourcePullRequest,
  storageAccounts,
  sweep,
  workerPullRequest,
  workflowPullRequest,
} from "./preview-cleanup.mjs";

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
  assert.deepEqual(calls, [
    ["router", "context-router-pr7"],
    ["router", "context-router-pr7-preview"],
    ["agent", "context-agent-pr7"],
    ["agent", "context-agent-pr7-preview"],
    ["mcp", "context-mcp-pr7"],
    ["mcp", "context-mcp-pr7-preview"],
  ]);
  assert.ok(logs.some((line) => line.includes("context-agent-pr7 was already gone")));
  assert.deepEqual(requests, ["GET /accounts/gateway/workflows?per_page=100&page=1", "GET /accounts/gateway/r2/buckets?per_page=1000", "GET /accounts/gateway/d1/database?per_page=1000", "GET /accounts/gateway/vectorize/v2/indexes"]);
});

test("a stray -preview Worker from the secret bug is found by its number and deleted with its preview", async () => {
  assert.equal(workerPullRequest("context-mcp-pr3747-preview"), "3747");
  assert.equal(workerPullRequest("context-mcp-pr3747-previewx"), null);
  assert.equal(workerPullRequest("context-mcp-pr0-preview"), null);
  assert.deepEqual(orphanNames(["context-mcp-pr3747-preview", "context-mcp-pr3747"], ["3747"]), []);
  const calls = [];
  const api = { request: async () => null };
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" };
  await deletePreview(env, 3747, {
    log: () => {},
    runWrangler: (_env, worker, args) => calls.push([worker, args]),
    api,
  });
  assert.deepEqual(calls.find(([, args]) => args[2] === "context-mcp-pr3747-preview"), ["mcp", ["delete", "--name", "context-mcp-pr3747-preview", "--force"]]);
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

/** A fake Cloudflare API: `routes` maps a path prefix to the page result for that request. */
function fakeCloudflare(routes) {
  const deleted = [];
  const requested = [];
  const api = {
    request: async (method, path) => {
      requested.push(`${method} ${path}`);
      if (method === "DELETE") {
        deleted.push(path);
        return null;
      }
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      for (const [prefix, pages] of Object.entries(routes)) {
        if (path.startsWith(prefix)) return pages[page - 1] ?? null;
      }
      return null;
    },
  };
  return { api, deleted, requested };
}

const GONE = () => {
  const error = new Error("wrangler failed");
  error.stderr = "Error: Worker not found (code 10007)";
  throw error;
};

test("a Workflow left behind after its Worker is gone is swept, and the shared Workflows are never touched", async () => {
  const { api, deleted } = fakeCloudflare({
    "/accounts/gateway/workers/scripts": [[]],
    "/accounts/gateway/workflows": [[{ name: "group-turn-pr7" }, { name: "group-turn" }, { name: "group-turn-staging" }, { name: "job-run-staging" }, { name: "job-run" }]],
  });
  const logs = [];
  await sweep({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" }, {
    api,
    log: (line) => logs.push(line),
    runWrangler: GONE,
    openPullRequests: async () => [],
  });
  assert.deepEqual(deleted, ["/accounts/gateway/workflows/group-turn-pr7"]);
  assert.ok(logs.some((line) => line.includes("pull request #7 is not open")));
});

test("workflow names match only the exact preview pattern", () => {
  assert.equal(workflowPullRequest("group-turn-pr7"), "7");
  assert.equal(workflowPullRequest("job-run-pr1234567"), "1234567");
  for (const name of ["group-turn", "group-turn-staging", "job-run", "job-run-staging", "group-turn-pr0", "group-turn-pr12345678", "group-turn-pr07", "x-group-turn-pr7"]) {
    assert.equal(workflowPullRequest(name), null, name);
  }
});

test("a PR on page 2 of the open pull requests keeps its preview", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i }));
  const page2 = [{ number: 7 }];
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
    return new Response(JSON.stringify(page === 1 ? page1 : page === 2 ? page2 : []), { status: 200 });
  };
  const numbers = await openPullRequestNumbers("t", "owner/repo", { fetchImpl });
  assert.equal(numbers.length, 101);
  assert.ok(numbers.includes("7"));
  assert.equal(seenUrls.length, 2, "a short page ends the listing");

  const { api, deleted } = fakeCloudflare({
    "/accounts/gateway/workers/scripts": [[{ id: "context-mcp-pr7" }]],
    "/accounts/gateway/workflows": [[{ name: "group-turn-pr7" }]],
  });
  await sweep({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" }, {
    api,
    log: () => {},
    runWrangler: () => {},
    openPullRequests: async () => numbers,
  });
  assert.deepEqual(deleted, [], "PR 7 is open on page 2, so nothing of it is deleted");
});

test("a failing or truncated pull request list throws and deletes nothing", async () => {
  const { api, deleted } = fakeCloudflare({
    "/accounts/gateway/workers/scripts": [[{ id: "context-mcp-pr7" }]],
    "/accounts/gateway/workflows": [[{ name: "group-turn-pr7" }]],
  });
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" };
  await assert.rejects(
    sweep(env, { api, log: () => {}, runWrangler: () => {}, openPullRequests: async () => { throw new Error("Could not list open pull requests (HTTP 500, page 2)."); } }),
    /Could not list/,
  );
  assert.deepEqual(deleted, []);

  const fullPage = Array.from({ length: 100 }, (_, i) => ({ number: 2000 + i }));
  const failingSecondPage = async (url) => {
    const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
    if (page === 1) return new Response(JSON.stringify(fullPage), { status: 200 });
    return new Response("{}", { status: 500 });
  };
  await assert.rejects(openPullRequestNumbers("t", "owner/repo", { fetchImpl: failingSecondPage }), /HTTP 500, page 2/);
  const notAList = async () => new Response("{}", { status: 200 });
  await assert.rejects(openPullRequestNumbers("t", "owner/repo", { fetchImpl: notAList }), /not a list/);
  await assert.rejects(
    openPullRequestNumbers("t", "owner/repo", { fetchImpl: async () => { throw new Error("network down"); } }),
    /network down/,
  );
});
