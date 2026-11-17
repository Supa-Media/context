/**
 * A HAIKU CALL STAYS UNDER 100,000 TOKENS (`src/agent/promptBudget.js`).
 *
 * The history caps do not cover a stretch's tool results. These checks show a
 * result larger than the cliff is stubbed, the newest message is kept until
 * the older results are gone, and a body that already fits is not rewritten.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EARLIER, estimateBodyTokens, fitHaikuBody, HAIKU_INPUT_BUDGET, LEFT_OUT } from "../src/agent/promptBudget.js";

const system = [{ type: "text", text: "You are Tex." }];
const tools = [{ name: "fetch", description: "Read a note.", input_schema: { type: "object" } }];

function body(messages) {
  return { model: "claude-haiku-5-5", system, tools, messages };
}

test("a body under the budget is returned as it is", () => {
  const sent = body([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  const fit = fitHaikuBody(sent);
  assert.equal(fit.shed, 0);
  assert.equal(fit.body, sent);
  assert.ok(fit.before < HAIKU_INPUT_BUDGET);
});

test("oldest tool results are stubbed until a Haiku call is under the cliff, and the newest text stays", () => {
  const page = "x".repeat(400_000);
  const sent = body([
    { role: "user", content: [{ type: "text", text: "what does the lease say" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "fetch", input: { id: "lease" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: page }],
    },
    { role: "user", content: [{ type: "text", text: "and the deposit?" }] },
  ]);
  assert.ok(estimateBodyTokens(sent) > 100_000);
  const fit = fitHaikuBody(sent);
  assert.ok(fit.shed >= 1);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after} tokens`);
  assert.equal(fit.body.messages[2].content[0].content, LEFT_OUT);
  assert.equal(fit.body.messages[3].content[0].text, "and the deposit?");
  assert.equal(fit.body.system[0].text, "You are Tex.");
});

test("older history is stubbed when there is no tool result, and a system prompt that is the whole cliff is shortened", () => {
  const page = "x".repeat(400_000);
  const history = body([
    { role: "user", content: [{ type: "text", text: page }] },
    { role: "user", content: [{ type: "text", text: "and the deposit?" }] },
  ]);
  const fit = fitHaikuBody(history);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `history still ${fit.after}`);
  assert.equal(fit.body.messages[0].content[0].text, EARLIER);
  assert.equal(fit.body.messages[1].content[0].text, "and the deposit?");

  const huge = body([{ role: "user", content: [{ type: "text", text: "and the deposit?" }] }]);
  huge.system = [{ type: "text", text: "s".repeat(500_000) }];
  const cut = fitHaikuBody(huge);
  assert.ok(cut.after <= HAIKU_INPUT_BUDGET, `system still ${cut.after}`);
  assert.equal(cut.body.messages[0].content[0].text, "and the deposit?");
  assert.ok(cut.body.system[0].text.length < 500_000);
});
