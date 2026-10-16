/**
 * Tool news in `orient`: a client that cached our tool list is told what
 * changed since it last fetched it, and a change to the tools that nobody
 * wrote down fails here.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { TOOL_NEWS, TOOL_SHAPE, toolNewsSection, toolShape } from "../src/tools/news.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const DAY = 24 * 60 * 60 * 1000;

test("every change to a tool's name or arguments has a news entry", () => {
  const shape = toolShape(toolDefinitions());
  assert.equal(
    shape,
    TOOL_SHAPE,
    `the advertised tools changed: add an entry to TOOL_NEWS in src/tools/news.js saying what an agent can now pass, then set TOOL_SHAPE to "${shape}"`
  );
});

test("the fingerprint moves when an argument is added, and not when a description changes", () => {
  const tools = [{ name: "write_note", description: "a", inputSchema: { properties: { path: {} } } }];
  const base = toolShape(tools);
  assert.notEqual(toolShape([{ ...tools[0], inputSchema: { properties: { path: {}, mail: {} } } }]), base);
  assert.equal(toolShape([{ ...tools[0], description: "reworded" }]), base);
});

test("news is newest first and dated as UTC days", () => {
  for (const entry of TOOL_NEWS) assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  const dates = TOOL_NEWS.map((entry) => entry.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

const NEWS = [
  { date: "2026-10-12", text: "newest." },
  { date: "2026-10-03", text: "middle.", newTool: true },
  { date: "2026-09-26", text: "oldest." },
];

test("only what is newer than the listing is named, same day included", () => {
  const section = toolNewsSection(Date.parse("2026-10-03T15:00:00Z"), NEWS);
  assert.ok(section.includes("newest."));
  assert.ok(section.includes("middle."), "the same UTC day cannot say which came first");
  assert.ok(!section.includes("oldest."));
  assert.ok(section.includes("(2026-10-03)"));
  assert.match(section, /new tool: middle\. .*reconnected/);
});

test("nothing newer, or no time at all, is no section", () => {
  assert.equal(toolNewsSection(Date.parse("2026-10-13T00:00:00Z"), NEWS), null);
  assert.equal(toolNewsSection(null, NEWS), null);
  assert.equal(toolNewsSection(undefined, NEWS), null);
});

test("a very stale client gets the newest eight and a count of the rest", () => {
  const many = Array.from({ length: 11 }, (_, n) => ({
    date: new Date(Date.parse("2026-10-20T00:00:00Z") - n * DAY).toISOString().slice(0, 10),
    text: `change ${n}.`,
  }));
  const section = toolNewsSection(0, many);
  assert.ok(section.includes("change 7."));
  assert.ok(!section.includes("change 8."));
  assert.ok(section.includes("and 3 older changes"));
});

/* -------------------------------------------------------------------------- */
/* Through the worker                                                         */
/* -------------------------------------------------------------------------- */

const S3_ENDPOINT = "https://s3.example-tool-news.test";
const TOKEN_STALE = `cat_news_stale__${"0".repeat(24)}`;
const TOKEN_UNKNOWN = `cat_news_unknown${"0".repeat(24)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
const OLDEST = TOOL_NEWS[TOOL_NEWS.length - 1];

let controlPlane;
let restoreS3;
let restoreControlPlane;
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_news", "news", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tool-news",
    accessKeyId: "AKIAEXAMPLEEXAMPLENW",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLENW",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  s3.bucketFor("tool-news").set("index.md", { body: "# Front page", etag: "i0" });
  // Connected before the oldest entry, and has not fetched the list since.
  await controlPlane.addGrant({
    workspaceId: "ws_news",
    accessToken: TOKEN_STALE,
    toolsListedAt: Date.parse(`${OLDEST.date}T00:00:00Z`) - 30 * DAY,
  });
  // A control plane that does not say when the list was fetched.
  await controlPlane.addGrant({ workspaceId: "ws_news", accessToken: TOKEN_UNKNOWN, userId: "user_unknown" });
});

async function rpc(token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body;
}

const orient = async (token) =>
  (await rpc(token, "tools/call", { name: "orient", arguments: {} }))?.result?.content?.[0]?.text || "";

test("a stale client is told what changed, ahead of the front page", async () => {
  const text = await orient(TOKEN_STALE);
  const at = text.indexOf("## New in Context's tools");
  assert.ok(at > 0, "the section is there");
  assert.ok(at < text.indexOf("## Workspaces"));
  assert.ok(text.includes(TOOL_NEWS[0].text), "the newest change is named");
});

test("after the client fetches tools/list, the old news is gone", async () => {
  const listed = await rpc(TOKEN_STALE, "tools/list", {});
  assert.ok(Array.isArray(listed?.result?.tools));
  const text = await orient(TOKEN_STALE);
  const older = TOOL_NEWS.find((entry) => Date.parse(`${entry.date}T00:00:00Z`) < Date.now() - DAY);
  assert.ok(!text.includes(older.text), "news from before the listing is not repeated");
});

test("no listing time means no section, never a guess", async () => {
  const text = await orient(TOKEN_UNKNOWN);
  assert.ok(text.includes("# Context"));
  assert.ok(!text.includes("## New in Context's tools"));
});
