// Tests for bench/models.mjs: where a benchmark's Claude calls go. All keys,
// ids and tokens are invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicGateway, cachedEmbeddings, claudeTransport, refusalLine, workersAi } from "../models.mjs";
import { MEANING_MODEL } from "../../src/search/meaning/embed.js";

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

test("a catalog model goes through Cloudflare's chat API on the runner's own gateway", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  const ai = workersAi(GATEWAY.AI_GATEWAY_ACCOUNT_ID, "fixture-workers-ai-token", "context", fetchImpl);
  await ai.run("openai/gpt-5-mini", { messages: [] }, { gateway: { id: "bench", collectLog: false } });
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions");
  assert.equal(calls[0].headers["cf-aig-gateway-id"], "context");
  assert.equal(calls[0].body.model, "openai/gpt-5-mini");

  await ai.run("@cf/zai-org/glm-4.7-flash", { messages: [] }).catch(() => {});
  assert.equal(calls[1].url.endsWith("/ai/run/@cf/zai-org/glm-4.7-flash"), true);
  assert.equal(calls[1].headers["cf-aig-gateway-id"], undefined);

  await assert.rejects(() => workersAi(GATEWAY.AI_GATEWAY_ACCOUNT_ID, "t", null, fetchImpl).run("dynamic/texts", {}, { gateway: {} }), /AI_GATEWAY_ID/);
});

test("a failed embedding call is tried again after a wait, and the last failure is logged before it is thrown", async () => {
  const waited = [];
  const logged = [];
  let calls = 0;
  const flaky = {
    async run(_model, input) {
      calls += 1;
      if (calls < 3) throw new Error("workers ai status 503");
      return { data: input.text.map(() => [1]) };
    },
  };
  const ai = cachedEmbeddings(flaky, { sleep: async (ms) => waited.push(ms), log: (line) => logged.push(line) });
  const answer = await ai.run(MEANING_MODEL, { text: ["a", "b"] });
  assert.equal(answer.data.length, 2);
  assert.equal(calls, 3);
  assert.deepEqual(waited, [1_000, 4_000]);
  assert.deepEqual(logged, []);

  const down = cachedEmbeddings({ run: async () => { throw new Error("workers ai status 429"); } }, { sleep: async () => {}, log: (line) => logged.push(line) });
  await assert.rejects(() => down.run(MEANING_MODEL, { text: ["c"] }), /status 429/);
  assert.deepEqual(logged, ["embedding failed after 3 tries: workers ai status 429"]);
});

test("a setup's own model call is never retried by the embedding cache", async () => {
  let calls = 0;
  const ai = cachedEmbeddings({ run: async () => { calls += 1; throw new Error("workers ai status 503"); } }, { sleep: async () => {}, log: () => {} });
  await assert.rejects(() => ai.run("@cf/zai-org/glm-4.7-flash", { messages: [] }), /503/);
  assert.equal(calls, 1);
});

test("a refused Claude call is logged with the provider's words, and the response still reaches the gateway", async () => {
  const logged = [];
  const refusal = { type: "error", error: { type: "invalid_request_error", message: "messages.4.content.1:\n  bad image" } };
  const fetchImpl = anthropicGateway(async () => new Response(JSON.stringify(refusal), { status: 400, headers: { "content-type": "application/json" } }), (line) => logged.push(line));
  const response = await fetchImpl("https://gateway.example/v1/messages", { body: BODY });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "invalid_request_error", "the body is still readable by the gateway");
  assert.deepEqual(logged, ["Claude refused a call: 400 invalid_request_error: messages.4.content.1: bad image"]);

  const fine = anthropicGateway(async () => new Response("{}", { status: 200 }), (line) => logged.push(line));
  await fine("https://gateway.example/v1/messages", { body: BODY });
  assert.equal(logged.length, 1, "an answered call is not logged");
});

test("a refusal's words are read from the gateway's own shape too, and an empty body says so", () => {
  assert.equal(refusalLine(400, "application/json", '{"success":false,"errors":[{"code":2003,"message":"Insufficient   balance"}]}'), "Claude refused a call: 400 2003: Insufficient balance");
  assert.equal(refusalLine(400, "text/html", "<html>busy</html>"), "Claude refused a call: 400 <html>busy</html>");
  assert.equal(refusalLine(400, "application/json", ""), "Claude refused a call: 400 empty body (application/json)");
  assert.equal(refusalLine(400, null, null), "Claude refused a call: 400 no body read (no content-type)");
  assert.equal(refusalLine(400, null, JSON.stringify({ error: { message: "x".repeat(500) } })).length, "Claude refused a call: 400 ".length + 300);
});
