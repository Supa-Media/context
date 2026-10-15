/**
 * The live tool list in `orient`: every tool this connection may call and its
 * arguments, rendered from the definitions `tools/list` serves, shown in full
 * when the client's copy is behind or the agent asks, and as one line
 * otherwise.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { TOOL_NEWS } from "../src/tools/news.js";
import { liveToolListSection, purposeOf, toolLine, typeOf } from "../src/tools/liveList.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const DAY = 24 * 60 * 60 * 1000;
const HEADING = "## Context's tools as they are today";

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

test("types read the way a model passes them", () => {
  assert.equal(typeOf({ type: "string" }), "string");
  assert.equal(typeOf({ type: "string", enum: ["private", "team"] }), '"private"|"team"');
  assert.equal(typeOf({ type: "array", items: { type: "string" } }), "string[]");
  assert.equal(
    typeOf({ type: "object", properties: { action: {}, thread: {} }, required: ["action"] }),
    "{action*, thread}"
  );
  assert.equal(
    typeOf({ type: "array", items: { type: "object", properties: { name: {} }, required: ["name"] } }),
    "{name*}[]"
  );
  assert.equal(typeOf({ type: ["string", "null"] }), "string|null");
  assert.equal(typeOf({ oneOf: [{ type: "string" }, { type: "integer" }] }), "string|integer");
  assert.equal(typeOf(undefined), "any");
});

test("a purpose is the first sentence, not the first full stop", () => {
  assert.equal(purposeOf("List notes under a prefix (e.g. 'a/'), or everywhere. Then more."), "List notes under a prefix (e.g. 'a/'), or everywhere.");
  assert.equal(purposeOf("Owner only. Rotate every key. More."), "Owner only. Rotate every key.");
  assert.ok(purposeOf(`${"word ".repeat(60)}end.`).endsWith("…"));
  assert.equal(purposeOf(undefined), "");
});

test("a tool line marks required arguments and leaves the shared context argument out", () => {
  const line = toolLine({
    name: "write_note",
    description: "Write a note into the person's own context. Long story.",
    inputSchema: {
      properties: { path: { type: "string" }, images: { type: "array", items: { type: "object" } }, context: { type: "string" } },
      required: ["path"],
    },
  });
  assert.equal(line, "- write_note — Write a note into the person's own context.\n  path*: string · images: object[]");
  assert.match(toolLine({ name: "list_links", description: "Links.", inputSchema: {} }), /\(no arguments\)/);
});

test("the list is generated from the definitions: every tool and every argument, nothing hand-kept", () => {
  const tools = toolDefinitions();
  const section = liveToolListSection(tools);
  for (const tool of tools) {
    assert.ok(section.includes(`- ${tool.name} — `), `${tool.name} is listed`);
    const line = toolLine(tool);
    assert.ok(section.includes(line));
    for (const name of Object.keys(tool.inputSchema?.properties || {})) {
      if (name === "context") continue;
      assert.ok(line.includes(`${name}`), `${tool.name} names ${name}`);
    }
  }
  assert.ok(section.includes('`context: "@name"`'), "the shared argument is said once");
  assert.match(section, /Trust this list over your app's copy/);
  assert.match(section, /reconnected/);
});

test("the full list stays compact", () => {
  // Measured at 9.7 KB for all 49 definitions on 2026-10-15. A jump past this
  // is a description or schema change that made orient heavier for every
  // stale client; look at it before raising the bound.
  assert.ok(liveToolListSection(toolDefinitions()).length < 12_000);
});

/* -------------------------------------------------------------------------- */
/* Through the worker                                                         */
/* -------------------------------------------------------------------------- */

const S3_ENDPOINT = "https://s3.example-live-tools.test";
const token = (label) => `cat_live_${label.padEnd(12, "_")}${"0".repeat(24)}`;
const STALE = token("stale");
const CURRENT = token("current");
const READ_ONLY = token("readonly");
const TEAM = token("team");
const OWNER = token("owner");
const UNKNOWN = token("unknown");
const ACROSS = token("across");
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };
const OLDEST = TOOL_NEWS[TOOL_NEWS.length - 1];

let restoreS3;
let restoreControlPlane;
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_live", "live", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "live-tools",
    accessKeyId: "AKIAEXAMPLEEXAMPLELT",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLELT",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  s3.bucketFor("live-tools").set("index.md", { body: "# Front page", etag: "i0" });
  const longAgo = Date.parse(`${OLDEST.date}T00:00:00Z`) - 30 * DAY;
  const grant = (accessToken, extra) => controlPlane.addGrant({ workspaceId: "ws_live", accessToken, ...extra });
  await grant(STALE, { toolsListedAt: longAgo });
  await grant(CURRENT, { toolsListedAt: Date.now() + DAY });
  await grant(READ_ONLY, { toolsListedAt: longAgo, scopes: ["context:read"] });
  await grant(TEAM, { toolsListedAt: longAgo, scopes: ["context:read", "context:write"] });
  await grant(OWNER, { toolsListedAt: longAgo, scopes: ["context:read", "context:write", "context:private"] });
  await grant(UNKNOWN, { userId: "user_unknown" });
  controlPlane.addWorkspace("ws_live_other", "liveother", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "live-tools-other",
    accessKeyId: "AKIAEXAMPLEEXAMPLELO",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLELO",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  s3.bucketFor("live-tools-other").set("index.md", { body: "# Theirs", etag: "o0" });
  await grant(ACROSS, {
    toolsListedAt: longAgo,
    userId: "user_across",
    alsoMemberOf: [{ workspaceId: "ws_live_other", role: "member" }],
  });
});

async function rpc(accessToken, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return body;
}

const orient = async (accessToken, args = {}) =>
  (await rpc(accessToken, "tools/call", { name: "orient", arguments: args }))?.result?.content?.[0]?.text || "";

/** The tool names a section lists, in order. */
function listedNames(text) {
  const at = text.indexOf(HEADING);
  if (at === -1) return null;
  const section = text.slice(at).split("\n## ")[0];
  return [...section.matchAll(/^- ([a-z_]+) — /gm)].map((match) => match[1]);
}

test("a stale client gets the full list after the news, ahead of the front page", async () => {
  const text = await orient(STALE);
  const news = text.indexOf("## New in Context's tools");
  const list = text.indexOf(HEADING);
  assert.ok(news > 0 && list > news, "after what changed");
  assert.ok(list < text.indexOf("## Front page"));
  assert.match(text, /- write_note — .*\n {2}path\*: string · .*comment: \{action\*/);
});

test("it lists exactly what tools/list offers the same connection, in the same order", async () => {
  for (const accessToken of [STALE, READ_ONLY, TEAM, OWNER]) {
    const offered = (await rpc(accessToken, "tools/list", {}))?.result?.tools?.map((tool) => tool.name);
    assert.ok(offered?.length > 0);
    // Listing stamps the grant; orient with `tools: true` still shows the list.
    assert.deepEqual(listedNames(await orient(accessToken, { tools: true })), offered);
  }
});

test("a read-only connection is not listed a tool that writes", async () => {
  const names = listedNames(await orient(READ_ONLY, { tools: true }));
  assert.ok(names.includes("read_note"));
  assert.ok(!names.includes("write_note"));
  assert.ok(!names.includes("remember"));
});

test("a tool masked from a tier stays hidden from it", async () => {
  const team = listedNames(await orient(TEAM, { tools: true }));
  assert.ok(!team.includes("rotate_encryption_keys"));
  assert.ok(!team.includes("create_link"));
  const owner = listedNames(await orient(OWNER, { tools: true }));
  assert.ok(owner.includes("rotate_encryption_keys"), "the owner sees it, so the filter is the tier and not the renderer");
});

test("an unlisted tool is not listed here either", async () => {
  assert.ok(!listedNames(await orient(OWNER, { tools: true })).includes("create_form"));
});

test("a current client gets one line, and the list when it asks", async () => {
  const text = await orient(CURRENT);
  assert.ok(!text.includes(HEADING));
  assert.ok(!text.includes("## New in Context's tools"));
  assert.match(text, /## Context's tools\n\nYour app's copy of Context's tools \(loaded \d{4}-\d{2}-\d{2}\) is current\. .*orient with `tools: true`/);
  const asked = await orient(CURRENT, { tools: true });
  assert.ok(asked.includes(HEADING));
  assert.ok(!asked.includes("is current."));
});

test("an unknown listing time gets the line without a date, never a guess", async () => {
  const text = await orient(UNKNOWN);
  assert.ok(!text.includes(HEADING));
  assert.match(text, /seems missing from your app's copy of Context's tools, call orient with `tools: true`/);
  assert.ok(!text.includes("is current."));
});

test("orient addressed to another workspace lists this connection's tools", async () => {
  const offered = (await rpc(ACROSS, "tools/list", {}))?.result?.tools?.map((tool) => tool.name);
  const text = await orient(ACROSS, { context: "@liveother", tools: true });
  assert.ok(text.startsWith("# Orientation"), "orient answered there rather than refusing");
  assert.deepEqual(listedNames(text), offered);
});

test("tools must be a boolean", async () => {
  const body = await rpc(CURRENT, "tools/call", { name: "orient", arguments: { tools: "yes" } });
  assert.equal(body?.result?.isError, true);
});
