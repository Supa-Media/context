/**
 * The timed MCP entry point (`src/mcp/mcpEntryPoint.js`, `src/http/mcpRoute.js`):
 * every step of an MCP request is a named point, indexed by workspace, with its
 * control-plane routes and store calls timed beneath it, and never a path or a
 * word anyone wrote.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

import worker from "../src/index.js";
import { callOf, mcpEntry } from "../src/mcp/mcpEntryPoint.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

function dataset() {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
}

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, tick: (ms) => (at += ms) };
}

test("steps are held until the response, then written once, indexed by the workspace, never their values", async () => {
  const MCP_ENTRY = dataset();
  const time = clock();
  const mcp = mcpEntry({ MCP_ENTRY }, { now: time.now });
  time.tick(3);
  await mcp.step("session", async () => {
    time.tick(70);
    return { secret: "a token" };
  });
  mcp.workspace = "ws_1";
  mcp.client = "Claude";
  mcp.call = "tools/call:fetch";
  await assert.rejects(mcp.step("open_store", async () => {
    time.tick(20);
    throw new Error("boom");
  }));
  assert.equal(MCP_ENTRY.points.length, 0, "nothing is written before the response");
  const response = new Response("{}");
  assert.equal(mcp.done(response), response);
  mcp.done(response);
  assert.deepEqual(MCP_ENTRY.points, [
    { blobs: ["mcp", "tools/call:fetch", "session", "ok", "Claude"], doubles: [70, 3], indexes: ["ws_1"] },
    { blobs: ["mcp", "tools/call:fetch", "open_store", "failed", "Claude"], doubles: [20, 73], indexes: ["ws_1"] },
    { blobs: ["mcp", "tools/call:fetch", "to_response", "ok", "Claude"], doubles: [93, 0], indexes: ["ws_1"] },
  ]);
  assert.doesNotMatch(JSON.stringify(MCP_ENTRY.points), /secret|token/);
});

test("a control-plane fetch is timed by its route, never its query or an id in it", async () => {
  const MCP_ENTRY = dataset();
  const mcp = mcpEntry({ MCP_ENTRY });
  const seen = [];
  const fetchImpl = mcp.fetchFor("cp", async (input) => (seen.push(input), new Response("ok")));
  await fetchImpl("https://cp.example.test/gateway/binding?token=abc");
  await fetchImpl(new Request("https://cp.example.test/gateway/tree/0123456789abcdef0123/rows"));
  mcp.done(new Response(null, { status: 502 }));
  assert.equal(seen.length, 2, "the real fetch still runs");
  assert.deepEqual(MCP_ENTRY.points.map((p) => p.blobs.slice(2, 4)), [
    ["cp:/gateway/binding", "ok"],
    ["cp:/gateway/tree/#/rows", "ok"],
    ["to_response", "failed"],
  ]);
});

test("a watched store's calls are timed by operation and still answer as before", async () => {
  const mcp = mcpEntry({});
  const store = { get: async (key) => `body of ${key}`, list: async () => ({ objects: [] }), name: "kept" };
  assert.equal(mcp.watch(store), store);
  assert.equal(await store.get("a.md"), "body of a.md");
  await store.list({ prefix: "" });
  assert.deepEqual(mcp.points.map((p) => p.name), ["store:get", "store:list"]);
  assert.equal(store.name, "kept");
});

test("callOf names the call, the tool for a tool call, and nothing a caller wrote", () => {
  assert.equal(callOf({ method: "initialize" }), "initialize");
  assert.equal(callOf({ method: "tools/call", params: { name: "orient", arguments: { q: "secret" } } }), "tools/call:orient");
  assert.equal(callOf([{ method: "tools/list" }]), "tools/list");
  assert.equal(callOf([{ method: "a" }, { method: "b" }]), "batch");
  assert.equal(callOf(undefined), "unparsed");
  assert.equal(callOf({ method: "tools/call", params: { name: "<script>" } }), "tools/call:script");
});

/* ------------------------------ through the Worker ------------------------------ */

const S3 = "https://s3.example.test";
const MCP_URL = "https://mcp.context.test/mcp";
const TOKEN = `cat_mcp_entry_${"0".repeat(24)}`;
const MANIFEST = "---\nrole: privacy-manifest\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";
const binding = (bucket, key) => ({ provider: "s3", endpoint: S3, region: "auto", bucket, accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`, secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`, forcePathStyle: true, capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" }, status: "active" });

before(async () => {
  const s3 = createS3Backend(S3);
  s3.install();
  const cp = createControlPlaneStub();
  cp.install();
  cp.serveTreesFrom(undefined, { s3 });
  cp.addWorkspace("ws_entry", "entry-mine", binding("b-entry", "01"));
  cp.addWorkspace("ws_other", "entry-other", binding("b-other", "02"), { kind: "shared" });
  for (const bucket of ["b-entry", "b-other"]) {
    s3.bucketFor(bucket).set("privacy.md", { body: MANIFEST, etag: "p0" });
    s3.bucketFor(bucket).set("1-projects/a.md", { body: "# a\n\nthe secret words", etag: "a0" });
  }
  await cp.addGrant({ workspaceId: "ws_entry", role: "owner", userId: "user_entry", accessToken: TOKEN, scopes: ["context:read", "context:write"], clientId: "mcp_client_entry", alsoMemberOf: [{ workspaceId: "ws_other", role: "member" }] });
});

async function post(payload, token = TOKEN) {
  const MCP_ENTRY = dataset();
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, MCP_ENTRY };
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(MCP_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text, points: MCP_ENTRY.points };
}

const steps = (points) => points.map((p) => p.blobs[2]);

test("a tool call through the Worker: session, body, store, answer, and the calls beneath them, one workspace index", async () => {
  const { status, text, points } = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { id: "1-projects/a.md" } } });
  assert.equal(status, 200);
  assert.match(text, /the secret words/, "the call is answered as before");
  const names = steps(points);
  for (const name of ["session", "read_body", "open_store", "answer", "to_response", "cp:/gateway/session", "cp:/gateway/binding", "store:get"]) {
    assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  }
  assert.equal(names.at(-1), "to_response");
  for (const point of points) {
    assert.equal(point.blobs[1], "tools/call:fetch");
    assert.deepEqual(point.indexes, ["ws_entry"]);
  }
  assert.doesNotMatch(JSON.stringify(points), /secret words|1-projects|a\.md|cat_mcp/);
});

test("a call naming another workspace times that open too", async () => {
  const { status, points } = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fetch", arguments: { id: "1-projects/a.md", context: "@entry-other" } } });
  assert.equal(status, 200);
  assert.ok(steps(points).includes("open_other_context"), steps(points).join(", "));
  assert.doesNotMatch(JSON.stringify(points), /entry-other|ws_other/);
});

test("a refused token is timed too, and its answer is the refusal it always was", async () => {
  const { status, points } = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, `cat_wrong_${"1".repeat(28)}`);
  assert.equal(status, 401);
  assert.deepEqual(steps(points).filter((n) => !n.startsWith("cp:")), ["session", "to_response"]);
  assert.ok(!steps(points).includes("open_store"), "no store opens for a refused token");
});

test("a notification is answered 202 and still timed by its method", async () => {
  const { status, points } = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(status, 202);
  assert.equal(points.at(-1).blobs[1], "notifications/initialized");
});

test("each call through the workspace object's door is timed under \"door\" by its op and workspace", async () => {
  const { handleWorkspaceStoreDoor } = await import("../src/workspaceStore/door.js");
  const MCP_ENTRY = dataset();
  const env = {
    GATEWAY_SECRET: "s".repeat(32),
    MCP_ENTRY,
    WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => Response.json({}) }) },
  };
  const request = new Request("https://gateway/internal/workspace-store", {
    method: "POST",
    headers: {
      authorization: `Bearer ${"s".repeat(32)}`,
      "x-workspace-ticket": "ticket",
      "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.rows.snapshot" })),
    },
    body: JSON.stringify({ rows: [{ path: "secret/plan.md" }] }),
  });
  const response = await handleWorkspaceStoreDoor(request, env, { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: "w1", owners: [] }) } });
  assert.equal(response.status, 200);
  assert.deepEqual(MCP_ENTRY.points.map((p) => [p.blobs[0], p.blobs[1], p.blobs[2], p.blobs[3], p.indexes[0]]), [
    ["door", "ws.rows.snapshot", "ticket", "ok", "w1"],
    ["door", "ws.rows.snapshot", "object", "ok", "w1"],
    ["door", "ws.rows.snapshot", "to_response", "ok", "w1"],
  ]);
  assert.doesNotMatch(JSON.stringify(MCP_ENTRY.points), /secret|plan\.md/);
});
