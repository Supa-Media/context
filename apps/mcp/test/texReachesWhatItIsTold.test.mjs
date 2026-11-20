/**
 * What Tex is told it can do, a 1:1 turn can actually reach.
 *
 * Dev2, 2026-11-15: asked in a 1:1 text to check their Google Chat, Tex called
 * `fetch chat:`, as its capability list says, and the call became the group
 * chat's own `earlier_chat`, which no 1:1 turn holds ("no such tool"); and the
 * Google Chat reader itself (`read_google_chat`, unlisted on the MCP) was never
 * handed to a turn at all. Tex answered "I can't open your Google Chat
 * directly". The capability test proved every action is on a line, never that
 * a turn holds what the line names; this one does.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `grantedToolsFor` handing only TEXTS_TOOLS again                          2
 *   `resolve` taking an assistant id the turn does not hold                   2
 *   `fetchTool` without the Google Chat line                                  1
 *
 * Fake names and addresses only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { grantedToolsFor, sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { CAPABILITIES } from "../../../packages/tex/gateway/agent/capabilities.js";
import { ACTIONS } from "../src/tools/v2/actions.js";
import { STAFF_ONLY_TOOLS } from "../src/tools/registry.js";
import { EARLIER_TEXTS_DEFINITION } from "../../../packages/tex/gateway/agent/conversation.js";
import { earlierChatTool } from "../../../packages/tex/gateway/agent/groupTurn.js";

const OWNER = { workspaceKind: "personal", role: "owner", scope: "private", scopes: ["context:read", "context:write", "context:private", "context:capture"] };
const cleared = () => ({ texts: { cleared: true }, readObject: async () => null, get: async () => null });

/** A 1:1 turn's tools: what the door asks for (`checkItMayRun.js`), and the chat's own earlier texts. */
async function oneToOne() {
  return [...(await grantedToolsFor(OWNER, cleared(), { texts: true })), EARLIER_TEXTS_DEFINITION];
}

/**
 * Actions on the capability list a 1:1 turn is deliberately not handed, each with why. A new entry here is a
 * decision, not a way to make this pass.
 */
const NOT_IN_A_TURN = new Map([
  // `save_many` runs only through the MCP's own v2 translation (`tools/session.js`); a turn saves one note per call.
  ["write.save_many", "a turn saves notes one call each"],
]);

test("a 1:1 turn is handed the Google Chat reader; a dream, a check-in and an uncleared store are not", async () => {
  const names = async (store, options) => (await grantedToolsFor(OWNER, store, options)).map((tool) => tool.name);
  assert.ok((await names(cleared(), { texts: true })).includes("read_google_chat"));
  assert.ok(!(await names(cleared())).includes("read_google_chat"), "a surface that did not ask is not handed it");
  assert.ok(!(await names({ readObject: async () => null, get: async () => null }, { texts: true })).includes("read_google_chat"), "an uncleared store is not");
});

test("in a 1:1 turn, fetch chat: reaches their Google Chat, never the group chat's history", async () => {
  const tools = await oneToOne();
  const held = new Set(tools.map((tool) => tool.name));
  const six = sixToolsOver(tools);
  const spaces = six.resolve("fetch", { id: "chat:" });
  assert.equal(spaces.name, "google_chat");
  assert.equal(spaces.args.action, "spaces");
  assert.deepEqual(six.resolve("fetch", { id: "chat:spaces/AAAAexample" }), { name: "read_google_chat", args: { space: "spaces/AAAAexample" } });
  assert.deepEqual(six.resolve("fetch", { id: "chat:", args: { to: "ada@example.com", limit: 20 } }), { name: "read_google_chat", args: { to: "ada@example.com", limit: 20 } });
  for (const name of ["google_chat", "read_google_chat"]) assert.ok(held.has(name), `${name} is held`);
  const fetch = six.tools.find((tool) => tool.name === "fetch");
  assert.match(fetch.description, /chat: lists their Google Chat spaces/);
  assert.doesNotMatch(fetch.description, /this group chat's earlier messages/);
});

test("in a group turn, fetch chat: stays the chat's own history, and Google Chat is not offered", () => {
  const group = [{ name: "read_note", description: "Read a note.", inputSchema: { type: "object" } }, earlierChatTool([]).tool];
  const six = sixToolsOver(group);
  assert.deepEqual(six.resolve("fetch", { id: "chat:" }), { name: "earlier_chat", args: {} });
  const fetch = six.tools.find((tool) => tool.name === "fetch");
  assert.match(fetch.description, /this group chat's earlier messages/);
  assert.doesNotMatch(fetch.description, /Google Chat/);
});

test("every fetch id the capability list names reaches a tool a 1:1 turn holds", async () => {
  const tools = await oneToOne();
  const held = new Set(tools.map((tool) => tool.name));
  const six = sixToolsOver(tools);
  const ids = new Set();
  for (const entry of CAPABILITIES) {
    for (const words of [entry.texts, ...(entry.cant ?? []).map((cant) => cant.workaround?.text)]) {
      if (typeof words !== "string") continue;
      // `fetch chat:`, `fetch texts:<id>`, `fetch id "links:"`: a placeholder is read as one sample id.
      for (const match of words.matchAll(/fetch (?:id )?"?([a-z_]+:)(<[a-z]+>)?/g)) ids.add(match[2] ? `${match[1]}sample` : match[1]);
    }
  }
  assert.ok(ids.has("chat:"), "the list names Google Chat's id");
  const unreached = [...ids].filter((id) => {
    const resolved = six.resolve("fetch", { id });
    return resolved.error !== undefined || !held.has(resolved.name);
  });
  assert.deepEqual(unreached, [], `a 1:1 turn cannot reach these fetch ids its capability list names: ${unreached.join(", ")}`);
});

test("every write, manage and send action on the capability list is handed to a 1:1 turn, or is named as not", async () => {
  const held = new Set((await oneToOne()).map((tool) => tool.name));
  const listed = new Set(CAPABILITIES.flatMap((entry) => entry.actions));
  const missing = [];
  for (const family of ["write", "manage", "send"]) {
    for (const [name, entry] of Object.entries(ACTIONS[family])) {
      const key = `${family}.${name}`;
      if (!listed.has(key) || STAFF_ONLY_TOOLS.has(entry.tool) || NOT_IN_A_TURN.has(key)) continue;
      if (!held.has(entry.tool)) missing.push(`${key} (${entry.tool})`);
    }
  }
  assert.deepEqual(missing, [], `Tex is told it can do these, but a 1:1 turn is never handed their tool: ${missing.join(", ")}`);
  for (const key of NOT_IN_A_TURN.keys()) {
    const [family, name] = key.split(".");
    assert.ok(!held.has(ACTIONS[family][name].tool), `${key} is handed to a turn now: take it off NOT_IN_A_TURN`);
  }
});
