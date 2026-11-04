/**
 * The timed MCP entry point (`src/mcp/mcpEntryPoint.js`, `src/http/mcpRoute.js`):
 * every step of an MCP request is a named point, indexed by workspace, with its
 * control-plane routes and store calls timed beneath it, and never a path or a
 * word anyone wrote.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

import worker from "../src/index.js";
import { callOf, keyClass, mcpEntry } from "../src/mcp/mcpEntryPoint.js";
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
    { blobs: ["mcp", "tools/call:fetch", "session", "ok", "Claude", ""], doubles: [70, 3, 1], indexes: ["ws_1"] },
    { blobs: ["mcp", "tools/call:fetch", "open_store", "failed", "Claude", ""], doubles: [20, 73, 1], indexes: ["ws_1"] },
    { blobs: ["mcp", "tools/call:fetch", "to_response", "ok", "Claude", ""], doubles: [93, 0, 1], indexes: ["ws_1"] },
  ]);
  assert.doesNotMatch(JSON.stringify(MCP_ENTRY.points), /secret|token/);
});

test("one point per step and state for the whole request: repeated calls are summed and counted, to_response last", async () => {
  const time = clock();
  const MCP_ENTRY = dataset();
  const mcp = mcpEntry({ MCP_ENTRY }, { now: time.now });
  for (const ms of [5, 7, 9]) {
    await mcp.step("store:get", async () => {
      time.tick(ms);
    });
  }
  await assert.rejects(mcp.step("store:get", async () => {
    time.tick(2);
    throw new Error("missing");
  }));
  mcp.done(new Response("{}"));
  assert.deepEqual(MCP_ENTRY.points.map((p) => [p.blobs[2], p.blobs[3], ...p.doubles]), [
    ["store:get", "ok", 21, 0, 3],
    ["store:get", "failed", 2, 21, 1],
    ["to_response", "ok", 23, 0, 1],
  ]);
});

test("a store call is named by the kind of its key, never the key", () => {
  assert.equal(keyClass("1-projects/secret plan.md"), "note");
  assert.equal(keyClass("files/photo.png"), "file");
  assert.equal(keyClass(".context/audit/2026-11-03-x.json"), ".context/audit");
  assert.equal(keyClass(".context/collaboration/v1/state/a.json"), ".context/collaboration");
  assert.equal(keyClass(".context/Weird Name/x"), ".context/other");
  assert.equal(keyClass({ prefix: "1-projects/" }), "list");
  assert.equal(keyClass(undefined), "other");
});

test("a control-plane fetch is timed by its route, never its query or an id in it", async () => {
  const MCP_ENTRY = dataset();
  // A still clock: a slow runner's real milliseconds between steps would add an "uncovered" point this test is not about.
  const mcp = mcpEntry({ MCP_ENTRY }, { now: () => 1_000 });
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
  assert.deepEqual(mcp.points.map((p) => p.name), ["store:get:note", "store:list:list"]);
  assert.equal(store.name, "kept");
});

test("a workspace object call is timed by its op, on a copy of env, and still answers as before", async () => {
  const mcp = mcpEntry({});
  const asked = [];
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id, options) => ({ fetch: async (request) => (asked.push([id.name, options, new URL(request.url).pathname]), Response.json({ ok: true })) }),
  };
  const env = { WORKSPACE_STORE: namespace, OTHER: "kept" };
  const watched = mcp.watchObjects(env);
  assert.notEqual(watched, env, "a copy: env is shared by every request");
  assert.equal(env.WORKSPACE_STORE, namespace, "env itself is untouched");
  assert.equal(watched.OTHER, "kept");
  const stub = watched.WORKSPACE_STORE.get(watched.WORKSPACE_STORE.idFromName("workspace:w1"), { locationHint: "enam" });
  assert.deepEqual(await (await stub.fetch(new Request("https://object.test/ws.rows.lookup", { method: "POST", headers: { "x-tex-call": "secret%20plan.md" } }))).json(), { ok: true });
  await stub.fetch(new Request("https://object.test/get"));
  await stub.fetch(new Request("https://object.test/not%20an%20op"));
  assert.deepEqual(asked, [
    ["workspace:w1", { locationHint: "enam" }, "/ws.rows.lookup"],
    ["workspace:w1", { locationHint: "enam" }, "/get"],
    ["workspace:w1", { locationHint: "enam" }, "/not%20an%20op"],
  ]);
  assert.deepEqual(mcp.points.map((p) => [p.name, p.state]), [
    ["obj:ws.rows.lookup", "ok"],
    ["obj:get", "ok"],
    ["obj:unknown", "ok"],
  ]);
  assert.equal(mcp.watchObjects({}).WORKSPACE_STORE, undefined, "no binding, nothing added");
});

test("callOf names the call, the tool for a tool call, and nothing a caller wrote", () => {
  assert.equal(callOf({ method: "initialize" }), "initialize");
  assert.equal(callOf({ method: "tools/call", params: { name: "orient", arguments: { q: "secret" } } }), "tools/call:orient");
  assert.equal(callOf({ method: "tools/call", params: { name: "manage", arguments: { action: "archive", args: { path: "a.md" } } } }), "tools/call:manage:archive");
  assert.equal(callOf({ method: "tools/call", params: { name: "write", arguments: { action: "save" } } }), "tools/call:write:save");
  // An action no tool lists is never carried, so a caller cannot write into the timings.
  assert.equal(callOf({ method: "tools/call", params: { name: "manage", arguments: { action: "secret_words" } } }), "tools/call:manage");
  assert.equal(callOf({ method: "tools/call", params: { name: "manage", arguments: { action: "toString" } } }), "tools/call:manage");
  assert.equal(callOf({ method: "tools/call", params: { name: "constructor", arguments: { action: "save" } } }), "tools/call:constructor");
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

test("the data center a request ran in rides on every point, and only a data center's code is kept", () => {
  for (const [given, kept] of [["IAD", "IAD"], ["iad", ""], ["IADX", ""], ["<b>", ""], [undefined, ""], [42, ""]]) {
    const MCP_ENTRY = dataset();
    const mcp = mcpEntry({ MCP_ENTRY });
    mcp.colo = given;
    mcp.done(new Response("{}"));
    assert.deepEqual(MCP_ENTRY.points.map((p) => p.blobs[5]), [kept], String(given));
  }
});

const steps = (points) => points.map((p) => p.blobs[2]);

test("a tool call through the Worker: session, body, store, answer, and the calls beneath them, one workspace index", async () => {
  const { status, text, points } = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { id: "1-projects/a.md" } } });
  assert.equal(status, 200);
  assert.match(text, /the secret words/, "the call is answered as before");
  const names = steps(points);
  for (const name of ["session", "read_body", "open_store", "answer", "to_response", "cp:/gateway/session", "cp:/gateway/binding"]) {
    assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  }
  assert.ok(names.some((name) => name.startsWith("store:get:")), `a store read in ${names.join(", ")}`);
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
  // And again by where its binding came from, and why: here no workspace object, so the control plane.
  assert.ok(steps(points).includes("open_other_context:control_plane:no_object"), steps(points).join(", "));
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
  // On the real clock a slow runner can leave a millisecond between steps, which is written as its own "uncovered"
  // point (tested below with a fake clock); it is not one of the door's steps, so it is left out here.
  const doorPoints = MCP_ENTRY.points.filter((p) => p.blobs[2] !== "uncovered");
  assert.deepEqual(doorPoints.map((p) => [p.blobs[0], p.blobs[1], p.blobs[2], p.blobs[3], p.indexes[0]]), [
    ["door", "ws.rows.snapshot", "ticket", "ok", "w1"],
    ["door", "ws.rows.snapshot", "object", "ok", "w1"],
    ["door", "ws.rows.snapshot", "to_response", "ok", "w1"],
  ]);
  assert.doesNotMatch(JSON.stringify(MCP_ENTRY.points), /secret|plan\.md/);
});

test("the time no step covered is its own point, so a request's steps add up to its whole", async () => {
  const time = clock();
  const MCP_ENTRY = dataset();
  const mcp = mcpEntry({ MCP_ENTRY }, { now: time.now });
  await mcp.step("session", async () => time.tick(30));
  time.tick(40); // between steps: nothing timed
  await mcp.step("answer", async () => {
    // A step inside another covers nothing new.
    await mcp.step("obj:ws.write.move", async () => time.tick(20));
    time.tick(10);
  });
  time.tick(5);
  mcp.done(new Response("{}"));
  const byName = Object.fromEntries(MCP_ENTRY.points.map((p) => [p.blobs[2], p.doubles[0]]));
  assert.equal(byName.to_response, 105);
  assert.equal(byName.uncovered, 45);
});

test("a request whose steps cover it all writes no uncovered point", async () => {
  const time = clock();
  const MCP_ENTRY = dataset();
  const mcp = mcpEntry({ MCP_ENTRY }, { now: time.now });
  // Two steps at once, overlapping: their union is the whole request.
  await Promise.all([mcp.step("a", async () => time.tick(10)), mcp.step("b", async () => {})]);
  mcp.done(new Response("{}"));
  assert.equal(MCP_ENTRY.points.some((p) => p.blobs[2] === "uncovered"), false);
});
