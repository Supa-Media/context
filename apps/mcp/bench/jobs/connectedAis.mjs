/**
 * CONNECTED AIS' CHECK: AN AI CLIENT GIVEN ONLY WHAT WE SEND IT.
 *
 * Claude, ChatGPT and the rest run their own models and prompts; what is ours
 * is the MCP server's `instructions` and its tools. So the stand-in here is a
 * plain Claude model with nothing but those: the instructions as its system
 * prompt and the `tools/list` answer as its tools, both read from the real
 * gateway in a throwaway world (`world.mjs`), every call answered by the real
 * `/mcp` endpoint as the person. The output checked is the tools it called,
 * in order, and its answer.
 */

import { claudeTransport, fakeGateway } from "../models.mjs";
import { createWorld } from "../world.mjs";

/** The world needs a texting setup note; a connected AI never sees it. */
const PLAIN_TEXTING_SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

/** The stand-in client's model: what a person's own Claude would plausibly be. */
export const CONNECTED_MODEL = "claude-haiku-5-5";
const MAX_ROUNDS = 8;

const textOf = (result) => (result?.content ?? []).map((block) => block.text ?? "").join("\n");

export const connectedAisJob = {
  name: "connected-ais",
  setupNote: false,
  async run({ bench, testCase, today, fake }) {
    if (!testCase.as) throw new Error(`case ${testCase.n}: no person asking (run_as or - as:)`);
    const question = String(testCase.input ?? testCase.text).trim();
    const send = fake ? (body) => fakeGateway()(null, { body }) : claudeTransport(process.env);
    // The world's own gateway calls are never made: only this file talks to the model.
    const world = await createWorld(bench, testCase.as, PLAIN_TEXTING_SETUP, { gatewayFetch: async () => new Response("{}", { status: 500 }), clientId: "mcp_client_bench_connected" }, today);
    try {
      const init = await world.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Context benchmark", version: "1" } });
      const listed = await world.mcp("tools/list");
      const instructions = String(init?.result?.instructions ?? "");
      const tools = (listed?.result?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema ?? { type: "object" } }));
      if (!instructions || tools.length === 0) return { output: "", error: "the gateway sent no instructions or no tools", ms: 0, model: CONNECTED_MODEL };
      const messages = [{ role: "user", content: question }];
      const called = [];
      let answer = "";
      const started = Date.now();
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const response = await send(JSON.stringify({ model: CONNECTED_MODEL, max_tokens: 2048, system: instructions, tools, messages }));
        const body = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body?.content)) return { output: "", error: `model status ${response.status}`, ms: Date.now() - started, model: CONNECTED_MODEL };
        messages.push({ role: "assistant", content: body.content });
        const uses = body.content.filter((block) => block.type === "tool_use");
        answer = body.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim() || answer;
        if (uses.length === 0) break;
        const results = [];
        for (const use of uses) {
          called.push(use.name);
          const result = await world.mcp("tools/call", { name: use.name, arguments: use.input ?? {} });
          results.push({ type: "tool_result", tool_use_id: use.id, content: textOf(result?.result) || JSON.stringify(result?.error ?? null), ...(result?.result?.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
      }
      return { output: `Tools called: ${called.join(", ") || "none"}\n\nAnswer: ${answer}`, error: null, ms: Date.now() - started, model: CONNECTED_MODEL };
    } finally {
      world.close();
    }
  },
};
