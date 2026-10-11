/**
 * OTHER PROVIDERS' MODELS, AND THE GATEWAY'S ROUTES.
 *
 * The owner asked (2026-10-08) to try models beyond Claude and Workers AI and
 * to route between them. Cloudflare's catalog serves `openai/…`, `google/…`
 * and friends on the Workers AI binding through an AI gateway, paid by Unified
 * Billing, and a gateway's dynamic routes (`dynamic/<name>`) pick among models
 * by rules set in the dashboard. These checks pin the road:
 *
 *  - only named providers and route names pass, so a production file cannot
 *    point a turn at an arbitrary string;
 *  - a catalog call always names our gateway and never asks it to keep a log;
 *  - without a gateway a catalog model is not runnable, and nothing is called;
 *  - cached prompt tokens are split out so they are priced as cache reads.
 *
 * All ids are invented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BUILTIN_MODEL,
  builtinModel,
  canRunBuiltin,
  isBuiltinModelName,
  isCatalogModel,
  requestBuiltin,
} from "../src/agent/builtin.js";
import { aiGatewayConfig } from "../src/agent/aiGateway.js";
import { parseSetup } from "../src/agent/production.js";

const GATEWAY_ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context",
  AI_GATEWAY_TOKEN: "fixture-gateway-token-0000000000",
};
const AI = { run: async () => ({}) };

function recordingAi(answer) {
  const calls = [];
  return {
    calls,
    async run(...args) {
      calls.push(args);
      return answer;
    },
  };
}

const ANSWER = {
  choices: [{ message: { content: "Thursday at 3." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } },
};
const CALL = { model: "openai/gpt-5-mini", system: "s", messages: [{ role: "user", text: "q" }], tools: [] };

test("catalog models and route names are recognised; anything else is not", () => {
  for (const name of ["openai/gpt-5-mini", "google/gemini-2.5-flash", "xai/grok-4-fast", "dynamic/texts", "dynamic/a-b-test"]) {
    assert.equal(isCatalogModel(name), true, name);
    assert.equal(isBuiltinModelName(name), true, name);
  }
  for (const name of [
    "anthropic/claude-haiku-5-5",
    "openai/",
    "openai/../secrets",
    "openai/gpt 5",
    "evil/model",
    "dynamic/Has_Caps",
    "dynamic/",
    "OPENAI/gpt-5",
    `openai/${"a".repeat(90)}`,
  ]) {
    assert.equal(isCatalogModel(name), false, name);
  }
  assert.equal(isBuiltinModelName("@cf/zai-org/glm-4.7-flash"), true);
  assert.equal(isBuiltinModelName("anthropic/claude-haiku-5-5"), true);
  assert.equal(isBuiltinModelName("evil/model"), false);
});

test("a catalog model needs the binding and the gateway", () => {
  assert.equal(canRunBuiltin("openai/gpt-5-mini", { ...GATEWAY_ENV, AI }), true);
  assert.equal(canRunBuiltin("dynamic/texts", { ...GATEWAY_ENV, AI }), true);
  assert.equal(canRunBuiltin("openai/gpt-5-mini", { AI }), false);
  assert.equal(canRunBuiltin("openai/gpt-5-mini", GATEWAY_ENV), false);
});

test("AGENT_BUILTIN_MODEL may name a catalog model only where there is a gateway and a binding", () => {
  assert.equal(builtinModel({ ...GATEWAY_ENV, AI, AGENT_BUILTIN_MODEL: "dynamic/texts" }), "dynamic/texts");
  assert.equal(builtinModel({ ...GATEWAY_ENV, AGENT_BUILTIN_MODEL: "dynamic/texts" }), "anthropic/claude-haiku-5-5");
  assert.equal(builtinModel({ AGENT_BUILTIN_MODEL: "openai/gpt-5-mini" }), DEFAULT_BUILTIN_MODEL);
});

test("a catalog call names our gateway, keeps no log and carries only id labels", async () => {
  const ai = recordingAi(ANSWER);
  const answer = await requestBuiltin(CALL, ai, {
    gateway: aiGatewayConfig(GATEWAY_ENV),
    metadata: { feature: "assistant", workspace: "ws_123", note: "has spaces in it" },
  });
  assert.equal(ai.calls.length, 1);
  const [model, input, options] = ai.calls[0];
  assert.equal(model, "openai/gpt-5-mini");
  assert.equal(input.messages[0].role, "system");
  assert.deepEqual(options, { gateway: { id: "context", collectLog: false, metadata: { feature: "assistant", workspace: "ws_123" } } });
  assert.equal(answer.text, "Thursday at 3.");
  assert.deepEqual(answer.usage, { input: 200, output: 30, cacheRead: 1000 });
});

test("without a gateway a catalog call is refused before anything is sent", async () => {
  const ai = recordingAi(ANSWER);
  await assert.rejects(() => requestBuiltin(CALL, ai, {}), /gateway not configured/);
  assert.equal(ai.calls.length, 0);
});

test("a Workers AI model is still called with no gateway options", async () => {
  const ai = recordingAi({ ...ANSWER, usage: { prompt_tokens: 50, completion_tokens: 5 } });
  const answer = await requestBuiltin({ ...CALL, model: DEFAULT_BUILTIN_MODEL }, ai, { gateway: aiGatewayConfig(GATEWAY_ENV) });
  assert.equal(ai.calls[0].length, 2);
  assert.deepEqual(answer.usage, { input: 50, output: 5 });
});

test("a production file may name a catalog model or a route, and nothing unknown", async () => {
  const file = (model) => `---\njob: texting-assistant\nmodels:\n  main: ${model}\n---\n\nYou are Context.\n`;
  assert.equal((await parseSetup(file("openai/gpt-5-mini")))?.model, "openai/gpt-5-mini");
  assert.equal((await parseSetup(file("dynamic/texts")))?.model, "dynamic/texts");
  assert.equal(await parseSetup(file("evil/model")), null);
});
