/**
 * The texting assistant shown the six tools (`src/agent/sixTools.js`): each
 * lists only what the turn was granted, a call to one becomes its granted
 * carrying tool, and nothing ungranted is reachable through the six.
 *
 * Sabotage record:
 *   `resolve` skipping the grants check → "an action the surface did not
 *     allow is refused before it is dispatched" fails
 *   `grantedActions` ignoring which tools are held → "the six list only what
 *     the turn holds" fails
 *   `resolve` not looking in the other families (2026-10-20) → "an action
 *     called on the wrong one of the six runs where it lives" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sixToolsOver } from "../src/agent/sixTools.js";
import { translateV2Params } from "../src/tools/v2/translate.js";
import { runTurn } from "../src/agent/turn.js";
import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { shown } from "./sixToolsShown.mjs";

const mcp = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
const held = (...names) =>
  names.map((name) => mcp.get(name) ?? { name, description: `${name} words.`, inputSchema: { type: "object", properties: { text: { type: "string" } } } });
const skillTool = {
  name: "read_skill",
  description: "Step-by-step instructions: connect-chatgpt (someone wants ChatGPT).",
  inputSchema: { type: "object", properties: { name: { type: "string", enum: ["connect-chatgpt"] } }, required: ["name"] },
};

test("the six list only what the turn holds", () => {
  const reads = sixToolsOver(held("orient", "search_notes", "read_note", "list_notes"));
  assert.deepEqual(reads.tools.map((tool) => tool.name), ["orient", "search", "fetch"]);

  const texting = sixToolsOver([...held("orient", "search_notes", "read_note", "write_note", "move_note", "browse", "text_progress"), skillTool]);
  assert.deepEqual(texting.tools.map((tool) => tool.name), ["orient", "search", "fetch", "write", "manage", "send"]);
  const names = shown(texting.tools);
  for (const name of ["write.save", "write.comment", "manage.move", "manage.website", "send.browse", "send.progress"]) {
    assert.ok(names.has(name), name);
  }
  for (const name of ["write.propose", "manage.archive", "send.api", "send.fill_login", "send.search_web"]) {
    assert.ok(!names.has(name), `${name} is not held`);
  }
  assert.match(texting.tools.find((tool) => tool.name === "fetch").description, /skill:<name>.*connect-chatgpt/);
});

test("a call to one of the six becomes its granted carrying tool", () => {
  const { resolve } = sixToolsOver([...held("search_notes", "read_note", "write_note", "move_note", "browse", "text_progress", "earlier_texts"), skillTool]);
  assert.deepEqual(resolve("write", { path: "a.md", content: "# A\n", expected_etag: "e1" }), {
    name: "write_note",
    args: { path: "a.md", content: "# A\n", expected_etag: "e1" },
  });
  assert.equal(resolve("search", { query: "tulips" }).name, "search_notes");
  assert.equal(resolve("fetch", { id: "1-projects/a.md" }).name, "read_note");
  assert.deepEqual(resolve("fetch", { id: "skill:connect-chatgpt" }), { name: "read_skill", args: { name: "connect-chatgpt" } });
  assert.deepEqual(resolve("fetch", { id: "texts:" }), { name: "earlier_texts", args: {} });
  assert.deepEqual(resolve("send", { action: "browse", args: { steps: [{ do: "goto", url: "https://a.example/" }] } }), {
    name: "browse",
    args: { steps: [{ do: "goto", url: "https://a.example/" }] },
  });
  assert.deepEqual(resolve("send", { action: "progress", args: { text: "On it." } }), { name: "text_progress", args: { text: "On it." } });
  assert.equal(resolve("manage", { action: "move", args: { source: "a.md", destination: "b.md" } }).name, "move_note");
  // An older name is itself; the turn's allowlist decides it.
  assert.deepEqual(resolve("write_note", { path: "a.md" }), { name: "write_note", args: { path: "a.md" } });
});

test("an action the turn does not hold, or the surface did not allow, is refused before it is dispatched", () => {
  const dream = sixToolsOver(held("read_note", "list_notes", "write_note"), { write: ["save"] });
  assert.deepEqual([...shown(dream.tools)].filter((name) => name.includes(".")), ["write.save"]);
  assert.match(dream.resolve("write", { action: "comment", path: "a.md", args: {} }).error, /no action "comment" for you\. Yours: save/);
  assert.match(dream.resolve("manage", { action: "move", args: {} }).error, /Yours: none/);
  assert.match(dream.resolve("send", { action: "browse", args: {} }).error, /Yours: none/);
  assert.equal(dream.resolve("write", { path: "a.md", content: "x" }).name, "write_note");
});

test("an action called on the wrong one of the six runs where it lives, never wider", () => {
  // Tex, 2026-10-17 and 2026-10-20: write { action: "progress" } failed with "no such action" twice.
  const { resolve } = sixToolsOver(held("read_note", "write_note", "move_note", "text_progress"));
  assert.deepEqual(resolve("write", { action: "progress", args: { text: "On it." } }), { name: "text_progress", args: { text: "On it." } });
  assert.equal(resolve("send", { action: "move", args: { source: "a.md", destination: "b.md" } }).name, "move_note");
  // Not held anywhere is still refused, naming the family it was called on.
  assert.match(resolve("write", { action: "browse", args: {} }).error, /write has no action "browse" for you/);
  // A surface's grants still decide: the dream may save and nothing else.
  const dream = sixToolsOver(held("write_note", "move_note", "text_progress"), { write: ["save"] });
  assert.match(dream.resolve("write", { action: "progress", args: { text: "x" } }).error, /no action "progress"/);
  assert.match(dream.resolve("write", { action: "move", args: {} }).error, /no action "move"/);
});

test("a connected app is never granted the assistant's own actions", () => {
  for (const action of ["browse", "open_page", "search_web", "fill_login", "progress"]) {
    const { error } = translateV2Params({ name: "send", arguments: { action, args: {} } }, undefined, { app: { client: null } });
    assert.match(error ?? "", new RegExp(`send has no action "${action}"`));
  }
});

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const reply = (blocks, stop = "end_turn") => ({ id: "m", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });

test("runTurn shows the model the six, and never dispatches what was not granted", async () => {
  resetCreditState();
  const queue = [
    reply(
      [
        use("a", "manage", { action: "archive", args: { path: "a.md" } }),
        use("b", "archive_note", { path: "a.md" }),
        use("c", "write", { path: "a.md", content: "x" }),
        use("d", "fetch", { id: "a.md" }),
      ],
      "tool_use"
    ),
    reply([{ type: "text", text: "Done." }]),
  ];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dispatched = [];
  const turn = await runTurn({
    question: "tidy up",
    tools: held("orient", "search_notes", "read_note"),
    callTool: async (name) => {
      dispatched.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
  });
  assert.equal(turn.answer, "Done.");
  assert.deepEqual(bodies[0].tools.map((tool) => tool.name), ["orient", "search", "fetch"]);
  assert.deepEqual(dispatched, ["read_note"]);
  assert.deepEqual(turn.steps, [{ tool: "read_note", ok: true }]);
  const results = bodies[1].messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
  assert.equal(results.filter((block) => block.is_error === true).length, 3, "the three ungranted calls are refused in band");
});
