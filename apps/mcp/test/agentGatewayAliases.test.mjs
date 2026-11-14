/**
 * KEYS THE AI GATEWAY HOLDS, NAMED BY ALIAS (decided by the owner, 2026-11-13).
 *
 * `AI_GATEWAY_KEY_ALIASES` lists keys stored on the gateway's Provider Keys
 * page. A call names each in order with `cf-aig-byok-alias`, then sends the
 * plan key, then goes keyless so Unified Billing pays; a spent payer rests on
 * its own, and every attempt names its payer in a `payer` label, which the
 * console's Who paid reads. The rest of the gateway road is checked in
 * agentGateway.test.mjs.
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

/** Same keys and values, in any order. */
function same(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
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

  const plain = aiGatewayConfig(env());

  /* ---------------- who each attempt asks to pay ---------------- */

  const payerOf = (call) => JSON.parse(call.headers["cf-aig-metadata"]).payer;
  const WORKSPACE = { workspace: "ws_texter" };

  resetCreditState();
  const byAlias = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, aiGatewayConfig(env({ AI_GATEWAY_KEY_ALIASES: "dev-claude-credits" })), {
    fetchImpl: byAlias.fetchImpl,
    now: () => T0,
    metadata: WORKSPACE,
  });
  check(
    "an alias attempt's header names the alias as its payer",
    byAlias.calls[0].headers["cf-aig-byok-alias"] === "dev-claude-credits" && payerOf(byAlias.calls[0]) === "dev-claude-credits",
  );

  resetCreditState();
  const byPlan = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, aiGatewayConfig(env({ ANTHROPIC_CREDIT_KEY: CREDIT })), {
    fetchImpl: byPlan.fetchImpl,
    now: () => T0,
    metadata: WORKSPACE,
  });
  check(
    "the plan key's attempt names `plan` as its payer, and the key itself stays out of the label",
    byPlan.calls[0].headers["x-api-key"] === CREDIT && payerOf(byPlan.calls[0]) === "plan" &&
      !JSON.stringify(byPlan.calls[0].headers["cf-aig-metadata"]).includes(CREDIT),
  );

  resetCreditState();
  const keyless = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, plain, { fetchImpl: keyless.fetchImpl, now: () => T0, metadata: WORKSPACE });
  check(
    "the keyless Unified Billing attempt names `cloudflare` as its payer",
    !("x-api-key" in keyless.calls[0].headers) && !("cf-aig-byok-alias" in keyless.calls[0].headers) &&
      payerOf(keyless.calls[0]) === "cloudflare",
  );

  resetCreditState();
  const spentChain = scripted([
    { status: 400, body: CREDIT_SPENT },
    { status: 400, body: CREDIT_SPENT },
    { status: 200, body: answer("ok") },
  ]);
  await requestViaGateway(CALL, aiGatewayConfig(env({ AI_GATEWAY_KEY_ALIASES: "dev-claude-credits", ANTHROPIC_CREDIT_KEY: CREDIT })), {
    fetchImpl: spentChain.fetchImpl,
    now: () => T0,
    metadata: WORKSPACE,
  });
  check(
    "each attempt in a spent-credit chain carries its own payer: alias, then plan, then cloudflare",
    spentChain.calls.map(payerOf).join(",") === "dev-claude-credits,plan,cloudflare",
  );

  resetCreditState();
  const spoofed = scripted([{ status: 200, body: answer("ok") }]);
  await requestViaGateway(CALL, plain, {
    fetchImpl: spoofed.fetchImpl,
    now: () => T0,
    metadata: {
      payer: "someone-else",
      alpha: "1",
      beta: "2",
      gamma: "3",
      delta: "4",
      epsilon: "5",
      zeta: "6",
    },
  });
  const spoofedLabels = JSON.parse(spoofed.calls[0].headers["cf-aig-metadata"]);
  check(
    "a caller's own `payer` label is ignored, and five caller labels still leave exactly five with ours as payer",
    Object.keys(spoofedLabels).length === 5 && same(spoofedLabels, { alpha: "1", beta: "2", gamma: "3", delta: "4", payer: "cloudflare" }),
  );

  resetCreditState();
}
