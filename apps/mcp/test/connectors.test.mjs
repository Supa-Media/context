/**
 * Connected apps on the gateway's side (`src/tools/connectors.js`): the link
 * tool, a Slack call shaped for the control plane, a post held for the
 * person's yes, and a group turn never offered one: an app connects for
 * one person only. Who may use which connection is the control plane's,
 * proven in `apps/convex/__tests__/connections/`.
 *
 * Sabotage these and a test here fails:
 *  1. `irreversibleOf` no longer holding `slack_api` posts → "a post waits".
 *  2. It holding a read or a reaction → "a read or a reaction runs at once".
 *  3. `toolSlackApi` showing a long answer whole → "a long answer is refused".
 *  4. `groupWriteTools` offering the connector tools → "a group turn is never offered Slack".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { toolConnectApp, toolSlackApi, MAX_ANSWER_CHARS } from "../src/tools/connectors.js";
import { irreversibleOf } from "../src/tools/irreversible.js";
import { groupWriteTools } from "../src/agent/groupTurn.js";
import { toolDefinitions } from "../src/tools/registry.js";

const text = (result) => result.content.map((part) => part.text).join("\n");

function storeWith(connectors) {
  const store = {};
  Object.defineProperty(store, "connectors", { value: connectors, enumerable: false });
  return store;
}

test("connect_app hands back the control plane's link, to send on a line of its own", async () => {
  const asked = [];
  const store = storeWith({ request: async (provider) => (asked.push(provider), { url: "https://context.lc/connect/slack/abc", reason: null }) });
  const result = await toolConnectApp(store, { app: "slack" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(asked, ["slack"]);
  assert.match(text(result), /https:\/\/context\.lc\/connect\/slack\/abc/);
  assert.match(text(result), /line of its own/);
  const off = await toolConnectApp(storeWith({ request: async () => ({ url: null, reason: "unavailable" }) }), { app: "slack" });
  assert.equal(off.isError, true);
  assert.match(text(off), /not set up/);
  assert.equal((await toolConnectApp(store, { app: "Not an app!" })).isError, true);
  const unknown = await toolConnectApp(storeWith({ request: async () => ({ url: null, reason: "unknown_provider" }) }), { app: "outlook" });
  assert.match(text(unknown), /fetch apps:/);
  const named = await toolConnectApp(storeWith({ request: async () => ({ url: "https://context.lc/connect/linear/x", name: "Linear" }) }), { app: "linear" });
  assert.match(text(named), /approve in Linear/);
});

test("a Slack call goes to the control plane as method, args and team, and the answer says which Slack", async () => {
  const sent = [];
  const store = storeWith({ call: async (request) => (sent.push(request), { ok: true, team: "Acme", body: { ok: true, channels: [] } }) });
  const result = await toolSlackApi(store, { method: "conversations.list", args: { types: "public_channel" }, limit: 20, team: "Acme" });
  assert.deepEqual(sent, [{ provider: "slack", method: "conversations.list", args: { types: "public_channel", limit: 20 }, team: "Acme" }]);
  assert.match(text(result), /^Slack \(Acme\) answered conversations\.list:/);
  assert.equal((await toolSlackApi(store, { method: "not a method" })).isError, true);
});

test("a refusal is told in words the model can act on", async () => {
  const store = storeWith({ call: async () => ({ ok: false, refused: "choose_team", teams: ["Acme", "Lovelace"] }) });
  assert.match(text(await toolSlackApi(store, { method: "conversations.list" })), /Acme, Lovelace/);
  const none = storeWith({ call: async () => ({ ok: false, refused: "not_connected" }) });
  assert.match(text(await toolSlackApi(none, { method: "conversations.list" })), /manage connect/);
});

test("a long answer is refused rather than shown whole", async () => {
  const store = storeWith({ call: async () => ({ ok: true, team: "Acme", body: { ok: true, messages: "x".repeat(MAX_ANSWER_CHARS) } }) });
  const result = await toolSlackApi(store, { method: "conversations.history", args: { channel: "C1" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /smaller limit/);
});

test("a post waits for the person's yes to its words", () => {
  const held = irreversibleOf("slack_api", { method: "chat.postMessage", args: { channel: "C1", text: "Running late" } });
  assert.equal(held.permanent, true);
  assert.equal(held.audience, "outside");
  assert.match(held.summary, /post in Slack in C1: "Running late"/);
  assert.notEqual(irreversibleOf("slack_api", { method: "chat.update", args: { channel: "C1", ts: "1", text: "x" } }), null);
});

test("a read or a reaction runs at once", () => {
  assert.equal(irreversibleOf("slack_api", { method: "conversations.history", args: { channel: "C1" } }), null);
  assert.equal(irreversibleOf("slack_api", { method: "reactions.add", args: { channel: "C1", timestamp: "1", name: "eyes" } }), null);
});

test("a group turn is never offered Slack, since it connects for one person only", () => {
  const names = groupWriteTools(toolDefinitions()).map((tool) => tool.name);
  assert.ok(!names.includes("slack_api"));
  assert.ok(!names.includes("connect_app"));
});
