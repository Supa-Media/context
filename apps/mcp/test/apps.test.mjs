/**
 * Apps connected through their own MCP server, on the gateway's side
 * (`src/tools/apps.js`): the catalog Tex reads to know what it reaches
 * natively and what needs the browser, one app's tools, a read, and a change
 * that always waits for the person's yes. Which connection, and whether a
 * tool is really a read, is the control plane's
 * (`apps/convex/functions/connectionApps.ts`).
 *
 * Sabotage these and a test here fails:
 *  1. `irreversibleOf` no longer holding `app_change` → "every change waits".
 *  2. `app_read` sending `change: true` → "a read is sent as a read".
 *  3. A long answer shown whole → "a long answer is refused".
 *  4. `groupWriteTools` offering the app tools → "a group turn is never offered".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { toolAppChange, toolAppRead, appHeldSummary } from "../src/tools/apps.js";
import { MAX_ANSWER_CHARS } from "../src/tools/connectors.js";
import { irreversibleOf } from "../src/tools/irreversible.js";
import { groupWriteTools } from "../src/agent/groupTurn.js";
import { toolDefinitions } from "../src/tools/registry.js";

const text = (result) => result.content.map((part) => part.text).join("\n");

function storeWith(connectors) {
  const store = {};
  Object.defineProperty(store, "connectors", { value: connectors, enumerable: false });
  return store;
}

const APPS = [
  { app: "linear", name: "Linear", about: "Issues and projects.", via: "mcp", state: "connected", account: "Linear" },
  { app: "notion", name: "Notion", about: "Pages and databases.", via: "mcp", state: "not_connected" },
  { app: "slack", name: "Slack", about: "Messages.", via: "api", state: "reconnect" },
];

test("with no app, the catalog says what is connected, what needs a link, and that the rest needs the browser", async () => {
  const result = await toolAppRead(storeWith({ apps: async () => APPS }), {});
  const words = text(result);
  assert.equal(result.isError, undefined);
  assert.match(words, /Linear \(app linear\): connected/);
  assert.match(words, /Notion \(app notion\): not connected; manage connect gives the link/);
  assert.match(words, /Slack \(app slack\): stopped working.*send slack/);
  assert.match(words, /not listed here: use the browser/);
});

test("an app alone lists its tools, each marked read or change, with its arguments", async () => {
  const sent = [];
  const tools = [
    { name: "list_issues", description: "List issues.", readOnly: true, inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
    { name: "create_issue", description: "Create an issue.", readOnly: false, inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  ];
  const store = storeWith({ call: async (request) => (sent.push(request), { ok: true, team: "", body: { tools } }) });
  const words = text(await toolAppRead(store, { app: "linear" }));
  assert.deepEqual(sent, [{ provider: "linear", method: "tools.list", args: {} }]);
  assert.match(words, /- list_issues \[read\] \{ limit\?: number \} List issues\./);
  assert.match(words, /- create_issue \[change\] \{ title: string \}/);
});

test("a read is sent as a read, and the app's text comes back", async () => {
  const sent = [];
  const store = storeWith({
    call: async (request) => (sent.push(request), { ok: true, team: "", body: { content: [{ type: "text", text: "ENG-1 Fix login" }] } }),
  });
  const result = await toolAppRead(store, { app: "linear", tool: "list_issues", arguments: { limit: 5 } });
  assert.deepEqual(sent, [{ provider: "linear", method: "tools.call", args: { name: "list_issues", arguments: { limit: 5 }, change: false } }]);
  assert.match(text(result), /linear answered list_issues:\nENG-1 Fix login/);
});

test("a change is sent as a change, and only through app_change", async () => {
  const sent = [];
  const store = storeWith({ call: async (request) => (sent.push(request), { ok: true, team: "", body: { content: [{ type: "text", text: "made" }] } }) });
  await toolAppChange(store, { app: "linear", tool: "create_issue", arguments: { title: "x" } });
  assert.equal(sent[0].args.change, true);
  assert.equal((await toolAppChange(store, { app: "linear" })).isError, true);
});

test("a tool that is not a read is refused as one, in words that say how to ask", async () => {
  const store = storeWith({ call: async () => ({ ok: false, refused: "needs_yes" }) });
  const words = text(await toolAppRead(store, { app: "linear", tool: "create_issue" }));
  assert.match(words, /send app/);
  const none = storeWith({ call: async () => ({ ok: false, refused: "not_connected" }) });
  assert.match(text(await toolAppRead(none, { app: "notion", tool: "search" })), /manage connect \(app notion\)/);
  assert.equal((await toolAppRead(none, { app: "../etc" })).isError, true);
  assert.equal((await toolAppRead(none, { app: "linear", arguments: [] })).isError, true);
});

test("an app's own error comes back as an error, and a long answer is refused", async () => {
  const failing = storeWith({ call: async () => ({ ok: true, team: "", body: { isError: true, content: [{ type: "text", text: "no such team" }] } }) });
  assert.equal((await toolAppRead(failing, { app: "linear", tool: "list_issues" })).isError, true);
  const long = storeWith({ call: async () => ({ ok: true, team: "", body: { content: [{ type: "text", text: "x".repeat(MAX_ANSWER_CHARS + 1) }] } }) });
  const result = await toolAppRead(long, { app: "linear", tool: "list_issues" });
  assert.equal(result.isError, true);
  assert.match(text(result), /too long/);
});

test("every change waits for the person's yes to exactly that call; a read never does", () => {
  const held = irreversibleOf("app_change", { app: "linear", tool: "create_issue", arguments: { title: "Fix login" } });
  assert.equal(held.permanent, true);
  assert.equal(held.audience, "outside");
  assert.match(held.summary, /use create_issue in linear with \{"title":"Fix login"\}/);
  assert.equal(irreversibleOf("app_read", { app: "linear", tool: "create_issue" }), null);
  assert.equal(appHeldSummary({ app: "linear" }), null);
});

test("a group turn is never offered an app, since it connects for one person only", () => {
  const names = groupWriteTools(toolDefinitions()).map((tool) => tool.name);
  assert.ok(!names.includes("app_read"));
  assert.ok(!names.includes("app_change"));
});
