import assert from "node:assert/strict";
import { aiGatewayConfig, resetCreditState } from "../../../../../packages/tex/gateway/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../../../../../packages/tex/gateway/agent/builtin.js";
import { runTurn } from "../../../../../packages/tex/gateway/agent/turn.js";
import { drawingSvg, readScene } from "../../../../../packages/shared/src/ink/drawing.cjs";
import { oneToOne } from "../chats.mjs";
import { sixToolsOver } from "../../../../../packages/tex/gateway/agent/sixTools.js";
import { fixedCarriers } from "../../../../../packages/tex/gateway/agent/sixToolsFixed.js";
import { TEX_CONFIG, texToolList } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { asSixCall } from "../../sixCallFixture.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";

/**
 * A light full-canvas fill used to become a slab of ink. The scene is refused
 * only when that fill would bury the drawing; a light one is left out.
 */
function paperScene() {
  const read = readScene('<rect width="1200" height="900" fill="#fff"/><circle cx="400" cy="450" r="80" fill="none"/>');
  assert.equal(read.error, null, read.error);
  assert.deepEqual(read.shapes.map((shape) => shape.tag), ["circle"]);
  assert.doesNotMatch(drawingSvg(read, { seed: "replay" }), /height="900"/);
  const buried = readScene('<rect width="1200" height="900" fill="#111"/><circle cx="100" cy="100" r="20"/>');
  assert.match(buried.error, /bury the drawing in ink/);
  assert.match(buried.error, /Leave the background out/);
}

const sixInput = (call) => ({ name: call.name, input: call.args });

/** A designed send-back is not a failure in the turn log, and the model still reads it as an error. */
async function sceneAsk() {
  resetCreditState();
  const rounds = [
    // The model calls `fetch`, one of the six it is shown; the turn runs it as `read_note`.
    { blocks: [{ type: "tool_use", id: "t0", ...sixInput(asSixCall({ name: "read_note", args: { path: "1-projects/picnic.page.md" } })) }], stop: "tool_use" },
    { blocks: [{ type: "text", text: "Drawing it." }], stop: "end_turn" },
  ];
  const fetchImpl = async () => {
    const next = rounds.shift();
    if (!next) throw new Error("the script ran out");
    return new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", content: next.blocks, stop_reason: next.stop, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runTurn({
    question: "draw the picnic page",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [{ name: "read_note", description: "Read a note.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: "text", text: "This page has no picture, so draw it one first." }], isError: true, ask: true }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl, metadata: { client: "texts", workspace: "ws_test" } },
    builtinModelOverride: HAIKU,
  });
  assert.deepEqual(result.timing.failures, []);
  const entry = result.timing.trace.find((item) => item.kind === "tool");
  assert.equal(entry.ok, true);
  assert.equal(entry.ask, true);
  assert.equal(result.steps.find((step) => step.tool === "read_note").ok, false);
  assert.equal(result.live.messages.find((message) => message.role === "tool").isError, true);
}

export default {
  id: "draw-visual-paper",
  incident:
    "2026-11-17: draw_visual failed 21 of 34 calls, median 22s. A white background rectangle became a solid ink block and the card check rejected the cover. A steps card with no photo drew a 'No photo found' tile and cut its words. A page asking for its scene was counted as a failure.",
  cause:
    "readScene mapped every colour to ink, so a full-canvas white fill buried the drawing. steps() always drew a photo slot. The turn log treated SCENE_ASK as a failed call.",
  path: "1:1 text",
  async run() {
    paperScene();
    await sceneAsk();
    const chat = await oneToOne();
    const pages = [];
    const shots = chat.world.env.SITE_SHOTS;
    chat.world.env.SITE_SHOTS = {
      async fetch(_url, init) {
        const body = JSON.parse(init.body);
        pages.push(body);
        return new Response(JSON.stringify({ png: PNG, width: body.width, height: body.height, blocked: [] }), { status: 200 });
      },
    };
    try {
      const drawn = await chat.text("how do I make tea, as a card", [
        {
          toolCalls: [
            {
              name: "send",
              args: {
                action: "draw_visual",
                args: {
                  template: "steps",
                  data: { title: "Making tea", steps: [{ title: "Boil the water", tip: "A rolling boil" }, { title: "Steep", tip: "Four minutes" }] },
                },
              },
            },
          ],
        },
        { text: "Boil, then steep four minutes.\n\n[picture 1]" },
      ]);
      assert.match(drawn.answer, /Boil, then steep four minutes/);
      const card = pages.map((page) => page.html ?? "").find((html) => html.includes("Making tea"));
      assert.ok(card, "the steps card was photographed");
      assert.match(card, /Boil the water/);
      assert.match(card, /Four minutes/);
      assert.doesNotMatch(card, /No photo found|data-no-photo/);
      // On the fixed list (`sixToolsFixed.js`) an action's args and rules are its manual, read by fetch manual:<action>.
      const fixed = texToolList("fd", TEX_CONFIG) === "fixed";
      const offered = fixed
        ? sixToolsOver([...fixedCarriers("one").values()], null, { shown: fixedCarriers("one") }).resolve("fetch", { id: "manual:draw_visual" }).text
        : JSON.stringify(chat.world.model.requests[0]?.tools ?? []);
      assert.match(offered, /title \(≤34 characters\), tip \(≤60 characters\)/);
      assert.match(offered, /Leave photo out when you have none/);
    } finally {
      chat.world.env.SITE_SHOTS = shots;
      chat.restore();
    }
  },
};
