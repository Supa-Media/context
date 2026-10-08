// Tests for bench/models.mjs: where a benchmark's Claude calls go. All keys,
// ids and tokens are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeTransport } from "../models.mjs";

const GATEWAY = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context",
  AI_GATEWAY_TOKEN: "fixture-gateway-token-0000000000",
};
const BODY = JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 10, messages: [] });

function recorder(...answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const [status, body] = answers.shift() ?? [200, { content: [] }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

test("with the gateway's keys, calls go through the real gateway with the credit key", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal(send.route, "gateway");
  const response = await send(BODY);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/context/anthropic/v1/messages");
  assert.equal(calls[0].headers["cf-aig-authorization"], "Bearer fixture-gateway-token-0000000000");
  assert.equal(calls[0].headers["cf-aig-collect-log"], "false");
  assert.equal(calls[0].headers["x-api-key"], "fixture-credit-key-000000000000");
  assert.deepEqual(JSON.parse(calls[0].headers["cf-aig-metadata"]), { feature: "benchmark" });
  assert.equal(calls[0].body, BODY);
});

test("a spent credit is retried without the key, so Unified Billing pays", async () => {
  const { calls, fetchImpl } = recorder([400, { error: { message: "Your credit balance is too low" } }], [200, { content: [] }]);
  const send = claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, fetchImpl);
  assert.equal((await send(BODY)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers["x-api-key"], undefined);
});

test("a refused key is retried without it; any other error is returned as is", async () => {
  const refused = recorder([401, { error: { message: "invalid x-api-key" } }], [200, { content: [] }]);
  await claudeTransport({ ...GATEWAY, ANTHROPIC_API_KEY: "fixture-api-key-0000000000000000" }, refused.fetchImpl)(BODY);
  assert.equal(refused.calls.length, 2);

  const bad = recorder([400, { error: { message: "messages: required" } }]);
  const response = await claudeTransport({ ...GATEWAY, ANTHROPIC_CREDIT_KEY: "fixture-credit-key-000000000000" }, bad.fetchImpl)(BODY);
  assert.equal(response.status, 400);
  assert.equal(bad.calls.length, 1);
});

test("the gateway with no key at all is Unified Billing from the first call", async () => {
  const { calls, fetchImpl } = recorder();
  await claudeTransport(GATEWAY, fetchImpl)(BODY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], undefined);
});

test("without the gateway, an Anthropic key goes straight to Anthropic", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ ANTHROPIC_API_KEY: "fixture-api-key-0000000000000000" }, fetchImpl);
  assert.equal(send.route, "anthropic");
  await send(BODY);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], "fixture-api-key-0000000000000000");
  assert.equal(calls[0].headers["cf-aig-authorization"], undefined);
});

test("a half-set gateway is not a gateway, and with nothing set every call says why", async () => {
  const { calls, fetchImpl } = recorder();
  const send = claudeTransport({ AI_GATEWAY_ACCOUNT_ID: GATEWAY.AI_GATEWAY_ACCOUNT_ID }, fetchImpl);
  assert.equal(send.route, null);
  const response = await send(BODY);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /AI_GATEWAY_ACCOUNT_ID/);
  assert.equal(calls.length, 0);
});
