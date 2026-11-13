/**
 * KEYS THE AI GATEWAY HOLDS, NAMED BY ALIAS (decided by the owner, 2026-11-13).
 *
 * `AI_GATEWAY_KEY_ALIASES` lists keys stored on the gateway's Provider Keys
 * page. A call names each in order with `cf-aig-byok-alias`, then sends the
 * plan key, then goes keyless so Unified Billing pays; a spent payer rests on
 * its own. The rest of the gateway road is checked in agentGateway.test.mjs.
 */

import { aiGatewayConfig, requestViaGateway, resetCreditState } from "../src/agent/aiGateway.js";

const TOKEN = `gw-token-${"a".repeat(20)}`;
const CREDIT = `sk-ant-credit-fixture-${"0".repeat(12)}`;
const QUESTION = "SECRET-QUESTION-MARKER: when is the launch";
const CREDIT_SPENT = { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
const T0 = 1_800_000_000_000;
const CALL = { model: "anthropic/claude-haiku-5-5", system: "You are the fixture.", messages: [{ role: "user", text: QUESTION }], tools: [] };

function env(overrides = {}) {
  return { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "context-gw", AI_GATEWAY_TOKEN: TOKEN, ...overrides };
}

function scripted(replies) {
  const queue = [...replies];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const next = queue.shift();
    if (!next) throw new Error("fixture: the script ran out");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function answer(text) {
  return { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
}

export async function runAgentGatewayAliasChecks(check) {
  const aliased = aiGatewayConfig(env({ AI_GATEWAY_KEY_ALIASES: " first-credits, second_credits ,Bad Alias,first-credits", ANTHROPIC_CREDIT_KEY: CREDIT }));
  check(
    "aliases are read in order, trimmed, deduplicated, and a malformed one is dropped",
    JSON.stringify(aliased?.keyAliases) === JSON.stringify(["first-credits", "second_credits"]) &&
      aiGatewayConfig(env())?.keyAliases.length === 0 &&
      aiGatewayConfig(env({ AI_GATEWAY_KEY_ALIASES: "a,b,c,d,e,f,g" }))?.keyAliases.length === 5,
  );

  resetCreditState();
  const firstAlias = scripted([{ status: 200, body: answer("from the first stored key") }]);
  const fromAlias = await requestViaGateway(CALL, aliased, { fetchImpl: firstAlias.fetchImpl, now: () => T0 });
  check(
    "the first stored key is named by alias, with no x-api-key, and is paid by the credit",
    firstAlias.calls.length === 1 &&
      firstAlias.calls[0].headers["cf-aig-byok-alias"] === "first-credits" &&
      !("x-api-key" in firstAlias.calls[0].headers) &&
      fromAlias.paidBy === "credit",
  );

  resetCreditState();
  const chain = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 402, body: { error: "payment_required" } },
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("from cloudflare") },
    { status: 200, body: answer("still resting") },
  ]);
  const chained = await requestViaGateway(CALL, aliased, { fetchImpl: chain.fetchImpl, now: () => T0 });
  const rested = await requestViaGateway(CALL, aliased, { fetchImpl: chain.fetchImpl, now: () => T0 + 1 });
  check(
    "spent stored keys are tried in order, then the plan key, then Unified Billing; each spent payer rests on its own",
    chain.calls.length === 5 &&
      chain.calls[0].headers["cf-aig-byok-alias"] === "first-credits" &&
      chain.calls[1].headers["cf-aig-byok-alias"] === "second_credits" &&
      chain.calls[2].headers["x-api-key"] === CREDIT && !("cf-aig-byok-alias" in chain.calls[2].headers) &&
      !("x-api-key" in chain.calls[3].headers) && !("cf-aig-byok-alias" in chain.calls[3].headers) &&
      chained.paidBy === "cloudflare" &&
      !("x-api-key" in chain.calls[4].headers) && !("cf-aig-byok-alias" in chain.calls[4].headers) &&
      rested.paidBy === "cloudflare",
  );

  resetCreditState();
  const firstSpent = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("second key") },
    { status: 200, body: answer("second key again") },
  ]);
  await requestViaGateway(CALL, aliased, { fetchImpl: firstSpent.fetchImpl, now: () => T0 });
  await requestViaGateway(CALL, aliased, { fetchImpl: firstSpent.fetchImpl, now: () => T0 + 1 });
  check(
    "once the first stored key is spent, the next call goes straight to the second: one fetch, not two",
    firstSpent.calls.length === 3 && firstSpent.calls[2].headers["cf-aig-byok-alias"] === "second_credits",
  );

  resetCreditState();
  const unknownAlias = scripted([
    { status: 400, body: { error: { message: `no such key quoting ${QUESTION}` } } },
    { status: 200, body: answer("second key") },
  ]);
  const pastUnknown = await requestViaGateway(CALL, aliased, { fetchImpl: unknownAlias.fetchImpl, now: () => T0 });
  check(
    "a stored key refused with a plain 400 (an alias the gateway does not hold) moves to the next payer instead of failing the turn",
    unknownAlias.calls.length === 2 && unknownAlias.calls[1].headers["cf-aig-byok-alias"] === "second_credits" && pastUnknown.paidBy === "credit",
  );

  resetCreditState();
}
