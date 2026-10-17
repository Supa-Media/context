/**
 * THE MEETING SUMMARY'S CHECK: THE GATEWAY'S OWN WRITE-AND-CHECK PATH.
 *
 * The case's input is a whole meeting note; the setup under test is parsed
 * the way production parses `ai/production/meeting-summaries.md`
 * (`summaryPrompts`), and `draftSummary` runs exactly as the route does: one
 * forced call to write, one to check, through the AI gateway. The output
 * checked is the rendered `## Summary` section.
 */

import { parseSetup } from "../../src/agent/production.js";
import { aiGatewayConfig, gatewayMetadata } from "../../src/agent/aiGateway.js";
import { draftSummary, summaryPrompts } from "../../src/meetings/summarize.js";
import { renderSummary } from "../../../../packages/meetings/src/summary.js";

const FAKE_ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "bench",
  AI_GATEWAY_TOKEN: "bench-gateway-token-not-a-real-one",
};

/** `--fake`: the summary tool called with the transcript's first spoken line. Plumbing only. */
function fakeFetch() {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = JSON.stringify(body.messages);
    const line = /\*\*\[[\d:]+\] ([^*]+)\*\* — ([^\\"]+)/.exec(user);
    const input = {
      summary: [line ? `${line[1]} said: ${line[2]}` : "A meeting."],
      decisions: [],
      tables: [],
      chart: null,
      action_items: [],
      open_questions: [],
    };
    return new Response(
      JSON.stringify({ content: [{ type: "tool_use", id: "toolu_1", name: "write_meeting_summary", input }], stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 80 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

export const meetingSummariesJob = {
  name: "meeting-summaries",
  setupNote: true,
  async run({ setup, testCase, today, fake }) {
    if (!testCase.input) throw new Error(`case ${testCase.n}: no input meeting note`);
    const parsed = await parseSetup(setup.raw);
    if (parsed === null) throw new Error(`setup ${setup.name} does not validate`);
    const prompts = summaryPrompts(parsed);
    const config = aiGatewayConfig(fake ? FAKE_ENV : process.env);
    if (!config) throw new Error("AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN are not set");
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const started = Date.now();
    const output = await draftSummary(
      testCase.input,
      { today },
      config,
      { metadata: gatewayMetadata({ feature: "benchmark" }), ...(fake ? { fetchImpl: fakeFetch() } : {}) },
      usage,
      prompts,
    );
    const ms = Date.now() - started;
    if (!output) return { output: "", error: "no summary came back", ms, model: prompts.model };
    return { output: renderSummary(output), error: null, ms, model: prompts.model };
  },
};
