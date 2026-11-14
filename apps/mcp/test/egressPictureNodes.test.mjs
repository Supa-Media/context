/**
 * The egress judge, the picture maker and the card check as nodes of Tex's graph (`src/agent/graph/nodes/`). Each runs
 * on the config's model, and the picture maker's check goes through the card node's wire, never around it.
 *
 * Sabotage record: applied, suite run, named check observed failing, reverted.
 *
 *   egress.js passing a model other than texModel("egress") (say "anthropic/claude-sonnet-5-5") → "the egress node asks the config's model" fails
 *   picture.js always passing check null                                  → "the picture node runs its check through the card node's wire" fails
 *   texConfig.json's picture -> card wire dropped                         → "the picture node runs its check through the card node's wire" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG, texModel } from "../src/agent/texConfig.js";
import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";
import card from "../src/agent/graph/nodes/card.js";
import egress from "../src/agent/graph/nodes/egress.js";
import picture from "../src/agent/graph/nodes/picture.js";
import { DEFAULT_GATEWAY_MODEL } from "../src/agent/builtin.js";
import { AI_GATEWAY_ENV } from "./agentModelFixture.mjs";

const { createGraph } = graphLib;

const WORDS = "share the Packing list with the team";
const ACTION = "make notes/packing.md visible to the team";

/** Stubs the global fetch the judge's request goes through; returns the bodies it was sent. */
async function withJudgeFetch(allow, run) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t", name: "verdict", input: { allow, reason: "They asked for it." } }] }), { status: 200 });
  };
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the egress node asks the gateway for the config's model, and refuses to run with no gateway", async () => {
  // Today's judge runs DEFAULT_GATEWAY_MODEL; the config's egress step must name the same model, so the move changes nothing.
  assert.equal(texModel("egress"), DEFAULT_GATEWAY_MODEL);
  const { result, sent } = await withJudgeFetch(true, () => egress({ words: WORDS, action: ACTION }, { ctx: { env: AI_GATEWAY_ENV } }));
  assert.deepEqual(result, { allow: true, reason: "They asked for it." });
  assert.equal(sent.length, 1);
  // The gateway body carries the model without its provider prefix.
  assert.equal(sent[0].model, texModel("egress").replace(/^anthropic\//, ""));
  await assert.rejects(egress({ words: WORDS, action: ACTION }, { ctx: { env: {} } }), /no AI gateway/);
});

test("fire(tools, egress) runs the judge through its wire, and no step without that wire can", async () => {
  const { result } = await withJudgeFetch(false, async () => {
    const out = await gatewayGraph().fire("tools", "egress", { words: WORDS, action: ACTION }, { env: AI_GATEWAY_ENV });
    await assert.rejects(gatewayGraph().fire("send", "egress", { words: WORDS, action: ACTION }, { env: AI_GATEWAY_ENV }), /no wire send -> egress/);
    return out;
  });
  assert.deepEqual(result, { allow: false, reason: "They asked for it." });
});

test("the card node runs the turn's check, and refuses to run with none", async () => {
  const seen = [];
  const io = { ctx: { cardCheck: async (input) => (seen.push(input), { send: true, critique: "" }) } };
  assert.deepEqual(await card({ tool: "draw_picture", template: "", picture: { data: "QUJD", mediaType: "image/png" }, unpinned: [] }, io), { send: true, critique: "" });
  assert.equal(seen.length, 1);
  await assert.rejects(card({}, { ctx: {} }), /no card check/);
});

test("the picture node runs its check through the card node's wire, and runs with none when the turn has none", async () => {
  const logs = [];
  const g = createGraph(TEX_CONFIG, { picture, card }, { log: (entry) => logs.push(entry) });
  const checked = [];
  const maker = {
    call: async (name, args, _callTool, options) => {
      assert.equal(typeof options.check, "function", "the picture node hands the maker its check");
      const verdict = await options.check({ tool: name, template: "", picture: { data: "QUJD", mediaType: "image/png" }, unpinned: [] });
      checked.push(verdict);
      return { content: [{ type: "text", text: "drawn" }] };
    },
  };
  const cardRan = [];
  const cardCheck = async (input) => (cardRan.push(input.tool), { send: false, critique: "The date is missing." });
  const { outputs } = await g.run("picture", { tool: "draw_picture", args: { html: "<p>x</p>" } }, { maker, callTool: async () => null, cardCheck });
  assert.deepEqual(outputs.picture, { result: { content: [{ type: "text", text: "drawn" }] } });
  assert.deepEqual(cardRan, ["draw_picture"], "the card ran once, for the picture");
  assert.deepEqual(checked, [{ send: false, critique: "The date is missing." }]);
  assert.equal(logs.find((entry) => entry.node === "card")?.via, "picture:uses", "the card ran through the picture's uses wire");

  // No check in the turn: the maker is given none, as it has today, and no card runs.
  const bare = { call: async (_name, _args, _callTool, options) => ({ content: [{ type: "text", text: options.check === null ? "no check" : "check" }] }) };
  const second = await g.run("picture", { tool: "make_picture", args: { prompt: "a cat" } }, { maker: bare, callTool: async () => null, cardCheck: null });
  assert.deepEqual(second.outputs.picture, { result: { content: [{ type: "text", text: "no check" }] } });
  assert.equal(logs.filter((entry) => entry.node === "card").length, 1, "no card ran with no check");
});
