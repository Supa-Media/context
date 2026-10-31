/**
 * OPUS PLANS, HAIKU DRIVES (the owner, 2026-10-17: "Opus does the thinking,
 * Haiku executes the task … a target percentage of, like, 20% Opus, 80%
 * Haiku").
 *
 * A setup's `models.think_rounds` (`production.js`) runs the first rounds of a
 * text the router sent to `think` on the thinking model and the rest on
 * `main`; a round after a failed call goes back to `think` once; a call held
 * for the person's yes is not a failure. Each round's model is in the trace,
 * and what each model spent is kept apart so a mixed turn is priced right.
 *
 * Driven through `runTurn` with a scripted AI gateway (`fetchImpl`) and a
 * scripted router, so the model each round was sent to is what is asserted.
 *
 * ## Sabotage record
 *
 *   `modelForRound` ignoring `escalate`
 *     → "a failed call sends the next round to think, once" fails
 *   `failedCall` counting a held call as failed
 *     → "a call held for the person's yes does not escalate" fails
 *   `runTurn` not switching to `main` after the planning rounds
 *     → "think_rounds 1: round 0 plans on think, every later round drives on main" fails
 *   `runTurn` keeping the planner's thinking blocks on a switch
 *     → "the switch drops the planner's thinking and re-tells the model who it is" fails
 *   `runTurn` booking every round's usage to `main`
 *     → "per-model usage adds up to the turn's total, and the meter gets one
 *       report per model" fails (and two more)
 *   `runTurn` keeping the plan after the fallback took over
 *     → "the fallback still takes over mid-plan, and the turn stays on it"
 *       fails (before the fallback was made once-a-turn, this looped forever)
 *   `systemFor` leaving out the planner and driver lines
 *     → "the planner is told to write its plan in words, and the driver that
 *       those words are its plan" fails (applied and observed, 2026-10-18)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { meterParts, modelForRound, thinkRoundsFor } from "../src/agent/modelPlan.js";
import { parseSetup } from "../src/agent/production.js";
import { runTurn } from "../src/agent/turn.js";
import { priceUsd, runPriceUsd } from "../bench/report.mjs";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const WIRE = { "claude-haiku-5-5": HAIKU, "claude-opus-5-5": OPUS };

const thought = (n) => ({ type: "thinking", thinking: "", signature: `sig-${n}` });
const call = (n, name = "read_note") => ({ type: "tool_use", id: `t${n}`, name, input: { path: `${n}.md` } });
const reply = (blocks, stop, usage) => ({ id: "msg", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage });

/**
 * A gateway that answers each round from `rounds` in order, and records which
 * model it was asked for. Opus spends 100 in and 10 out a round, Haiku 1000
 * in and 50 out, so a mixed turn's sums say which model each round was.
 */
function scripted(rounds) {
  const queue = [...rounds];
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const usage = WIRE[body.model] === OPUS ? { input_tokens: 100, output_tokens: 10 } : { input_tokens: 1000, output_tokens: 50 };
    const next = queue.shift();
    if (!next) throw new Error("the script ran out");
    return new Response(JSON.stringify(reply(next.blocks, next.stop, usage)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { bodies, fetchImpl, models: () => bodies.map((body) => WIRE[body.model] ?? body.model) };
}

const tools = (n) => ({ blocks: [thought(n), call(n)], stop: "tool_use" });
const answer = (text = "Done.") => ({ blocks: [{ type: "text", text }], stop: "end_turn" });
const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
const router = (extra = {}, choice = "think") => ({ decide: async () => ({ tier: { choice, confidence: 0.9 } }), think: OPUS, ...extra });

async function turn(fetchImpl, extra = {}) {
  resetCreditState();
  return await runTurn({
    question: "book the 7pm table on the restaurant's site",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [tool("read_note")],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    ...extra,
  });
}

const modelRounds = (result) => result.timing.trace.filter((entry) => entry.kind === "model").map((entry) => entry.model);

test("without think_rounds, a text routed to think stays on think for the whole turn, as before", async () => {
  const gw = scripted([tools(1), tools(2), answer()]);
  const result = await turn(gw.fetchImpl, { router: router() });
  assert.deepEqual(gw.models(), [OPUS, OPUS, OPUS]);
  assert.equal(result.model, OPUS);
  assert.deepEqual(Object.keys(result.usageByModel), [OPUS]);
  assert.deepEqual(modelRounds(result), [OPUS, OPUS, OPUS], "each model round says which model ran it");
});

test("think_rounds 1: round 0 plans on think, every later round drives on main", async () => {
  const gw = scripted([tools(1), tools(2), tools(3), answer("Booked for 7pm.")]);
  const result = await turn(gw.fetchImpl, { router: router({ thinkRounds: 1 }) });
  assert.deepEqual(gw.models(), [OPUS, HAIKU, HAIKU, HAIKU]);
  assert.equal(result.answer, "Booked for 7pm.");
  assert.equal(result.model, HAIKU, "the model that wrote the answer");
  assert.deepEqual(modelRounds(result), [OPUS, HAIKU, HAIKU, HAIKU]);
});

test("think_rounds 2 plans for two rounds before main drives", async () => {
  const gw = scripted([tools(1), tools(2), tools(3), answer()]);
  await turn(gw.fetchImpl, { router: router({ thinkRounds: 2 }) });
  assert.deepEqual(gw.models(), [OPUS, OPUS, HAIKU, HAIKU]);
});

test("a text the router keeps on main never touches think, think_rounds or not", async () => {
  const gw = scripted([tools(1), answer()]);
  const result = await turn(gw.fetchImpl, { router: router({ thinkRounds: 1 }, "lookup") });
  assert.deepEqual(gw.models(), [HAIKU, HAIKU]);
  assert.deepEqual(Object.keys(result.usageByModel), [HAIKU]);
});

test("the switch drops the planner's thinking and re-tells the model who it is", async () => {
  const gw = scripted([tools(1), tools(2), answer()]);
  await turn(gw.fetchImpl, { router: router({ thinkRounds: 1 }) });
  const planned = gw.bodies[1].messages.find((message) => message.role === "assistant");
  assert.ok(!planned.content.some((block) => block.type === "thinking"), "Haiku is not handed Opus's thinking");
  assert.ok(planned.content.some((block) => block.type === "tool_use"), "but it sees the calls Opus made");
  // The model line and the plan's words are said in the person's turn (`turn.js`): the whole request is read, minus its `model` field.
  const systemText = (body) => JSON.stringify({ ...body, model: undefined });
  assert.match(systemText(gw.bodies[0]), /claude-opus-5-5/);
  assert.match(systemText(gw.bodies[1]), /claude-haiku-5-5/);
  // Haiku's own thinking rides along between its own rounds, as on any turn.
  const driven = gw.bodies[2].messages.filter((message) => message.role === "assistant");
  assert.ok(driven.at(-1).content.some((block) => block.type === "thinking"), "the driver keeps its own thinking");
});

test("a failed call sends the next round to think, once, then main drives again", async () => {
  const gw = scripted([tools(1), tools(2), tools(3), tools(4), answer()]);
  let n = 0;
  const result = await turn(gw.fetchImpl, {
    router: router({ thinkRounds: 1 }),
    callTool: async () => {
      n += 1;
      // The second call (Haiku's first) fails.
      return n === 2 ? { content: [{ type: "text", text: "no such element" }], isError: true } : { content: [{ type: "text", text: "ok" }] };
    },
  });
  assert.deepEqual(gw.models(), [OPUS, HAIKU, OPUS, HAIKU, HAIKU]);
  assert.deepEqual(modelRounds(result), [OPUS, HAIKU, OPUS, HAIKU, HAIKU]);
});

test("a call held for the person's yes does not escalate", async () => {
  const gw = scripted([tools(1), tools(2), answer()]);
  let n = 0;
  await turn(gw.fetchImpl, {
    router: router({ thinkRounds: 1 }),
    callTool: async () => {
      n += 1;
      return n === 2 ? { content: [{ type: "text", text: "Held for their OK." }], isError: true, held: true } : { content: [{ type: "text", text: "ok" }] };
    },
  });
  assert.deepEqual(gw.models(), [OPUS, HAIKU, HAIKU]);
});

test("per-model usage adds up to the turn's total, and the meter gets one report per model", async () => {
  const gw = scripted([tools(1), tools(2), tools(3), answer()]);
  const result = await turn(gw.fetchImpl, { router: router({ thinkRounds: 1 }) });
  assert.deepEqual(result.usageByModel[OPUS], { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(result.usageByModel[HAIKU], { input: 3000, output: 150, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.usage.input, 3100);
  assert.equal(result.usage.output, 160);
  const parts = meterParts(result);
  assert.deepEqual(parts.map((part) => part.model), [OPUS, HAIKU], "the answering model is reported last");
  assert.deepEqual(parts.map((part) => part.whole), [false, true], "the turn's own counts ride on one report");
  assert.equal(parts.reduce((sum, part) => sum + part.input, 0), result.usage.input);
  // Priced by model, not all at the answering model's rate.
  const mixed = runPriceUsd({ model: result.model, usage: result.usage, usageByModel: result.usageByModel });
  const expected = priceUsd(OPUS, result.usageByModel[OPUS]) + priceUsd(HAIKU, result.usageByModel[HAIKU]);
  assert.ok(Math.abs(mixed - expected) < 1e-12, `${mixed} vs ${expected}`);
  assert.notEqual(mixed, priceUsd(HAIKU, result.usage), "a mixed turn is not priced as all Haiku");
});

test("a turn on one model meters exactly as before: one report, everything on it", () => {
  const parts = meterParts({ model: HAIKU, usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, decision: 7 } });
  assert.deepEqual(parts, [{ model: HAIKU, input: 5, output: 2, cacheRead: 1, cacheWrite: 0, decision: 7, whole: true }]);
  const routed = meterParts({ model: OPUS, usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, decision: 7 }, usageByModel: { [OPUS]: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } } });
  assert.deepEqual(routed, [{ model: OPUS, input: 5, output: 2, cacheRead: 0, cacheWrite: 0, decision: 7, whole: true }]);
});

test("the fallback still takes over mid-plan, and the turn stays on it", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(model);
      if (model === "@cf/acme/main") throw new Error("upstream said no");
      const toolCall = calls.length < 4 ? [{ id: `c${calls.length}`, type: "function", function: { name: "read_note", arguments: "{}" } }] : [];
      return { choices: [{ message: { content: toolCall.length ? "" : "From the spare.", tool_calls: toolCall }, finish_reason: toolCall.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    },
  };
  resetCreditState();
  const result = await runTurn({
    question: "book it",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [tool("read_note")],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    builtinModelOverride: "@cf/acme/main",
    router: { decide: async () => ({ tier: { choice: "think", confidence: 0.9 } }), think: "@cf/acme/think", thinkRounds: 1 },
    fallback: "@cf/acme/spare",
  });
  // Round 0 plans on think; round 1 would drive on main, which fails, so the
  // spare answers that round and every one after it.
  assert.deepEqual(calls, ["@cf/acme/think", "@cf/acme/main", "@cf/acme/spare", "@cf/acme/spare"]);
  assert.equal(result.answer, "From the spare.");
  assert.equal(result.model, "@cf/acme/spare");
  assert.deepEqual(Object.keys(result.usageByModel).sort(), ["@cf/acme/spare", "@cf/acme/think"]);
});

test("thinkRoundsFor and modelForRound: a plan only for a think pick with think_rounds", () => {
  assert.equal(thinkRoundsFor(null, "think", HAIKU), null);
  assert.equal(thinkRoundsFor({ think: OPUS }, "think", HAIKU), null, "no think_rounds: the whole turn on think");
  assert.equal(thinkRoundsFor({ think: OPUS, thinkRounds: 1 }, "main", HAIKU), null);
  const plan = thinkRoundsFor({ think: OPUS, thinkRounds: 2 }, "think", HAIKU);
  assert.deepEqual(plan, { think: OPUS, main: HAIKU, rounds: 2 });
  assert.deepEqual([0, 1, 2, 3].map((round) => modelForRound(plan, round, false).model), [OPUS, OPUS, HAIKU, HAIKU]);
  assert.deepEqual(modelForRound(plan, 3, true), { model: OPUS, reason: "escalated" });
});

/* ---------------- the setup file: `models.think_rounds` (`production.js`) ---------------- */

const ROUTED = `models:\n  main: ${HAIKU}\n  router: "@cf/cloudflare/clef"\n  think: ${OPUS}`;
const file = (models) => `---\njob: texting-assistant\n${models}\n---\n\nYou are Tex.\n`;

test("parseSetup reads think_rounds 1 to 9 with a router, and leaves it off when absent", async () => {
  for (const n of [1, 5, 9]) {
    const setup = await parseSetup(file(`${ROUTED}\n  think_rounds: ${n}`));
    assert.equal(setup?.router?.thinkRounds, n, String(n));
  }
  const plain = await parseSetup(file(ROUTED));
  assert.ok(plain && !("thinkRounds" in plain.router), "absent means the whole turn on the picked model");
});

test("parseSetup refuses think_rounds without a router, or that is not a whole number 1 to 9", async () => {
  assert.equal(await parseSetup(file(`models:\n  main: ${HAIKU}\n  think_rounds: 1`)), null, "no router: nothing to plan for");
  for (const bad of ["0", "10", "-1", "1.5", "two", "", "01", "[1]"]) {
    assert.equal(await parseSetup(file(`${ROUTED}\n  think_rounds: ${bad}`)), null, JSON.stringify(bad));
  }
});

test("the planner is told to write its plan in words, and the driver that those words are its plan", async () => {
  const gw = scripted([tools(1), tools(2), answer()]);
  await turn(gw.fetchImpl, { router: router({ thinkRounds: 1 }) });
  const systemText = (body) => JSON.stringify({ ...body, model: undefined });
  assert.match(systemText(gw.bodies[0]), /write the plan in a few short lines/, "Opus plans in words Haiku can read");
  assert.doesNotMatch(systemText(gw.bodies[0]), /its plan is in its words above/);
  assert.match(systemText(gw.bodies[1]), /its plan is in its words above/, "Haiku is told the plan is there");
  assert.doesNotMatch(systemText(gw.bodies[1]), /write the plan in a few short lines/);
});

test("a turn with no plan carries neither line", async () => {
  const gw = scripted([tools(1), answer()]);
  await turn(gw.fetchImpl, { router: router() });
  for (const body of gw.bodies) assert.doesNotMatch(JSON.stringify({ ...body, model: undefined }), /write the plan|its plan is in its words/);
});

test("a background job plans on think and drives on main without asking the router", async () => {
  const gw = scripted([tools(1), tools(2), answer("Wrote it.")]);
  let asked = 0;
  const lookup = { decide: async () => (asked++, { tier: { choice: "lookup", confidence: 0.9 } }), think: OPUS, thinkRounds: 1 };
  await turn(gw.fetchImpl, { router: lookup, planned: true });
  assert.deepEqual(gw.models(), [OPUS, HAIKU, HAIKU]);
  assert.equal(asked, 0);
});
