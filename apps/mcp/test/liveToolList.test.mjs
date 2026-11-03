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
import { appDropsUnknownArguments, liveToolListSection, refreshStep, purposeOf, toolLine, typeOf } from "../src/tools/liveList.js";
import { SIX_TOOLS_LINE } from "../src/orient/tool.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const DAY = 24 * 60 * 60 * 1000;
const HEADING = "## Context's tools as they are today";
const WORKSPACES = "## Workspaces";

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
      if (name === "context" || name === "mailbox" || name === "person_said") continue;
      assert.ok(line.includes(`${name}`), `${tool.name} names ${name}`);
    }
  }
  assert.ok(section.includes('`context: "@name"`'), "the shared argument is said once");
  assert.ok(section.includes("`person_said`"), "and so is the person's words, for the sharing judge");
  assert.match(section, /Trust this list over your app's copy/);
  assert.match(section, /reconnected/);
});

test("the full list stays compact", () => {
  // Measured at 9.7 KB for all 49 definitions on 2026-10-15. A jump past this
  // is a description or schema change that made orient heavier for every
  // stale client; look at it before raising the bound. Raised to 12,500 on
  // 2026-10-17 for `notify_me`: the list stood at 11,976 with 54 tools, and
  // one more tool's line is about 220 characters however short its summary.
  // Raised to 13,000 on 2026-10-18 for `search_email` and `read_email`: the
  // list stood at 12,372 with 59 tools, and the two added about 220.
  // Raised to 13,500 on 2026-10-19 for `read_file` and read_email's
  // `attachment`: the list stood at 13,063.
  // Raised to 14,200 on 2026-10-21 for `connect_app` and `slack_api`, the
  // first connector: the list stood at 13,922 with 62 tools.
  // Raised to 14,700 the same day for `app_read` and `app_change`, every app
  // connected through its own MCP server: the list stood at 14,265 with 64.
  // Raised to 15,000 on 2026-10-22 for send_email's and save_email_draft's
  // `attach`, a file Tex downloaded: the list stood at 14,707.
  // Raised to 15,500 on 2026-10-23 for calendar_event's edit and rsvp
  // (new_title, add_guests, remove_guests, reminders, recurrence, all_events,
  // response): the list stood at 15,011 with 70 tools.
  // Raised to 16,300 on 2026-10-26 for search_texts, list_texts and
  // read_texts, which are unlisted (reached through search and fetch) but
  // still defined: the list stood at 15,821 with 74.
  assert.ok(liveToolListSection(toolDefinitions()).length < 16_300);
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
const CODEX = token("codex");
// Never sent tools/list, so it stays stale whichever tests ran first: the
// listing test stamps STALE with today, and news dated before today then
// drops out, so a check on STALE after it passed only on the news's own day.
const NEVER_LISTED = token("neverlisted");
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };
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
  // A copied tree for each workspace, so orient can draw its map.
  controlPlane.serveTreesFrom(undefined, { s3 });
  const longAgo = Date.parse(`${OLDEST.date}T00:00:00Z`) - 30 * DAY;
  const grant = (accessToken, extra) => controlPlane.addGrant({ workspaceId: "ws_live", accessToken, ...extra });
  await grant(STALE, { toolsListedAt: longAgo });
  await grant(CURRENT, { toolsListedAt: Date.now() + DAY });
  await grant(READ_ONLY, { toolsListedAt: longAgo, scopes: ["context:read"] });
  await grant(TEAM, { toolsListedAt: longAgo, scopes: ["context:read", "context:write"] });
  await grant(OWNER, { toolsListedAt: longAgo, scopes: ["context:read", "context:write", "context:private"] });
  await grant(UNKNOWN, { userId: "user_unknown" });
  await grant(CODEX, { toolsListedAt: longAgo, clientName: "Codex", userId: "user_codex" });
  await grant(NEVER_LISTED, { toolsListedAt: longAgo, userId: "user_never_listed" });
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

/** The tool names the live list lists, in order: the lines that start at column 0. */
function listedNames(text) {
  const at = text.indexOf(HEADING);
  if (at === -1) return null;
  const section = text.slice(at).split("\n## ")[0];
  return [...section.matchAll(/^- ([a-z_]+) — /gm)].map((match) => match[1]);
}

test("a stale client gets the news, then the list, ahead of the workspaces", async () => {
  const text = await orient(STALE);
  const news = text.indexOf("## New in Context's tools");
  const list = text.indexOf(HEADING);
  assert.ok(news > 0 && list > news, "after what changed");
  assert.ok(list < text.indexOf(WORKSPACES));
  assert.match(text, /- write — .*\n {2}action: string · path: string · content: string · expected_etag: string · args: object/);
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
  const text = await orient(READ_ONLY, { tools: true });
  const names = listedNames(text);
  assert.ok(names.includes("search"));
  assert.ok(!names.includes("write"));
  assert.ok(!names.includes("manage"));
  assert.ok(!text.includes("### write"), "and no action of a tool it may not call");
});

test("an action whose tool is private-tier only is named to the owner alone", async () => {
  const team = await orient(TEAM, { tools: true });
  assert.ok(!team.includes("  - share_link — "), "a team connection is not told of share_link");
  assert.ok(team.includes("  - move — "), "but it is told of what it may call");
  const owner = await orient(OWNER, { tools: true });
  assert.ok(owner.includes("  - share_link — "), "the owner is: the filter is the tier and not the renderer");
});

test("an unlisted tool is not listed here either", async () => {
  assert.ok(!listedNames(await orient(OWNER, { tools: true })).includes("create_form"));
});

test("a current client gets the one line, and the list when it asks", async () => {
  const text = await orient(CURRENT);
  assert.ok(!text.includes(HEADING));
  assert.ok(!text.includes("## New in Context's tools"));
  assert.ok(text.includes(SIX_TOOLS_LINE));
  const asked = await orient(CURRENT, { tools: true });
  assert.ok(asked.includes(HEADING));
  assert.ok(!asked.includes(SIX_TOOLS_LINE));
});

test("an unknown listing time gets the line, never a guess that the copy is current", async () => {
  const text = await orient(UNKNOWN);
  assert.ok(!text.includes(HEADING));
  assert.ok(text.includes(SIX_TOOLS_LINE));
  assert.ok(!text.includes("is current."));
});

test("orient addressed to another workspace lists this connection's tools", async () => {
  const offered = (await rpc(ACROSS, "tools/list", {}))?.result?.tools?.map((tool) => tool.name);
  const text = await orient(ACROSS, { context: "@liveother", tools: true });
  assert.ok(text.startsWith("# Context"), "orient answered there rather than refusing");
  assert.deepEqual(listedNames(text), offered);
});

test("tools sent as text by a client that does not know its type still works", async () => {
  // How Claude Code sent it on production, holding an orient with no `tools`.
  assert.ok((await orient(CURRENT, { tools: "true" })).includes(HEADING));
});

test("apps known to drop arguments their copy does not show are recognised by name", () => {
  for (const name of ["Codex", "codex-mcp-client", "OpenAI Codex CLI"]) assert.equal(appDropsUnknownArguments(name), true, name);
  for (const name of ["Claude", "ChatGPT", "Cursor", "", null, undefined]) assert.equal(appDropsUnknownArguments(name), false, String(name));
});

test("each app is told its own way to load today's tools", () => {
  assert.match(refreshStep("ChatGPT"), /Settings › Connectors › Context › Refresh/);
  assert.match(refreshStep("Codex"), /^In Codex/);
  assert.match(refreshStep("OpenAI Codex CLI"), /^In Codex/, "Codex before ChatGPT: both are OpenAI's");
  assert.match(refreshStep("claude-code"), /^In Claude Code/);
  assert.match(refreshStep("Claude"), /remove the Context connector and add it again/);
  assert.match(refreshStep("Cursor"), /restart Cursor/);
  assert.match(refreshStep("Something else"), /Reconnect Context in your app/);
  assert.match(refreshStep(null), /Reconnect Context in your app/);
});

test("most apps are told to pass unlisted arguments, with reconnecting as the way out", async () => {
  const text = await orient(NEVER_LISTED);
  const list = text.slice(text.indexOf(HEADING));
  assert.match(list, /Pass arguments exactly as listed here, even where your copy does not show them\./);
  assert.match(list, /refuses one or seems to ignore it, ask the person to reconnect\. .*Reconnect Context in your app/);
  assert.ok(!/drops/.test(list));
});

test("Codex, which drops arguments its copy does not show, is told to reconnect instead", async () => {
  const text = await orient(CODEX);
  const news = text.slice(text.indexOf("## New in Context's tools"), text.indexOf(HEADING));
  const list = text.slice(text.indexOf(HEADING), text.indexOf(WORKSPACES));
  for (const section of [news, list]) {
    assert.match(section, /Your app drops any argument its own copy of a tool does not show/);
    assert.match(section, /In Codex, reconnect Context or start a new session\./);
    assert.ok(!/even where your copy/.test(section), "never told to pass what will be dropped");
  }
  assert.ok(listedNames(text).includes("write"), "the list is still there, as the reason to reconnect");
});

test("tools must be a boolean", async () => {
  const body = await rpc(CURRENT, "tools/call", { name: "orient", arguments: { tools: "yes" } });
  assert.equal(body?.result?.isError, true);
});
