import assert from "node:assert/strict";

import { EARLIER, estimateBodyTokens, fitHaikuBody, HAIKU_INPUT_BUDGET, LEFT_OUT, PREFIX_CAP, TRIM_STEP } from "../../../../../packages/tex/gateway/agent/promptBudget.js";

export default {
  id: "prompt-under-cliff",
  incident:
    "2026-11-27, app 1:1 turns 9ae6ce44, 447ed548 and ecb7d8b9: every round on haiku-5-5 with one payer, yet partway through each turn the stable system block's fingerprint changed and that round read 0 to 37,000 from the cache and wrote 32,000 to 92,000 again (447ed548 round 5: 0 read, 84,495 written, 6.4 s; ecb7d8b9 twice). 2026-11-26: in Lab test chats, 3 of 3 texts that made a tool call lost the person's text in round 2 (round 2 cut from 144,860 to 61,534 estimated tokens), and the front door asked them to resend. 2026-11-24: 368 of 1,047 front-door rounds (2026-11-19 to 11-24) were trimmed, each cut worked out afresh so the stub line moved a message per text and the cached prefix was written again (cache writes p50 2.5K tokens 1:1, 28K group); the estimate ran 1.26 times low, so 206 trimmed calls still billed over 100,000. Before that, 2026-11-17, after the history caps shipped: 161 Haiku requests in three hours still went over 100,000 input tokens (average 125,800), from 1:1 threads on setups 54bad9c2e0f0 and d51546d21963. The average Haiku call stayed about 32,000 tokens.",
  cause:
    "11-27: the clip of the longest text always found the 215,706-character stable block, so each tool round that took the body into a higher step halved it once more and its bytes changed mid-turn. 11-26: the tool answers took the body into the next step, and with only the newest message kept the ask's message was cut as older history. 11-24: the cut was recomputed every round from the untrimmed body, at 3.5 characters a token. Before that: the caps bound the week's transcript only. A 1:1 stretch replays tool results whole, up to 64,000 characters each, outside those caps, and Haiku charges five times past 100,000 tokens.",
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

    // 2026-11-26, Lab test chats: a tool round that took the body into the next step cut the person's ask (its
    // preamble and their words) and this round's answers as older history, before a clip of the system prompt
    // that was the real overflow; the front door answered "I only see placeholders". The turn is never older history.
    const ask = "never mind that. what's on my calendar tomorrow, and what did I last write about Togather?";
    const sent = {
      model: "claude-haiku-5-5",
      system: [{ type: "text", text: "s".repeat(215_706) }, { type: "text", text: "c".repeat(30_313) }],
      tools: [{ name: "fetch", description: "d".repeat(96_614), input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Thu 9:06 AM: yeah that was me" }] },
        { role: "assistant", content: [{ type: "text", text: "got it" }] },
        { role: "user", content: [{ type: "text", text: "p".repeat(37_890) }, { type: "text", text: ask }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_cal", name: "read_calendar", input: {} }, { type: "tool_use", id: "toolu_find", name: "search_notes", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cal", content: "c".repeat(3_834) }, { type: "tool_result", tool_use_id: "toolu_find", content: "t".repeat(3_800) }] },
      ],
    };
    const turn = fitHaikuBody(sent, { turnFrom: 2 }); // the ask, just past the cached history (`aiGateway.js`)
    assert.ok(turn.after <= HAIKU_INPUT_BUDGET);
    assert.equal(turn.body.messages[2].content[0].text.length, 37_890, "the preamble is sent whole");
    assert.equal(turn.body.messages[2].content[1].text, ask, "the person's words are sent");
    for (const block of turn.body.messages[4].content) assert.notEqual(block.content, LEFT_OUT, "this round's answers are sent");
    // 2026-11-27: a turn whose tool rounds cross step after step sends one stable block, cut from its end, every round.
    const persona = "You are Tex. Rules: never guess anyone's pronouns.\n";
    const stableBlock = persona + `${"s".repeat(99)}\n`.repeat(2_157);
    const contextBlock = "c".repeat(30_313);
    const toolWords = "d".repeat(96_614);
    const pabloAsk = "send this folder to the pablo bot";
    const pabloHistory = [
      { role: "user", content: [{ type: "text", text: `Thu 9:06 AM: ${"h".repeat(20_000)}` }] },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
    ];
    const turnMessages = [...pabloHistory, { role: "user", content: [{ type: "text", text: "p".repeat(37_890) }, { type: "text", text: pabloAsk }] }];
    const stables = new Set();
    const steps = new Set();
    for (let round = 1; round <= 8; round += 1) {
      const roundBody = { model: "claude-haiku-5-5", system: [{ type: "text", text: stableBlock }, { type: "text", text: contextBlock }], tools: [{ name: "fetch", description: toolWords, input_schema: { type: "object" } }], messages: JSON.parse(JSON.stringify(turnMessages)) };
      const fitted = fitHaikuBody(roundBody, { turnFrom: pabloHistory.length });
      assert.ok(fitted.after <= HAIKU_INPUT_BUDGET, `round ${round}: still ${fitted.after}`);
      assert.equal(fitted.body.messages[pabloHistory.length].content[1].text, pabloAsk, `round ${round}: the person's words are sent`);
      assert.ok(estimateBodyTokens({ system: fitted.body.system, tools: fitted.body.tools, messages: [] }) <= PREFIX_CAP, `round ${round}: the prefix is under its cap`);
      steps.add(Math.ceil((fitted.before - HAIKU_INPUT_BUDGET) / TRIM_STEP));
      stables.add(fitted.body.system[0].text);
      assert.ok(fitted.body.system[0].text.startsWith(persona), `round ${round}: the setup's start is kept`);
      turnMessages.push(
        { role: "assistant", content: [{ type: "tool_use", id: `toolu_${round}`, name: "fetch", input: { id: `n${round}` } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${round}`, content: "r".repeat(22_000) }] },
      );
    }
    assert.ok(steps.size >= 3, "the turn crosses several steps");
    assert.equal(stables.size, 1, "the stable block is sent the same in every round, so each round reads it from the cache");
  },
};
