import assert from "node:assert/strict";

import { EARLIER, estimateBodyTokens, fitHaikuBody, HAIKU_INPUT_BUDGET, LEFT_OUT } from "../../../../../packages/tex/gateway/agent/promptBudget.js";

export default {
  id: "prompt-under-cliff",
  incident:
    "2026-11-17, after the history caps shipped: 161 Haiku requests in three hours still went over 100,000 input tokens (average 125,800), from 1:1 threads on setups 54bad9c2e0f0 and d51546d21963. The average Haiku call stayed about 32,000 tokens.",
  cause:
    "The caps bound the week's transcript only. A 1:1 stretch replays tool results whole, up to 64,000 characters each, outside those caps, and Haiku charges five times past 100,000 tokens.",
  path: "1:1 text",
  async run() {
    const page = "The lease says the deposit is one month. ".repeat(12_000);
    const body = {
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: "You are Tex." }],
      tools: [{ name: "fetch", description: "Read.", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: page }] },
        { role: "user", content: [{ type: "text", text: "what is the deposit" }] },
      ],
    };
    assert.ok(estimateBodyTokens(body) > 100_000);
    const fit = fitHaikuBody(body);
    assert.ok(fit.after <= HAIKU_INPUT_BUDGET);
    assert.equal(fit.body.messages[0].content[0].content, LEFT_OUT);
    assert.equal(fit.body.messages[1].content[0].text, "what is the deposit");

    // The week's history yields before this round's own tool result. Stubbing that result first left the history
    // in place, the model called the tool again, and the next round was just as long.
    const history = "Monday. ".repeat(20_000);
    const keptPage = "The lease says the deposit is one month. ".repeat(8_000);
    const round = {
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: "You are Tex." }],
      tools: [{ name: "fetch", description: "Read.", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: history }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_now", name: "fetch", input: { id: "lease" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_now", content: keptPage }] },
      ],
    };
    assert.ok(estimateBodyTokens(round) > 100_000);
    const kept = fitHaikuBody(round);
    assert.ok(kept.after <= HAIKU_INPUT_BUDGET);
    assert.equal(kept.body.messages[0].content[0].text, EARLIER);
    assert.equal(kept.body.messages[2].content[0].content, keptPage);
  },
};
