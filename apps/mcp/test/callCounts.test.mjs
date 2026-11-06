// Every request the gateway answers and every call a workspace object answers is one Analytics Engine point, so a busy
// minute names who made it (2026-11-06: one workspace object took 18,624 requests in a minute, from nobody knew whom).
// Names only: a route this file does not know, a slug, a path or an id never reaches the dataset.
// Sabotage: drop `countInbound` from `src/index.js`, or `countObjectCall` from `src/workspaceStore.js`'s `fetch` → the
// worker and object tests here fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { WorkspaceStore } from "../src/workspaceStore.js";
import { clientKind, countInbound, countObjectCall, objectCaller, routeName } from "../src/observability/callCounts.js";
import { durableSqlite } from "./durableSqlite.mjs";

function dataset() {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
}

test("a route is named from a fixed list, never by what the path holds", () => {
  assert.equal(routeName("/agent/machine/run"), "agent/machine/run");
  assert.equal(routeName("/agent/machine/deliver"), "agent/machine");
  assert.equal(routeName("/agent"), "agent");
  assert.equal(routeName("/agent/inbox"), "agent");
  assert.equal(routeName("/agent-activity"), "agent-activity");
  assert.equal(routeName("/internal/workspace-store"), "internal/workspace-store");
  assert.equal(routeName("/mcp"), "mcp");
  assert.equal(routeName("/mcpx"), "other");
  assert.equal(routeName("/presence/tree"), "presence/tree");
  assert.equal(routeName("/presence"), "presence");
  assert.equal(routeName("/@seyi/projects/secret plan.md"), "page");
  assert.equal(routeName("/t/abc123token/mcp"), "other");
  assert.equal(routeName(undefined), "other");
});

test("a client's kind is coarse", () => {
  assert.equal(clientKind("Mozilla/5.0 (Macintosh)"), "browser");
  assert.equal(clientKind("node"), "node");
  assert.equal(clientKind("claude-code/2.1 (cli)"), "claude-code");
  assert.equal(clientKind("python-httpx/0.27"), "python");
  assert.equal(clientKind(""), "none");
  assert.equal(clientKind(null), "none");
  assert.equal(clientKind("SomeBot person@example.com"), "other");
});

test("the gateway's point names the route, the client kind and the status class, and nothing from the URL", () => {
  const CALL_COUNTS = dataset();
  const request = new Request("https://mcp.example.test/@seyi/private/plan.md?token=abc", { headers: { "user-agent": "Mozilla/5.0" } });
  countInbound({ CALL_COUNTS }, request, 404, 12);
  assert.deepEqual(CALL_COUNTS.points, [{ indexes: ["page"], blobs: ["in", "page", "browser", "4xx"], doubles: [1, 12] }]);
  assert.doesNotMatch(JSON.stringify(CALL_COUNTS.points), /seyi|plan|token|abc/);
  countInbound({}, request, 200, 1);
  countInbound({ CALL_COUNTS: { writeDataPoint: () => { throw new Error("full"); } } }, request, 200, 1);
});

test("an object's caller is the door for Convex, an upgrade for a socket, Tex for a person's Tex, else the gateway", () => {
  assert.equal(objectCaller(new Request("https://workspace-store.internal/door", { method: "POST" })), "convex");
  assert.equal(objectCaller(new Request("https://workspace-store.internal/tree", { headers: { Upgrade: "websocket" } })), "socket");
  assert.equal(objectCaller(new Request("https://tex-store.internal/ws.rows.lookup", { method: "POST" })), "gateway");
  assert.equal(objectCaller(new Request("https://tex-store.internal/get", { method: "POST" }), { tex: true }), "tex");
});

test("an object's point keeps a plain op name only", () => {
  const CALL_COUNTS = dataset();
  countObjectCall({ CALL_COUNTS }, "objid", "ws.rows.lookup", "gateway");
  countObjectCall({ CALL_COUNTS }, "objid", "projects/secret plan.md", "gateway");
  assert.deepEqual(CALL_COUNTS.points.map((p) => p.blobs), [["object", "ws.rows.lookup", "gateway"], ["object", "other", "gateway"]]);
  assert.deepEqual(CALL_COUNTS.points.map((p) => p.indexes), [["objid"], ["objid"]]);
});

test("the gateway counts a request it answered", async () => {
  const CALL_COUNTS = dataset();
  const env = { CALL_COUNTS, CONTROL_PLANE_URL: "https://cp.example.test", GATEWAY_SECRET: "test-gateway-secret" };
  const response = await worker.fetch(new Request("https://mcp.example.test/.well-known/nothing-here"), env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(CALL_COUNTS.points.length, 1, JSON.stringify(CALL_COUNTS.points));
  const [point] = CALL_COUNTS.points;
  assert.equal(point.blobs[0], "in");
  assert.equal(point.blobs[1], "well-known");
  assert.equal(point.blobs[3], `${Math.floor(response.status / 100)}xx`);
});

test("a workspace object counts each call it answers under its own id", async () => {
  const CALL_COUNTS = dataset();
  const { sql, transact } = durableSqlite();
  const state = {
    id: { toString: () => "object-id-1" },
    storage: { sql, transactionSync: transact, getAlarm: async () => null, setAlarm: async () => {} },
    getWebSockets: () => [],
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
  };
  const object = new WorkspaceStore(state, { CALL_COUNTS });
  await object.fetch(new Request("https://tex-store.internal/ws.open", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.open" })) }, body: JSON.stringify({ userId: "user_a", workspaceId: "ws" }) }));
  assert.deepEqual(CALL_COUNTS.points, [{ indexes: ["object-id-1"], blobs: ["object", "ws.open", "gateway"], doubles: [1] }]);
});

// A busy workspace object is said as busy to an AI client and to a route's caller, never answered from the control
// plane (the owner, 2026-11-06). Sabotage: drop the `WorkspaceBusy` catch in `tools/dispatch.js` → the first test throws.
test("a tool call on a busy workspace object says busy and to try again", async () => {
  const { callTool } = await import("../src/tools/dispatch.js");
  const { WorkspaceBusy } = await import("../src/store/objectLookup.js");
  const store = { get: async () => { throw new WorkspaceBusy("lookup failed"); }, list: async () => ({ objects: [] }) };
  const answer = await callTool("read_note", { path: "plans/a.md" }, store, "private");
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /busy right now; try again in a few seconds/);
  assert.doesNotMatch(answer.content[0].text, /lookup failed/, "the reason stays in the gateway's logs");
});

test("the door's point names the op and the control plane's own label, and nothing else", async () => {
  const { countDoorCall } = await import("../src/observability/callCounts.js");
  const CALL_COUNTS = dataset();
  countDoorCall({ CALL_COUNTS }, "ws_1", "get", "file:maintainIndex");
  countDoorCall({ CALL_COUNTS }, "ws_1", "get", "Robert'); DROP");
  countDoorCall({ CALL_COUNTS }, "ws_1", "get", null);
  assert.deepEqual(CALL_COUNTS.points.map((p) => p.blobs), [["door", "get", "file:maintainIndex"], ["door", "get", "unlabelled"], ["door", "get", "unlabelled"]]);
});

// Sabotage: drop `countDoorCall` from `src/workspaceStore/door.js` → this test fails.
test("a control-plane call through the door is counted with its caller's label", async () => {
  const { handleWorkspaceStoreDoor } = await import("../src/workspaceStore/door.js");
  const CALL_COUNTS = dataset();
  const env = { GATEWAY_SECRET: "s".repeat(32), CALL_COUNTS, WORKSPACE_STORE: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => Response.json({}) }) } };
  const request = new Request("https://gateway/internal/workspace-store", {
    method: "POST",
    headers: { authorization: `Bearer ${"s".repeat(32)}`, "x-workspace-ticket": "ticket", "x-door-caller": "file:maintainIndex", "x-tex-call": encodeURIComponent(JSON.stringify({ op: "get" })) },
    body: "",
  });
  const response = await handleWorkspaceStoreDoor(request, env, { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: "w1", owners: [] }) } });
  assert.equal(response.status, 200);
  assert.deepEqual(CALL_COUNTS.points, [{ indexes: ["w1"], blobs: ["door", "get", "file:maintainIndex"], doubles: [1] }]);
});
