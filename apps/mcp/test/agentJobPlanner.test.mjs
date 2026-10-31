/**
 * OPUS PLANS A JOB, HAIKU CARRIES IT OUT, WITH NO ROUTER (the owner,
 * 2026-10-31, approving the slowdown diagnosis: production names no thinking
 * model, so every part of a background job ran on Haiku).
 *
 * The production setup moved to Haiku with an Opus advisor and dropped the
 * router (`haiku-advisor`, 2026-10-31). A setup may now name `models.think`
 * with `models.think_rounds` and no router (`production.js`): a background
 * job's turn (`planned`) plans on `think` for those rounds and drives on
 * `main`, and every other text stays on `main`, an opinion included, where
 * it asks the advisor when it needs judgment. Driven through `runTurn` with a
 * scripted AI gateway, so the model each round was sent to is what is asserted.
 *
 * ## Sabotage record
 *
 *   `turnRouter` returning null for a planner with no router
 *     → "a job's turn plans on think, then main drives" fails
 *   `runTurn` dropping the `jobsOnly` check (planning every text)
 *     → "an ordinary text stays on main" fails
 *   `runTurn` letting an opinion text plan without a router
 *     → "an opinion text stays on main too" fails
 *   `parse` accepting `think` with no router and no `think_rounds`
 *     → "parseSetup reads a planner ... and refuses one without think_rounds" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { turnRouter } from "../src/agent/modelPlan.js";
import { parseSetup } from "../src/agent/production.js";
import { modelLine } from "../src/agent/prompt.js";
import { runTurn } from "../src/agent/turn.js";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const WIRE = { "claude-haiku-5-5": HAIKU, "claude-opus-5-5": OPUS };

const call = (n) => ({ type: "tool_use", id: `t${n}`, name: "read_note", input: { path: `${n}.md` } });
const tools = (n) => ({ blocks: [call(n)], stop: "tool_use" });
const answer = (text = "Done.") => ({ blocks: [{ type: "text", text }], stop: "end_turn" });

function scripted(rounds) {
  const queue = [...rounds];
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(WIRE[body.model] ?? body.model);
    const next = queue.shift();
    if (!next) throw new Error("the script ran out");
    const reply = { id: "msg", type: "message", role: "assistant", content: next.blocks, stop_reason: next.stop, usage: { input_tokens: 10, output_tokens: 5 } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { asked, fetchImpl };
}

const file = (models) => `---\njob: texting-assistant\nmodels:\n${models}\n---\n\nYou are Tex.\n`;
const PLANNED = `  main: ${HAIKU}\n  think: ${OPUS}\n  think_rounds: 2\n  advisor: ${OPUS}\n  think_effort: high`;

async function turn(fetchImpl, { question = "find the Mercor application and fill it in", planned = false } = {}) {
  resetCreditState();
  const setup = await parseSetup(file(PLANNED));
  return await runTurn({
    question,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [{ name: "read_note", description: "read_note.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    texting: true,
    planned,
    router: turnRouter(setup, () => true, () => { throw new Error("a planner never makes a decision engine"); }),
  });
}

test("parseSetup reads a planner (think and think_rounds, no router), and refuses one without think_rounds", async () => {
  const setup = await parseSetup(file(PLANNED));
  assert.equal(setup?.router, null, "no router: nothing picks a tier per text");
  assert.deepEqual(setup?.planner, { think: OPUS, thinkRounds: 2 });
  assert.equal(setup?.efforts?.[OPUS], "high", "think_effort applies to the planner");
  assert.equal(await parseSetup(file(`  main: ${HAIKU}\n  think: ${OPUS}`)), null, "a bare think would put whole jobs on it");
  assert.equal(await parseSetup(file(`  main: ${HAIKU}\n  think: ${HAIKU}\n  think_rounds: 2`)), null, "planning on main is no plan");
  assert.equal(await parseSetup(file(`  main: ${HAIKU}\n  think: ${OPUS}\n  think_rounds: 2\n  route_at: 0.3`)), null, "a cutoff with no router routes nothing");
  assert.equal(await parseSetup(file(`  main: ${HAIKU}\n  think: ${OPUS}\n  think_rounds: 0`)), null);
  assert.equal((await parseSetup(file(`  main: ${HAIKU}\n  advisor: ${OPUS}`)))?.planner, null, "no think: no planner");
});

test("turnRouter: a router decides, a planner never does, and an uncallable think is neither", async () => {
  const routed = await parseSetup(file(`  main: ${HAIKU}\n  router: "@cf/cloudflare/clef"\n  think: ${OPUS}\n  think_rounds: 1`));
  const decide = async () => ({});
  assert.deepEqual(turnRouter(routed, () => true, () => decide), { decide, think: OPUS, routeAt: routed.router.routeAt, thinkRounds: 1 });
  const planner = await parseSetup(file(PLANNED));
  assert.deepEqual(turnRouter(planner, () => true, () => decide), { decide: null, think: OPUS, thinkRounds: 2, jobsOnly: true });
  assert.equal(turnRouter(planner, (name) => name !== OPUS, () => decide), null);
});

test("a job's turn plans on think, then main drives", async () => {
  const gw = scripted([tools(1), tools(2), tools(3), tools(4), answer("Submitted.")]);
  const result = await turn(gw.fetchImpl, { planned: true });
  assert.deepEqual(gw.asked, [OPUS, OPUS, HAIKU, HAIKU, HAIKU]);
  assert.equal(result.answer, "Submitted.");
  assert.deepEqual(Object.keys(result.usageByModel).sort(), [HAIKU, OPUS].sort(), "each model's spend kept apart, for the meter");
});

test("an ordinary text stays on main", async () => {
  const gw = scripted([tools(1), answer()]);
  const result = await turn(gw.fetchImpl, { question: "what's on tomorrow" });
  assert.deepEqual(gw.asked, [HAIKU, HAIKU]);
  assert.equal(result.timing.trace.some((entry) => entry.kind === "router"), false, "no router step on a text");
});

test("an opinion text stays on main too: it asks the advisor, not a planner", async () => {
  const gw = scripted([answer("Skip it.")]);
  await turn(gw.fetchImpl, { question: "Should we skip the rollback?" });
  assert.deepEqual(gw.asked, [HAIKU]);
});

test("the model line says which model plans jobs", () => {
  assert.match(modelLine(HAIKU, { main: HAIKU, think: OPUS, jobsOnly: true }), new RegExp(`${OPUS} plans those jobs`));
  assert.match(modelLine(HAIKU, { main: HAIKU, think: OPUS }), /harder ones and long jobs go to/);
});
