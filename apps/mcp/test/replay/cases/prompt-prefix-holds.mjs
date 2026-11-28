import assert from "node:assert/strict";

import { fitHaikuBody, HAIKU_INPUT_BUDGET, PREFIX_CAP, TRIM_STEP, estimateBodyTokens } from "../../../../../packages/tex/gateway/agent/promptBudget.js";

export default {
  id: "prompt-prefix-holds",
  incident:
    "2026-11-27, app 1:1 turns 9ae6ce44, 447ed548 and ecb7d8b9: every round ran on haiku-5-5 with one payer, yet partway through each turn the stable system block's fingerprint changed and that round read 0 to 37,000 from the cache and wrote 32,000 to 92,000 again (447ed548 round 5: 0 read, 84,495 written, 6.4 s; ecb7d8b9 missed twice, rounds 5 and 7).",
  cause:
    "The Haiku trim (`promptBudget.js` `fitHaikuBody`) clipped the longest text to reach each step, and the 215,706-character stable block is always the longest: each tool round that took the body into a higher step halved it once more, so its bytes changed mid-turn and everything cached after them was written again.",
  path: "1:1 text",
  async run() {
    const stable = "s".repeat(215_706);
    const context = "c".repeat(30_313);
    const description = "d".repeat(96_614);
    const ask = "send this folder to the pablo bot";
    const history = [
      { role: "user", content: [{ type: "text", text: `Thu 9:06 AM: ${"h".repeat(20_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
    ];
    const messages = [...history, { role: "user", content: [{ type: "text", text: "p".repeat(37_890) }, { type: "text", text: ask }] }];
    const stables = new Set();
    const steps = new Set();
    for (let round = 1; round <= 8; round += 1) {
      const sent = { model: "claude-haiku-5-5", system: [{ type: "text", text: stable }, { type: "text", text: context }], tools: [{ name: "fetch", description, input_schema: { type: "object" } }], messages: JSON.parse(JSON.stringify(messages)) };
      const fit = fitHaikuBody(sent, { turnFrom: history.length });
      assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `round ${round}: still ${fit.after}`);
      assert.equal(fit.body.messages[history.length].content[1].text, ask, `round ${round}: the person's words are sent`);
      assert.ok(estimateBodyTokens({ system: fit.body.system, tools: fit.body.tools, messages: [] }) <= PREFIX_CAP, `round ${round}: the prefix is under its cap`);
      steps.add(Math.ceil((fit.before - HAIKU_INPUT_BUDGET) / TRIM_STEP));
      stables.add(fit.body.system[0].text);
      messages.push(
        { role: "assistant", content: [{ type: "tool_use", id: `toolu_${round}`, name: "fetch", input: { id: `n${round}` } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${round}`, content: "r".repeat(22_000) }] },
      );
    }
    assert.ok(steps.size >= 3, "the turn crosses several steps");
    assert.equal(stables.size, 1, "the stable block is sent the same in every round, so each round reads it from the cache");
  },
};
