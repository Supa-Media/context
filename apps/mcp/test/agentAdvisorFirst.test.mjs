/**
 * ADVISOR FIRST (`advisorFirst.js`, Dev2, 2026-11-06).
 *
 * With `advisor_first: on` a texted turn starts and stays on `main` even when
 * the router picks `think`; a background job still plans on `think`. With
 * `effort_rung` as well, a flagged text, and a text sent back by a check,
 * carry Anthropic's per-message effort (an effort-only system message after
 * the newest text, with its beta header), never a top-level effort change,
 * and the cached prefix is the same bytes as without it. A gateway that
 * refuses the rung gets the body again without it, once.
 *
 * Driven through `runTurn` and `requestViaGateway` with a scripted gateway.
 *
 * ## Sabotage record
 *
 *   `routedTurn` returning `router.think` when advising
 *     → "the rung rides after the question and leaves the cached prefix as it was" fails
 *   `turn.js` not raising the rung after a send-back
 *     → "a text sent back by a check is raised once, after the send-back" fails
 *   `markLastBlock` not walking back past the rung
 *     → "the rung rides after the question and leaves the cached prefix as it was" fails
 *   `requestViaGateway` not resending without the rung
 *     → "a gateway that refuses the rung is sent the body again without it, and remembers" fails
 *   `parseSetup` dropping the advisor-first-needs-an-advisor refusal
 *     → "advisor_first and effort_rung parse, default off, and refuse what makes no sense" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, gatewayBody, requestViaGateway, resetCreditState, resetHourMarks, RUNG_BETA } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { turnRouter } from "../src/agent/modelPlan.js";
import { dropRungs } from "../src/agent/advisorFirst.js";
import { parseSetup } from "../src/agent/production.js";
import { ROUTER_MODEL } from "../src/agent/router.js";
import { runTurn } from "../src/agent/turn.js";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";

const reply = (blocks, stop) => ({ id: "msg", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
const answer = (text = "Done.") => ({ blocks: [{ type: "text", text }], stop: "end_turn" });
const call = (n) => ({ blocks: [{ type: "tool_use", id: `t${n}`, name: "read_note", input: { path: `${n}.md` } }], stop: "tool_use" });

function scripted(rounds, refuseRung = false) {
  const queue = [...rounds];
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ body, headers: init.headers });
    const rung = body.messages.some((message) => message.role === "system");
    if (refuseRung && rung) return new Response(JSON.stringify({ error: { message: "messages.2.output_config: Extra inputs are not permitted" } }), { status: 400 });
    const next = queue.shift();
    if (!next) throw new Error("the script ran out");
    return new Response(JSON.stringify(reply(next.blocks, next.stop)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetchImpl };
}

const router = (extra = {}) => ({ decide: async () => ({ tier: { choice: "think", confidence: 0.9 } }), think: OPUS, ...extra });
const history = [{ role: "user", text: "hi" }, { role: "assistant", text: "Hey." }];

async function turn(fetchImpl, extra = {}) {
  resetCreditState();
  resetHourMarks();
  return await runTurn({
    question: "should I pay the flat now or later",
    tools: [{ name: "read_note", description: "read_note.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    history,
    texting: true,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    ...extra,
  });
}

const rungs = (body) => body.messages.filter((message) => message.role === "system");

test("advisor first: a text the router sends to think stays on Haiku, and no rung without effort_rung", async () => {
  const gw = scripted([call(1), answer()]);
  let asked = 0;
  const result = await turn(gw.fetchImpl, { router: router({ advisorFirst: true, decide: async () => { asked += 1; return { tier: { choice: "think", confidence: 0.9 } }; } }) });
  assert.deepEqual(gw.sent.map(({ body }) => body.model), ["claude-haiku-5-5", "claude-haiku-5-5"]);
  assert.equal(result.model, HAIKU);
  assert.equal(asked, 0, "the router is never called for a text without a rung to flag");
  assert.ok(gw.sent.every(({ body, headers }) => rungs(body).length === 0 && headers["anthropic-beta"] === undefined));
});

test("without advisor first, the same router still sends the text to Opus (unchanged)", async () => {
  const gw = scripted([answer()]);
  await turn(gw.fetchImpl, { router: router() });
  assert.equal(gw.sent[0].body.model, "claude-opus-5-5");
});

test("the rung rides after the question and leaves the cached prefix as it was", async () => {
  const plain = scripted([answer()]);
  await turn(plain.fetchImpl, { router: router({ advisorFirst: true, decide: async () => ({ tier: { choice: "main", confidence: 0.9 } }), rung: "high" }) });
  const gw = scripted([call(1), answer()]);
  const result = await turn(gw.fetchImpl, { router: router({ advisorFirst: true, rung: "high" }), efforts: { [HAIKU]: "medium" } });
  const [first, second] = gw.sent;
  assert.equal(first.body.model, "claude-haiku-5-5");
  assert.equal(first.body.output_config.effort, "medium", "the top-level effort never changes");
  assert.deepEqual(first.body.messages.at(-1), { role: "system", content: [], output_config: { effort: "high" } });
  assert.equal(first.body.messages.at(-2).role, "user", "directly after the person's text");
  assert.equal(first.headers["anthropic-beta"], RUNG_BETA);
  assert.ok(first.body.messages.at(-2).content.at(-1).cache_control, "the round's end mark walks back past the rung");
  assert.deepEqual(first.body.messages.slice(0, 2), plain.sent[0].body.messages.slice(0, 2), "the history (the cached stretch) is the same bytes");
  assert.equal(rungs(second.body).length, 1, "it holds for the turn's later rounds");
  assert.ok(result.timing.trace.filter((entry) => entry.kind === "model").every((entry) => entry.rung === "high"), "each round's trace says it ran at the rung");
});

test("a text sent back by a check is raised once, after the send-back", async () => {
  const gw = scripted([answer("Draft."), answer("Better."), answer("Best.")]);
  let checks = 0;
  const answerCheck = async () => (++checks <= 2 ? "Answer it properly." : null);
  const result = await turn(gw.fetchImpl, { router: router({ advisorFirst: true, decide: async () => ({ tier: { choice: "main", confidence: 0.9 } }), rung: "high" }), answerCheck, question: "what is on my list" });
  assert.equal(result.answer, "Best.");
  assert.equal(rungs(gw.sent[0].body).length, 0, "not flagged, so the first draft runs as set");
  assert.equal(rungs(gw.sent[1].body).length, 1);
  assert.equal(gw.sent[1].body.messages.at(-1).role, "system", "after the send-back's text");
  assert.equal(rungs(gw.sent[2].body).length, 1, "raised once, never stacked");
});

test("a pushback ask (asking for Tex's judgment) is flagged with no router call", async () => {
  const gw = scripted([answer()]);
  await turn(gw.fetchImpl, { router: { decide: null, think: null, jobsOnly: true, advisorFirst: true, rung: "high" } });
  assert.equal(rungs(gw.sent[0].body).length, 1, "the opinion ask runs at the rung");
});

test("a model without per-message effort never gets a rung", async () => {
  const gw = scripted([answer()]);
  await turn(gw.fetchImpl, { router: router({ advisorFirst: true, rung: "high" }), builtinModelOverride: "anthropic/claude-haiku-4-5" });
  assert.equal(rungs(gw.sent[0].body).length, 0, "a model without per-message effort runs as set");
});

test("a gateway that refuses the rung is sent the body again without it, and remembers", async () => {
  resetHourMarks();
  resetCreditState();
  const cfg = aiGatewayConfig(ENV);
  const call = { model: HAIKU, system: "s", messages: [{ role: "user", text: "q" }, { role: "effort", effort: "high" }], tools: [] };
  const gw = scripted([answer("ok"), answer("ok")], true);
  const first = await requestViaGateway(call, cfg, { fetchImpl: gw.fetchImpl });
  assert.equal(first.text, "ok");
  assert.deepEqual(gw.sent.map(({ body }) => rungs(body).length), [1, 0]);
  await requestViaGateway(call, cfg, { fetchImpl: gw.fetchImpl });
  assert.equal(rungs(gw.sent.at(-1).body).length, 0, "later bodies go without it");
  assert.equal(gw.sent.length, 3);
  resetHourMarks();
});

test("gatewayBody writes the rung as an effort-only system message", () => {
  const body = gatewayBody({ model: HAIKU, system: "s", messages: [{ role: "user", text: "q" }, { role: "effort", effort: "xhigh" }], tools: [] });
  assert.deepEqual(body.messages[1], { role: "system", content: [], output_config: { effort: "xhigh" } });
});

const file = (front) => `---\nmodels:\n  main: ${HAIKU}\n  router: ${ROUTER_MODEL}\n  think: ${OPUS}\n  advisor: ${OPUS}\n${front}---\nYou are Tex.\n`;

test("advisor_first and effort_rung parse, default off, and refuse what makes no sense", async () => {
  const off = await parseSetup(file(""));
  assert.equal(off.advisorFirst, false);
  assert.equal(off.effortRung, null);
  const on = await parseSetup(file("advisor_first: on\neffort_rung: high\n"));
  assert.equal(on.advisorFirst, true);
  assert.equal(on.effortRung, "high");
  assert.equal(await parseSetup(file("effort_rung: high\n")), null, "a rung needs advisor first");
  assert.equal(await parseSetup(file("advisor_first: on\neffort_rung: huge\n")), null, "a rung is an effort word");
  assert.equal(await parseSetup(file("advisor_first: maybe\n")), null);
  assert.equal(await parseSetup(`---\nmodels:\n  main: ${HAIKU}\nadvisor_first: on\n---\nYou are Tex.\n`), null, "advisor first needs an advisor");
});

test("turnRouter carries the flags, and advisor first with no router still offers the rung", () => {
  const can = () => true;
  const routed = turnRouter({ router: { think: OPUS, routeAt: 0.5 }, advisorFirst: true, effortRung: "high" }, can, () => async () => null);
  assert.equal(routed.advisorFirst, true);
  assert.equal(routed.rung, "high");
  const bare = turnRouter({ router: null, advisorFirst: true, effortRung: "high" }, can, () => null);
  assert.deepEqual(bare, { decide: null, think: null, jobsOnly: true, advisorFirst: true, rung: "high" });
  assert.equal(turnRouter({ router: null }, can, () => null), null, "off: as before");
});

test("a switch of model (the fallback) drops the rung", () => {
  const messages = [{ role: "user", text: "q" }, { role: "effort", effort: "high" }, { role: "user", text: "Answer it properly." }];
  dropRungs(messages);
  assert.deepEqual(messages.map((message) => message.role), ["user", "user"]);
});
