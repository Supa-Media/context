/**
 * TEX ASKS ITS ADVISOR (`src/agent/advisor.js`; the Tex Devs meeting,
 * 2026-10-30). The everyday model answers every text and may call a stronger
 * model with `send { action: "advisor" }`. Modelled on Anthropic's advisor
 * tool (Dev2, 2026-10-31): it is called with no input and reads the whole
 * turn so far itself (Tex's instructions, its tools, the conversation, every
 * tool call and result), answers the everyday model (never the person),
 * holds no tools, may decline, is metered under its own model, and is asked
 * at most MAX_ASKS times a turn, a limit the everyday model is never told.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `tools: []` dropped from the advisor's request (it inherits nothing, so
 *    the request carries no tools key): "holds no tools" fails;
 *  - `MAX_ASKS` check removed from `call`: "at most MAX_ASKS a turn, never naming the limit" fails;
 *  - `turn.js` calling a local tool without the live turn: "end to end: ... the advisor reads the tool results" fails;
 *  - `messageLine` dropping `role: "tool"` messages: "with the live turn it reads Tex's instructions ..." fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ADVISOR_DEFINITION, ADVISOR_PROMPT, ADVISOR_TOOL, MAX_ASKS, advisorTools } from "../src/agent/advisor.js";
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

test("without a live turn it reads the earlier texts and the question, holds no tools, and answers the everyday model", async () => {
  const { entry, asked, metered } = advisor();
  const result = await entry.call({});
  assert.equal(result.content[0].text, "Book the cheaper flight; keep $200 back.");
  assert.equal(result.isError, undefined);
  const [params] = asked;
  assert.equal(params.model, OPUS);
  assert.equal(params.system, ADVISOR_PROMPT);
  assert.deepEqual(params.tools, [], "holds no tools");
  assert.equal(params.effort, "high");
  assert.deepEqual(params.messages.map((message) => message.role), ["user"], "one text holding the whole turn");
  assert.match(params.messages[0].text, /Them: what's my lisbon fund at\n\nTex: \$1,240 of \$2,000\.\n\nThem: should I book lisbon now or wait/);
  // Metered under its own model, as a part (never the turn's whole).
  assert.deepEqual(metered, [[{ input: 900, output: 40 }, false, OPUS, false]]);
});

test("with the live turn it reads Tex's instructions, its tools, and every call and result, and needs no input", async () => {
  assert.deepEqual(ADVISOR_DEFINITION.inputSchema, { type: "object", properties: {} });
  const { entry, asked } = advisor();
  await entry.call({}, {
    system: "You are Tex.",
    tools: [{ name: "read_note" }, { name: ADVISOR_TOOL }],
    messages: [
      { role: "user", text: "fill in my profile" },
      { role: "assistant", text: "Reading your resume.", toolCalls: [{ id: "c1", name: "read_note", args: { path: "tex/resume.md" } }] },
      { role: "tool", id: "c1", name: "read_note", text: "Headline: Staff engineer." },
      { role: "tool", id: "c2", name: "browse", text: "Timed out.", isError: true },
    ],
  });
  const said = asked[0].messages[0].text;
  assert.match(said, /<tex_instructions>\nYou are Tex\.\n<\/tex_instructions>/);
  assert.match(said, /<tex_tools>read_note<\/tex_tools>/, "its own tool isn't listed");
  assert.match(said, /Tex: Reading your resume\.\n\[Tex calls read_note \{"path":"tex\/resume\.md"\}\]/);
  assert.match(said, /\[result of read_note\]\nHeadline: Staff engineer\./);
  assert.match(said, /\[result of browse, failed\]\nTimed out\./);
});

test("a decline comes back as words for the everyday model to act on", async () => {
  const { entry } = advisor({ answers: [{ text: "Decline: it's a lookup, read lisbon-fund.md." }] });
  const result = await entry.call({});
  assert.match(result.content[0].text, /^Decline:/);
  assert.match(ADVISOR_PROMPT, /"Decline:"/);
});

test("at most MAX_ASKS a turn, never naming the limit", async () => {
  const { entry, asked } = advisor();
  for (let i = 0; i < MAX_ASKS; i += 1) assert.equal((await entry.call({})).isError, undefined);
  const third = await entry.call({});
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /Answer with what you have/);
  assert.doesNotMatch(third.content[0].text, /\d|times|limit|budget/, "the everyday model is never told how many asks it gets");
  assert.equal(asked.length, MAX_ASKS);
  assert.equal(MAX_ASKS, 10);
});

test("an advisor that can't be reached is told as such, and metered as a failure", async () => {
  const { entry, metered } = advisor({ fail: true });
  const result = await entry.call({});
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

test("end to end: Haiku reads a note, asks through send with no input, the advisor reads the tool results, Haiku answers", async () => {
  const ENV = { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "context-gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` };
  const models = [];
  const bodies = [];
  const reply = (content, stop) => ({ id: "m", type: "message", role: "assistant", content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
  const script = [
    reply([{ type: "tool_use", id: "t0", name: "read_note", input: { path: "lisbon-fund.md" } }], "tool_use"),
    reply([{ type: "tool_use", id: "t1", name: "send", input: { action: "advisor", args: {} } }], "tool_use"),
    reply([{ type: "text", text: "Wait for December." }], "end_turn"),
    reply([{ type: "text", text: "I'd wait for December's fares." }], "end_turn"),
  ];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    bodies.push(JSON.stringify(body));
    return new Response(JSON.stringify(script.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const providerOptions = { gateway: aiGatewayConfig(ENV), fetchImpl };
  const { requestBuiltin } = await import("../src/agent/builtin.js");
  const local = advisorTools({ model: OPUS, history: [], question: "should I book lisbon now", request: (params) => requestBuiltin(params, undefined, providerOptions) });
  resetCreditState();
  const result = await runTurn({
    question: "should I book lisbon now",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [{ name: "read_note", description: "Read a note.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    local,
    callTool: async () => ({ content: [{ type: "text", text: "Fund is $1,240; flights $640 now." }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions,
    builtinModelOverride: HAIKU,
  });
  assert.deepEqual(models, ["claude-haiku-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  assert.match(bodies[2], /result of read_note[^"]*Fund is \$1,240; flights \$640 now\./, "the advisor reads the tool results");
  assert.doesNotMatch(bodies[2], /"tools"/, "and holds no tools");
  assert.equal(result.answer, "I'd wait for December's fares.");
  assert.deepEqual(result.steps.map((step) => [step.tool, step.ok]), [["read_note", true], [ADVISOR_TOOL, true]]);
});
