/**
 * TEX ASKS ITS ADVISOR (`src/agent/advisor.js`; the Tex Devs meeting,
 * 2026-10-30). The everyday model answers every text and may call a stronger
 * model with `send { action: "advisor" }`. The advisor reads the earlier texts,
 * the question and the everyday model's brief, answers the everyday model
 * (never the person), holds no tools, may decline, is metered under its own
 * model, and is asked at most twice a turn.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `tools: []` dropped from the advisor's request (it inherits nothing, so
 *    the request carries no tools key): "holds no tools" fails;
 *  - `MAX_ASKS` check removed from `call`: "at most twice a turn" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ADVISOR_PROMPT, ADVISOR_TOOL, MAX_ASKS, advisorTools } from "../src/agent/advisor.js";
import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { runTurn } from "../src/agent/turn.js";

const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const history = [
  { role: "user", text: "what's my lisbon fund at" },
  { role: "assistant", text: "$1,240 of $2,000." },
];

function advisor({ answers = [{ text: "Book the cheaper flight; keep $200 back.", usage: { input: 900, output: 40 } }], fail = false } = {}) {
  const asked = [];
  const metered = [];
  const [entry] = advisorTools({
    model: OPUS,
    effort: "high",
    history,
    question: "should I book lisbon now or wait",
    request: async (params) => {
      asked.push(params);
      if (fail) throw new Error("down");
      return answers[Math.min(asked.length - 1, answers.length - 1)];
    },
    meter: async (...args) => void metered.push(args),
  });
  return { entry, asked, metered };
}

test("offered only when the setup names an advisor this deployment can call", () => {
  assert.deepEqual(advisorTools({ model: null, history, question: "q", request: async () => ({}) }), []);
  assert.deepEqual(advisorTools({ model: OPUS, history, question: "q" }), []);
  assert.equal(advisor().entry.tool.name, ADVISOR_TOOL);
});

test("it reads the earlier texts, the question and the brief, holds no tools, and answers the everyday model", async () => {
  const { entry, asked, metered } = advisor();
  const result = await entry.call({ question: "Book now or wait?", brief: "Fund is $1,240; flights $640 now, maybe $560 in December." });
  assert.equal(result.content[0].text, "Book the cheaper flight; keep $200 back.");
  assert.equal(result.isError, undefined);
  const [params] = asked;
  assert.equal(params.model, OPUS);
  assert.equal(params.system, ADVISOR_PROMPT);
  assert.deepEqual(params.tools, [], "holds no tools");
  assert.equal(params.effort, "high");
  assert.deepEqual(params.messages.map((message) => message.role), ["user", "assistant", "user"], "the provider gets alternating turns");
  assert.match(params.messages.at(-1).text, /should I book lisbon now or wait\n\nTex asks you: Book now or wait\?\n\nWhat Tex found and tried:\nFund is \$1,240/);
  // Metered under its own model, as a part (never the turn's whole).
  assert.deepEqual(metered, [[{ input: 900, output: 40 }, false, OPUS, false]]);
});

test("a decline comes back as words for the everyday model to act on", async () => {
  const { entry } = advisor({ answers: [{ text: "Decline: it's a lookup, read lisbon-fund.md." }] });
  const result = await entry.call({ question: "What's the fund at?" });
  assert.match(result.content[0].text, /^Decline:/);
  assert.match(ADVISOR_PROMPT, /"Decline:"/);
});

test("at most twice a turn, and nothing asked without a question", async () => {
  const { entry, asked } = advisor();
  assert.equal((await entry.call({ question: " " })).isError, true);
  for (let i = 0; i < MAX_ASKS; i += 1) assert.equal((await entry.call({ question: `ask ${i}` })).isError, undefined);
  const third = await entry.call({ question: "once more" });
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /Answer with what you have/);
  assert.equal(asked.length, MAX_ASKS);
});

test("an advisor that can't be reached is told as such, and metered as a failure", async () => {
  const { entry, metered } = advisor({ fail: true });
  const result = await entry.call({ question: "Book now?" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /couldn't be reached/);
  assert.deepEqual(metered, [[null, true, OPUS, false]]);
});

test("the six tools list it as send { action: advisor } only when it is held", () => {
  const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} } });
  const { entry } = advisor();
  const withIt = sixToolsOver([tool("read_note"), entry.tool]);
  assert.deepEqual(withIt.resolve("send", { action: "advisor", args: { question: "q" } }), { name: ADVISOR_TOOL, args: { question: "q" } });
  assert.match(JSON.stringify(withIt.tools.find((t) => t.name === "send")), /- advisor: Ask your advisor/);
  const without = sixToolsOver([tool("read_note"), tool("write_note")]);
  assert.match(without.resolve("send", { action: "advisor", args: {} }).error ?? "", /no action "advisor"/);
});

test("end to end: Haiku asks through send, Opus advises, Haiku answers", async () => {
  const ENV = { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "context-gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` };
  const models = [];
  const reply = (content, stop) => ({ id: "m", type: "message", role: "assistant", content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
  const script = [
    reply([{ type: "tool_use", id: "t1", name: "send", input: { action: "advisor", args: { question: "Book now or wait?", brief: "Fund $1,240." } } }], "tool_use"),
    reply([{ type: "text", text: "Wait for December." }], "end_turn"),
    reply([{ type: "text", text: "I'd wait for December's fares." }], "end_turn"),
  ];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    return new Response(JSON.stringify(script.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const providerOptions = { gateway: aiGatewayConfig(ENV), fetchImpl };
  const { requestBuiltin } = await import("../src/agent/builtin.js");
  const local = advisorTools({ model: OPUS, history: [], question: "should I book lisbon now", request: (params) => requestBuiltin(params, undefined, providerOptions) });
  resetCreditState();
  const result = await runTurn({
    question: "should I book lisbon now",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    local,
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions,
    builtinModelOverride: HAIKU,
  });
  assert.deepEqual(models, ["claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  assert.equal(result.answer, "I'd wait for December's fares.");
  assert.deepEqual(result.steps.map((step) => [step.tool, step.ok]), [[ADVISOR_TOOL, true]]);
});
