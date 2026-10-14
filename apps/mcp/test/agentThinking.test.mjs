/**
 * TEX KEEPS ITS THINKING ACROSS STEPS (owner, 2026-10-14: "setting up thinking
 * … is very important").
 *
 * Claude 5.5 models think by default. Each round's thinking came back and was
 * thrown away, so the next round, after a tool call, started over; and
 * `max_tokens` of 2048 covered the thinking and the answer together. Now a
 * round's own blocks are handed back unchanged to the next, all of them are
 * dropped at once when the tool list changes (the API checks a block against
 * the tools it was made with), a setup can say how hard each model thinks,
 * and a round has 8192 tokens of room.
 *
 * ## Sabotage record
 *
 *   `anthropicMessages` rebuilding a thought round from text and tool_use
 *     → "the next round gets the thinking back, unchanged and first" fails
 *   `runTurn` keeping the blocks when find_tools loads a tool
 *     → "a newly loaded tool drops every earlier thinking block at once" fails
 *   `runTurn` not passing the model's effort
 *     → "the think model thinks as hard as the setup says" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, gatewayBody, resetCreditState } from "../src/agent/aiGateway.js";
import { anthropicMessages } from "../src/agent/providers.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { parseSetup } from "../src/agent/production.js";
import { FIND_TOOLS } from "../src/agent/toolShelf.js";
import { runTurn } from "../src/agent/turn.js";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const THOUGHT = { type: "thinking", thinking: "", signature: "sig-round-one" };

function reply(blocks, stop = "end_turn") {
  return { id: "msg", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } };
}

function scripted(replies) {
  const queue = [...replies];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bodies, fetchImpl };
}

const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} } });

async function turn(fetchImpl, extra = {}) {
  resetCreditState();
  return await runTurn({
    question: "move the glue-up to the 27th",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [tool("read_note"), tool("write_note"), tool("browse")],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    ...extra,
  });
}

test("a round has room to think and answer, and a setup's effort is sent", () => {
  const body = gatewayBody({ model: HAIKU, system: "s", messages: [{ role: "user", text: "hi" }], tools: [], effort: "high" });
  assert.equal(body.max_tokens, 8192);
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal(gatewayBody({ model: HAIKU, system: "s", messages: [{ role: "user", text: "hi" }], tools: [], effort: "huge" }).output_config, undefined);
});

test("a thought round is handed back as it came", () => {
  const content = [THOUGHT, { type: "tool_use", id: "t1", name: "read_note", input: {} }];
  const wire = anthropicMessages([
    { role: "user", text: "q" },
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "read_note", args: {} }], content },
    { role: "tool", id: "t1", text: "note" },
  ]);
  assert.deepEqual(wire[1], { role: "assistant", content });
});

test("the next round gets the thinking back, unchanged and first", async () => {
  const { bodies, fetchImpl } = scripted([
    reply([THOUGHT, { type: "tool_use", id: "t1", name: "read_note", input: { path: "a.md" } }], "tool_use"),
    reply([{ type: "text", text: "Moved." }]),
  ]);
  const result = await turn(fetchImpl);
  assert.equal(result.answer, "Moved.");
  const assistant = bodies[1].messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.content[0], THOUGHT);
  assert.equal(assistant.content[1].type, "tool_use");
});

test("a newly loaded tool drops every earlier thinking block at once", async () => {
  const { bodies, fetchImpl } = scripted([
    reply([THOUGHT, { type: "tool_use", id: "t1", name: "read_note", input: {} }], "tool_use"),
    reply([{ ...THOUGHT, signature: "sig-two" }, { type: "tool_use", id: "t2", name: FIND_TOOLS, input: { names: ["browse"] } }], "tool_use"),
    reply([{ type: "text", text: "Done." }]),
  ]);
  await turn(fetchImpl, { coreTools: ["read_note", "write_note"] });
  // Round two: same tools as round one, so round one's thinking rides along.
  assert.ok(bodies[1].messages.some((m) => m.role === "assistant" && m.content[0].type === "thinking"));
  // Round three: browse was loaded, so no earlier block is sent at all.
  assert.ok(bodies[2].tools.some((t) => t.name === "browse"));
  assert.ok(!JSON.stringify(bodies[2].messages).includes('"thinking"'));
});

test("the think model thinks as hard as the setup says", async () => {
  const { bodies, fetchImpl } = scripted([reply([{ type: "text", text: "Sure." }])]);
  await turn(fetchImpl, { efforts: { [HAIKU]: "low" } });
  assert.deepEqual(bodies[0].output_config, { effort: "low" });
});

const SETUP = (models) => `---\njob: texting-assistant\nmodels:\n${models}\n---\n\nYou are Tex.\n`;

test("a setup names each model's effort, and a word that isn't one refuses the file", async () => {
  const both = await parseSetup(
    SETUP(`  main: ${HAIKU}\n  router: "@cf/cloudflare/clef"\n  think: anthropic/claude-opus-5-5\n  effort: low\n  think_effort: high`),
  );
  assert.deepEqual(both.efforts, { [HAIKU]: "low", "anthropic/claude-opus-5-5": "high" });
  assert.deepEqual((await parseSetup(SETUP(`  main: ${HAIKU}`))).efforts, {});
  assert.equal(await parseSetup(SETUP(`  main: ${HAIKU}\n  effort: huge`)), null);
  assert.equal(await parseSetup(SETUP(`  main: ${HAIKU}\n  think_effort: high`)), null);
});
