import test from "node:test";
import assert from "node:assert/strict";

import { deletePreview, sweep } from "./cleanup.mjs";
import { deleteConvexPreview, emptyAndDeleteBucket, findConvexPreview, previewKeyProject, previewTokenOf, revokePreviewTokens } from "./teardown.mjs";

/** A fake R2 bucket holding `count` objects behind the REST API, deleted only once empty. */
function fakeBucket(count, { pageSize = 1000 } = {}) {
  const keys = new Set(Array.from({ length: count }, (_, i) => `notes/n${i}.md`));
  let deleted = false;
  const calls = [];
  const api = {
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (method === "GET" && path.includes("/objects")) return deleted ? null : [...keys].slice(0, pageSize).map((key) => ({ key }));
      if (method === "DELETE" && path.includes("/objects/")) {
        keys.delete(decodeURIComponent(path.split("/objects/")[1]));
        return null;
      }
      if (method === "DELETE") {
        if (keys.size > 0) throw new Error("The bucket you tried to delete is not empty");
        deleted = true;
        return null;
      }
      return null;
    },
  };
  return { api, calls, keys, isDeleted: () => deleted };
}

test("a bucket holding notes is emptied page by page, then deleted", async () => {
  const bucket = fakeBucket(2500);
  const logs = [];
  const result = await emptyAndDeleteBucket(bucket.api, "acct", "pr7-ctx-abc", { log: (line) => logs.push(line) });
  assert.equal(bucket.keys.size, 0);
  assert.equal(bucket.isDeleted(), true);
  assert.equal(result.deleted, 2500);
  assert.ok(bucket.calls.includes("DELETE /accounts/acct/r2/buckets/pr7-ctx-abc/objects/notes/n0.md"), "a key's slashes stay literal");
  assert.ok(logs.some((line) => line.includes("2500 object(s) removed first")));
});

test("the cleanup empties a preview's bucket instead of leaving it behind (the old bare DELETE was refused)", async () => {
  const bucket = fakeBucket(3);
  const api = {
    request: async (method, path) => {
      if (method === "GET" && path === "/accounts/gateway/r2/buckets?per_page=1000") return bucket.isDeleted() ? { buckets: [] } : { buckets: [{ name: "pr7-ctx-abc" }] };
      if (path.startsWith("/accounts/gateway/r2/buckets/")) return bucket.api.request(method, path);
      return null;
    },
  };
  const left = await deletePreview({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" }, 7, { log: () => {}, runWrangler: () => {}, api });
  assert.equal(bucket.isDeleted(), true);
  assert.deepEqual(left, []);
});

test("only a scoped token named for one of this pull request's buckets is revoked", async () => {
  assert.deepEqual(previewTokenOf("Context — pr7-ctx-abc123"), { bucket: "pr7-ctx-abc123", pr: "7" });
  for (const name of ["Context — ctx-abc123", "Context — staging-ctx-abc", "Context — pr07-ctx-a", "Context — pr7-ctx-", "Context — pr7-ctx-a b", "Deploy token", "Context — pr7-ctx-abc ", "x Context — pr7-ctx-abc", undefined]) {
    assert.equal(previewTokenOf(name), null, String(name));
  }
  const tokens = [
    { id: "t1", name: "Context — pr7-ctx-aaa" },
    { id: "t2", name: "Context — pr77-ctx-bbb" },
    { id: "t3", name: "Context — ctx-ccc" },
    { id: "t4", name: "Preview deploy" },
    { id: "t5", name: "Context — pr7-ctx-ddd" },
  ];
  const deleted = [];
  const api = { request: async (method, path) => (method === "DELETE" ? (deleted.push(path), null) : tokens) };
  const revoked = await revokePreviewTokens(api, ["acct"], 7, { log: () => {} });
  assert.equal(revoked, 2);
  assert.deepEqual(deleted, ["/accounts/acct/tokens/t1", "/accounts/acct/tokens/t5"]);
});

test("a token left after its bucket is gone makes the sweep clean that pull request", async () => {
  const deleted = [];
  const api = {
    request: async (method, path) => {
      if (method === "DELETE") { deleted.push(path); return null; }
      if (path.startsWith("/accounts/gateway/tokens")) return deleted.length ? [] : [{ id: "tok", name: "Context — pr9-ctx-zzz" }];
      return null;
    },
  };
  const { closed, leftovers } = await sweep({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" }, { api, log: () => {}, runWrangler: () => {}, openPullRequests: async () => [] });
  assert.deepEqual(closed, ["9"]);
  assert.deepEqual(deleted, ["/accounts/gateway/tokens/tok"]);
  assert.deepEqual(leftovers, []);
});

test("a leftover is reported, so the run fails instead of claiming the preview is gone", async () => {
  const api = {
    request: async (method, path) => {
      if (path.startsWith("/accounts/gateway/workers/durable_objects/namespaces")) return [{ script: "context-mcp-pr7", class: "WorkspaceStore" }, { script: "context-mcp-pr77", class: "WorkspaceStore" }];
      return null;
    },
  };
  const logs = [];
  const left = await deletePreview({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "gateway" }, 7, { log: (line) => logs.push(line), runWrangler: () => {}, api });
  assert.deepEqual(left, ["Durable Object namespace context-mcp-pr7.WorkspaceStore"]);
  assert.ok(logs.some((line) => line.startsWith("::error::pull request #7 left Durable Object namespace")));
});

const KEY = "preview:supa-team:context-app|secretpart";

test("the Convex preview is found by its pr<N> name with the preview key and deleted; the admin key is never logged", async () => {
  assert.deepEqual(previewKeyProject(KEY), { teamSlug: "supa-team", projectSlug: "context-app" });
  assert.equal(previewKeyProject("prod:abc|x"), null);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    if (url.endsWith("/api/deployment/authorize_preview")) return Response.json({ deploymentName: "happy-otter-123", adminKey: "ADMIN-SECRET"});
    return new Response("{}", { status: 200 });
  };
  const logs = [];
  assert.equal(await deleteConvexPreview(KEY, 7, { fetchImpl, log: (line) => logs.push(line) }), "deleted");
  assert.deepEqual(seen[0][1], { previewName: "pr7", projectSelection: { kind: "teamAndProjectSlugs", teamSlug: "supa-team", projectSlug: "context-app" } });
  assert.equal(seen[1][0], "https://api.convex.dev/v1/deployments/happy-otter-123/delete");
  assert.ok(!logs.join("\n").includes("ADMIN-SECRET"));
});

test("a missing Convex preview is already gone, and a refusal is an error that names only the status", async () => {
  const missing = async () => Response.json({ code: "PreviewDeploymentNotFound", message: "no" }, { status: 400 });
  assert.equal(await findConvexPreview(KEY, "pr7", { fetchImpl: missing }), null);
  const refused = async (url) => (url.endsWith("authorize_preview") ? Response.json({ deploymentName: "happy-otter-123", adminKey: "ADMIN-SECRET" }) : new Response("secret body", { status: 403 }));
  await assert.rejects(deleteConvexPreview(KEY, 7, { fetchImpl: refused, log: () => {} }), (error) => error.message.includes("HTTP 403") && !error.message.includes("secret body"));
  await assert.rejects(findConvexPreview("prod:x|y", "pr7"), /not a preview deploy key/);
});
