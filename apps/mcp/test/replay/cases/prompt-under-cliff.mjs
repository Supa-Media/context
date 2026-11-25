import assert from "node:assert/strict";

import { EARLIER, estimateBodyTokens, fitHaikuBody, HAIKU_INPUT_BUDGET, LEFT_OUT, TRIM_STEP } from "../../../../../packages/tex/gateway/agent/promptBudget.js";

export default {
  id: "prompt-under-cliff",
  incident:
    "2026-11-24: 368 of 1,047 front-door rounds (2026-11-19 to 11-24) were trimmed, each cut worked out afresh so the stub line moved a message per text and the cached prefix was written again (cache writes p50 2.5K tokens 1:1, 28K group); the estimate ran 1.26 times low, so 206 trimmed calls still billed over 100,000. Before that, 2026-11-17, after the history caps shipped: 161 Haiku requests in three hours still went over 100,000 input tokens (average 125,800), from 1:1 threads on setups 54bad9c2e0f0 and d51546d21963. The average Haiku call stayed about 32,000 tokens.",
  cause:
    "The cut was recomputed every round from the untrimmed body, at 3.5 characters a token. Before that: the caps bound the week's transcript only. A 1:1 stretch replays tool results whole, up to 64,000 characters each, outside those caps, and Haiku charges five times past 100,000 tokens.",
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
    // 200,000 characters: a page that fits on its own at the measured 2.68 characters a token.
    const keptPage = "The lease says the deposit is one month. ".repeat(5_000);
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

    // The next text in the chat finds the same cut, so the cache reads the whole round it just wrote.
    const next = { ...round, messages: [...round.messages, { role: "assistant", content: [{ type: "text", text: "One month." }] }, { role: "user", content: [{ type: "text", text: "and the pet fee?" }] }] };
    const again = fitHaikuBody(next);
    assert.ok(again.after <= HAIKU_INPUT_BUDGET);
    assert.equal(JSON.stringify(again.body.messages.slice(0, 3)), JSON.stringify(kept.body.messages));
    assert.ok(kept.after <= HAIKU_INPUT_BUDGET - TRIM_STEP + (kept.before - HAIKU_INPUT_BUDGET) % TRIM_STEP, "cut a step under the budget");
  },
};
